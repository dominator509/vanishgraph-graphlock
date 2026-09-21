#!/usr/bin/env sh
# S3_ENDPOINT readiness probe (the object store). Sentinel: `<NAME>: ok - <detail>`; contract in scripts/lib/loud-fail.sh.
#
# SPEC BASIS AND THE DECLARED ACTION. PREFLIGHT.md declares this probe for S3_ENDPOINT and SPEC-007 section 7.2 declares
# what the object-store dependency must do: "HeadBucket plus a signed GetObject of a probe key that must return the
# expected digest". This probe performs exactly that, with ONE addition and for a measured reason: when the probe key
# does not exist yet it WRITES the probe payload first, because §7.2 verifies the CONTENT of a probe object and the
# first readiness check of a fresh environment would otherwise fail for a missing fixture. The write is namespaced to
# the probe key, so nothing else in the bucket is touched.
#
# IT SIGNS ITS OWN REQUESTS WITH SigV4 rather than using an SDK, so the credential is exercised through the same
# algorithm the service uses; `aws`, `mc` and `s3cmd` are not installed here and would test a different client.
#
# THE DIGEST IS THE POINT AND NOT THE STATUS CODE: an object store that answers 200 with substituted or stale content is
# not a working dependency, so the probe hashes what it read and compares it with the payload it wrote.
#
# IT NEVER PRINTS THE ENDPOINT'S CREDENTIALS, THE ACCESS KEY OR THE SECRET. Only a short outcome word crosses back out.
set -eu
. "$(dirname "$0")/../lib/loud-fail.sh"
vg_require_env 'S3_ENDPOINT' 'EP-003'
vg_require_env 'S3_BUCKET' 'EP-003'
vg_require_env 'S3_ACCESS_KEY_ID' 'EP-003'
vg_require_env 'S3_SECRET_ACCESS_KEY' 'EP-003'

