#!/usr/bin/env sh
# External gate status: THE single implementation of the sign-off rules. Sentinel: `external gates status: N/M signed`
#
# WHY THIS FILE EXISTS (EP-010 M12, defect A3). The rules for reading the five mandatory external gates of SPEC-008
# section 9 were implemented TWICE - inline in scripts/production-readiness-check.sh and again inside the facts of
# scripts/dod-gate.sh - and BOTH were wrong in the same way: the ship gate rebuilt every gate with
# `status: "EXTERNAL_REQUIRED"` hardcoded, discarding the record's own status, and the DOD gate hardcoded
# `external_gates_signed: 0`. Between them, a sign-off produced by a named human could not move the verdict, and
# DOD-039 would have FAILED the clause the moment one existed. Duplication is how that survived, so the rules now
# live here once, and both consumers READ this script's output:
#
#   .agent/verification/state/EXTERNAL_GATES_STATUS.json
#
# WHAT A SIGN-OFF MUST SATISFY (DOD-039's required evidence is "Named authorized sign-off, scope, date,
# scenarios/evidence, and unresolved findings"):
#   * the record exists in .agent/evidence/EP-010/V-021/signoffs.jsonl, a file NO SCRIPT IN THIS REPOSITORY WRITES,
#     so a record can only arrive because a human put it there (checked: 0 non-read references under scripts/);
#   * status is SIGNED; the role matches the requested role exactly;
#   * signedArtifactDigest equals the PINNED artifact digest - a signature over a superseded artifact attests
#     bytes that no longer exist and is refused by name, printing both digests;
#   * signerRef, signatureMethod, signedAt, scope and unresolvedFindings are all non-blank;
#   * evidencePath names a file that EXISTS and evidenceDigest is the sha256 of its bytes. This is the
#     VG-EVIDENCE-002 discipline ("every claim resolves to a stored artifact hash") applied to sign-offs, and it is
#     what a fabricated record finds hardest to fake: it must also fabricate an artifact, which is a deliberate act
#     rather than an accident. WHAT THIS CANNOT DO, STATED PLAINLY: no check can prove a signature is authentic.
#     These rules verify SHAPE, not authorship.
set -eu
cd "$(dirname "$0")/.."

REQUESTS=.agent/evidence/EP-010/V-021/external-gates.jsonl
SIGNOFFS=.agent/evidence/EP-010/V-021/signoffs.jsonl
IDENTITY=.agent/verification/state/ARTIFACT_IDENTITY.json
RUN_STATE=.agent/verification/state/RUN_STATE.json
OUT=.agent/verification/state/EXTERNAL_GATES_STATUS.json