RESULT=$(node -e '
(async () => {
  const { createHash, createHmac } = await import("node:crypto");
  const endpoint = String(process.env.S3_ENDPOINT ?? "").replace(/\/$/, "");
  const bucket = String(process.env.S3_BUCKET ?? "");
  // The region is not a credential and this repository declares its local default once (config/environment/schema.json
  // S3_REGION, which scripts/induced-failure-readiness.sh repeats as VG_OBJECT_STORE_REGION ?? "us-east-1").
  const region = String(process.env.S3_REGION ?? "us-east-1");
  const accessKeyId = String(process.env.S3_ACCESS_KEY_ID ?? "");
  const secretAccessKey = String(process.env.S3_SECRET_ACCESS_KEY ?? "");
  const key = "readiness/probe-object";
  const payload = "vanishgraph object-store probe payload";
  const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
  const signingKey = (secret, dateStamp, regionName) => {
    const kDate = createHmac("sha256", "AWS4" + secret).update(dateStamp).digest();
    const kRegion = createHmac("sha256", kDate).update(regionName).digest();
    const kService = createHmac("sha256", kRegion).update("s3").digest();
    // THE FOURTH DERIVATION IS NOT OPTIONAL, AND OMITTING IT IS A MEASURED DEFECT OF THIS PROBE RATHER THAN A THEORY.
    // The first version of this script stopped at the service key and signed with it; MinIO then refused EVERY request
    // with HTTP 403 while the credential was CORRECT, which reads exactly like a refused credential and was not one.
    // src/adapters/observability/dependency-probes.ts `signingKey` performs all four derivations, and this now matches
    // it step for step. MEASURED: with the fourth step added, the correct credential PASSES and a wrong secret still
    // fails with 403, which is what makes this probe discriminating rather than merely unhappy.
    return createHmac("sha256", kService).update("aws4_request").digest();
  };
  const sign = (method, canonicalPath, body) => {
    const at = new Date();
    const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const host = new URL(endpoint).host;
    const payloadHash = sha256Hex(body ?? "");
    const canonicalHeaders = "host:" + host + "\nx-amz-content-sha256:" + payloadHash + "\nx-amz-date:" + amzDate + "\n";
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [method, canonicalPath, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = dateStamp + "/" + region + "/s3/aws4_request";
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signature = createHmac("sha256", signingKey(secretAccessKey, dateStamp, region)).update(stringToSign).digest("hex");
    return {
      url: endpoint + canonicalPath,
      method,
      headers: {
        host,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        authorization: "AWS4-HMAC-SHA256 Credential=" + accessKeyId + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
      },
    };
  };
  try {
    const head = sign("HEAD", "/" + bucket);
    const headResponse = await fetch(head.url, { method: head.method, headers: head.headers, signal: AbortSignal.timeout(5000) });
    if (!headResponse.ok) {
      process.stdout.write(headResponse.status === 401 || headResponse.status === 403 ? "HEAD_REFUSED_" + String(headResponse.status) : "HEAD_HTTP_" + String(headResponse.status));
      return;
    }
    const objectPath = "/" + bucket + "/" + key;
    const expected = sha256Hex(payload);
    const get = sign("GET", objectPath);
    let getResponse = await fetch(get.url, { method: get.method, headers: get.headers, signal: AbortSignal.timeout(5000) });
    if (getResponse.status === 404) {
      // THE FIXTURE IS WRITTEN THROUGH THE SAME SIGNER THE READ USES, so the fixture cannot drift from the code that
      // verifies it. A failed write is reported as such rather than as a dependency failure.
      const put = sign("PUT", objectPath, payload);
      const putResponse = await fetch(put.url, { method: put.method, headers: { ...put.headers, "content-length": String(Buffer.byteLength(payload)) }, body: payload, signal: AbortSignal.timeout(5000) });
      if (!putResponse.ok) { process.stdout.write("PUT_HTTP_" + String(putResponse.status)); return; }
      const reread = sign("GET", objectPath);
      getResponse = await fetch(reread.url, { method: reread.method, headers: reread.headers, signal: AbortSignal.timeout(5000) });
    }
    if (!getResponse.ok) { process.stdout.write("GET_REFUSED_" + String(getResponse.status)); return; }
    const body = Buffer.from(await getResponse.arrayBuffer());
    const digest = sha256Hex(body);
    process.stdout.write(digest === expected ? "OK" : "DIGEST_MISMATCH");
  } catch (error) {
    process.stdout.write(String(error && error.code ? error.code : (error && error.name === "TimeoutError" ? "ETIMEDOUT" : "UNREACHABLE")));
  }
})();
' 2>/dev/null || printf 'UNREACHABLE')

case "$RESULT" in
  OK)
    vg_probe_ok 'S3_ENDPOINT' "HeadBucket answered and a signed GetObject of ${S3_BUCKET:-the declared bucket}/readiness/probe-object returned content matching the written payload's digest"
    ;;
  DIGEST_MISMATCH)
    echo "ERROR: the signed GetObject returned content whose digest is not the digest of the probe payload; an object store serving substituted or stale content is not a working dependency" >&2
    exit 1
    ;;
  HEAD_REFUSED_401|HEAD_REFUSED_403|GET_REFUSED_401|GET_REFUSED_403)
    echo "ERROR: the object store answered ${RESULT}: it is REACHABLE and the declared credential is not accepted for this bucket" >&2
    exit 1
    ;;
  HEAD_HTTP_404|HEAD_HTTP_400)
    echo "ERROR: HeadBucket answered ${RESULT}: the declared bucket does not exist on this endpoint" >&2
    exit 1
    ;;
  PUT_HTTP_*)
    echo "ERROR: the probe object could not be written (${RESULT}); the declared credential cannot write to this bucket, so the object-store dependency is not usable for its purpose" >&2
    exit 1
    ;;
  *)
    case "$RESULT" in
      ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|UND_ERR_CONNECT_TIMEOUT|UNREACHABLE)
        vg_probe_cannot 'S3_ENDPOINT' "the declared object store is not reachable from this environment (${RESULT}), so the credential could not be tested; an unreachable service is not a refused credential"
        ;;
      *)
        echo "ERROR: the object-store probe failed with ${RESULT}, which is neither acceptance nor a declared unreachability" >&2
        exit 1
        ;;
    esac
    ;;
esac