[ -f "$REQUESTS" ] || { echo "external gates status: FAIL - $REQUESTS is missing" >&2; exit 1; }
[ -f "$IDENTITY" ] || { echo "external gates status: FAIL - $IDENTITY is missing" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
REQUESTS="$REQUESTS" SIGNOFFS="$SIGNOFFS" IDENTITY="$IDENTITY" RUN_STATE="$RUN_STATE" OUT="$OUT" node <<'ENDS_EXTERNAL'
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
const lines = (file) => readText(file).split("\n").filter((line) => line.trim() !== "");

const REQUESTS = process.env.REQUESTS;
const SIGNOFFS = process.env.SIGNOFFS;
const identity = readJson(process.env.IDENTITY) ?? { artifact_paths: [], artifact_digests: {} };
const runState = readJson(process.env.RUN_STATE) ?? {};
const tarball = (identity.artifact_paths ?? []).find((entry) => entry.endsWith(".tgz"));
const artifactDigest = tarball === undefined ? null : identity.artifact_digests[tarball];

const requests = lines(REQUESTS).map((line) => JSON.parse(line));
const records = lines(SIGNOFFS).map((line) => { try { return JSON.parse(line); } catch { return { gate: "(unparseable record)" }; } });
const blockers = [];

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const gateKey = (entry) => String(entry.gate_id ?? entry.gate);

const gates = requests.map((request) => {
  const entry = {
    gate_id: request.gate_id,
    gate: request.gate,
    status: "EXTERNAL_REQUIRED",
    externalPartyRole: request.externalPartyRole,
    requestedArtifactDigest: request.requestedArtifactDigest,
    supersededRequestedArtifactDigest: request.supersededRequestedArtifactDigest,
    requestEvidencePath: request.requestEvidencePath,
    requestedAt: request.requestedAt,
    ownerContactRef: request.ownerContactRef,
  };
  const declared = String(request.status ?? "EXTERNAL_REQUIRED");
  // A STALE REQUEST IS A TRAP FOR A REAL HUMAN, SO IT IS A BLOCKER RATHER THAN A NOTE (EP-010 M14). The requests were
  // re-issued against a digest that a later rebuild superseded, and nothing said so: a participant would have signed
  // an artifact that no longer exists and the sign-off validator would have refused the signature by name - costing
  // that person an attempt and the run a cycle. If the request does not name the pinned digest, the gate says so.
  if (request.requestedArtifactDigest !== artifactDigest) {
    blockers.push({
      id: `EXTERNAL-GATE-REQUEST-STALE-${gateKey(request)}`,
      what: `gate ${JSON.stringify(request.gate)} asks its participant to sign ${request.requestedArtifactDigest} while the pinned artifact is ${artifactDigest}, so a signature over this request would attest bytes that do not exist`,
      evidence: REQUESTS,
      next_action: "re-issue the request against the pinned digest before asking the participant to sign; a stale request wastes a real person's attempt",
    });
  }
  if (declared === "WITHDRAWN") return { ...entry, status: "WITHDRAWN" };
  const record = records.find((candidate) => gateKey(candidate) === gateKey(request));
  if (record === undefined) {
    if (declared === "SIGNED") {
      blockers.push({ id: `EXTERNAL-GATE-SIGNED-WITHOUT-RECORD-${gateKey(request)}`, what: `gate ${JSON.stringify(request.gate)} is marked SIGNED in the request file and no sign-off record exists in ${SIGNOFFS}`, evidence: SIGNOFFS, next_action: "record the participant's sign-off, or return the gate to EXTERNAL_REQUIRED" });
    }
    return entry;
  }
  const problems = [];
  if (String(record.status) !== "SIGNED") problems.push(`the record carries status ${JSON.stringify(record.status ?? "(none)")}`);
  if (artifactDigest === null) problems.push("the pinned artifact digest cannot be resolved, so no sign-off can be verified against it");
  else if (record.signedArtifactDigest !== artifactDigest) problems.push(`the sign-off covers ${record.signedArtifactDigest ?? "(no digest)"} while the pinned artifact is ${artifactDigest}`);
  if (record.externalPartyRole !== request.externalPartyRole) problems.push(`the sign-off names role ${JSON.stringify(record.externalPartyRole)} while the request names ${JSON.stringify(request.externalPartyRole)}`);
  for (const field of ["signerRef", "signatureMethod", "signedAt", "scope", "unresolvedFindings"]) {
    if (typeof record[field] !== "string" || record[field].trim() === "") problems.push(`the sign-off records no ${field}`);
  }
  const evidencePath = String(record.evidencePath ?? "").trim();
  if (evidencePath === "") problems.push("the sign-off names no evidencePath, so the claim resolves to no stored artifact (VG-EVIDENCE-002)");
  else if (!fs.existsSync(path.resolve(evidencePath))) problems.push(`the sign-off's evidencePath ${JSON.stringify(evidencePath)} does not exist`);
  else {
    const expected = String(record.evidenceDigest ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) problems.push("the sign-off records no evidenceDigest (64 hexadecimal characters), so its stored artifact is unhashed");
    else {
      const actual = sha256(evidencePath);
      if (actual !== expected) problems.push(`the sign-off's evidenceDigest does not match the bytes of ${JSON.stringify(evidencePath)} (recorded ${expected.slice(0, 16)}..., actual ${actual.slice(0, 16)}...)`);
    }
  }
  if (problems.length > 0) {
    blockers.push({ id: `EXTERNAL-GATE-SIGNOFF-INVALID-${gateKey(request)}`, what: `gate ${JSON.stringify(request.gate)} has a sign-off record that does not hold: ${problems.join("; ")}`, evidence: SIGNOFFS, next_action: "re-issue the request against the pinned digest and obtain a sign-off that names its signer, method, date, scope, unresolved findings, the digest signed and a stored hashed artifact" });
    return entry;
  }
  return {
    ...entry,
    status: "SIGNED",
    signedAt: record.signedAt,
    signerRef: record.signerRef,
    signatureMethod: record.signatureMethod,
    signedArtifactDigest: record.signedArtifactDigest,
    signatureEvidencePath: evidencePath,
    signatureEvidenceDigest: String(record.evidenceDigest).toLowerCase(),
    scope: record.scope,
    unresolvedFindings: record.unresolvedFindings,
  };
});

const requestedGateKeys = new Set(requests.map(gateKey));
for (const record of records) {
  if (!requestedGateKeys.has(gateKey(record))) {
    blockers.push({ id: "EXTERNAL-GATE-SIGNOFF-UNKNOWN-GATE", what: `a sign-off record names ${JSON.stringify(record.gate ?? record.gate_id)}, which is not one of the mandatory gates of SPEC-008 section 9`, evidence: SIGNOFFS, next_action: "remove the record, or add the gate to the request file with its participant role and prepared request" });
  }
}

const signed = gates.filter((gate) => gate.status === "SIGNED").length;
const document = {
  epoch: runState.epoch,
  candidate_sha: runState.candidate_sha,
  artifact_digest: artifactDigest,
  produced_by: "sh scripts/external-gates-status.sh",
  signoff_store: SIGNOFFS,
  gates,
  gates_total: gates.length,
  gates_signed: signed,
  gates_external_required: gates.filter((gate) => gate.status === "EXTERNAL_REQUIRED").length,
  gates_marked_signed: requests.filter((request) => String(request.status) === "SIGNED").length,
  blockers,
};
fs.writeFileSync(process.env.OUT, `${JSON.stringify(document, null, 2)}\n`);

console.log(`external gates status: ${signed}/${gates.length} signed`);
for (const gate of gates) console.log(`external gates status:   ${gate.status.padEnd(18)} ${gate.gate_id ?? ""}  ${gate.gate}`);
for (const blocker of blockers) console.log(`external gates status:   REFUSED ${blocker.id}: ${blocker.what}`);
if (blockers.length > 0) process.exitCode = 0;
ENDS_EXTERNAL
