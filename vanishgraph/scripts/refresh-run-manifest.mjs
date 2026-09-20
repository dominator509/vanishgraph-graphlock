// Refresh the artifact-bearing parts of RUN_MANIFEST.json from the published identity (EP-009 M7(c)).
//
// WHAT IT MUST NOT DO: change registry_count (484), dod_count (42) or candidate_epoch (GENERATION). Those are the
// pack's own accounting and a node may not rewrite them.
//
// WHY IT IS REFRESHED RATHER THAN TYPED BY HAND: two of the nine telemetry resource attributes
// (vanishgraph.artifact.digest, vanishgraph.build.inputs_digest) and the manifest's own notes said "no artifact
// exists, scripts/artifact-identity.sh is a loud-fail placeholder". That was TRUE at EP-007 and is FALSE now, and
// a stale claim in a state file is exactly what the standing instruction forbids. The values come from
// ARTIFACT_IDENTITY.json -- the same document every gate resolves its digests from -- so the manifest cannot
// disagree with the artifact it describes.
import { readFileSync, writeFileSync } from 'node:fs';

const MANIFEST = '.agent/verification/state/RUN_MANIFEST.json';
const IDENTITY = '.agent/verification/state/ARTIFACT_IDENTITY.json';

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const identity = JSON.parse(readFileSync(IDENTITY, 'utf8'));
const protectedBefore = {
  registry_count: manifest.registry_count,
  dod_count: manifest.dod_count,
  candidate_epoch: manifest.candidate_epoch,
};

const tarball = identity.artifact_paths.find((path) => path.endsWith('.tgz'));
if (tarball === undefined) throw new Error('the identity declares no tarball');
const tarballDigest = identity.artifact_digests[tarball];
const lockfileDigest = identity.lockfile_digests['package-lock.json'];

manifest.test_overlay_note =
  'the git tree hash of vanishgraph/tests at the EP-007 close candidate; the test overlay that node touched. ' +
  'It is a REVISION identifier, not an artifact digest: the artifact identity is written by EP-009 and its ' +
  'current values are in the artifact section below and in .agent/verification/state/ARTIFACT_IDENTITY.json.';

manifest.artifact = {
  recorded_at_round: 'EP-009 M7',
  identity_document: IDENTITY,
  source_commit_sha: identity.source_commit_sha,
  builder_identity: identity.builder_identity,
  build_command: identity.build_command,
  tarball,
  tarball_digest: tarballDigest,
  formats: identity.artifact_paths,
  reproducibility: identity.reproducibility?.verdict ?? 'NOT RECORDED',
  signature: identity.signature?.status ?? 'NOT RECORDED',
  oci_image: identity.oci_image?.status ?? 'NOT RECORDED',
  note:
    'This section is a POINTER, not a second source of truth: the digest is read from ARTIFACT_IDENTITY.json, ' +
    'and sh scripts/artifact-identity.sh recomputes every digest from the bytes on disk each time it runs. The ' +
    'recorded digest changes whenever the artifact changes, which is why the identity document, not this ' +
    'manifest, is what the artifact-bound stages resolve against.',
  environment_fingerprints: [
    { environment: 'clean-local', fingerprint: '.agent/verification/state/artifact-smoke-fingerprint.txt', what: 'the artifact-bound smoke boot: digest, extracted file count, entry point, commit, node version, environment token, dependency supply' },
    { environment: 'staging', fingerprint: null, what: 'NOT AVAILABLE: staging is NOT_PROVISIONED, so no fingerprint exists; see .agent/evidence/EP-009/M4-staging-deploy.txt' },
  ],
};

const artifactKey = manifest.telemetry_resource.keys['vanishgraph.artifact.digest'];
artifactKey.resolution = 'STATIC';
artifactKey.value = tarballDigest;
delete artifactKey.reason;
artifactKey.note =
  'EP-009 M1 built the declared formats and published this digest; sh scripts/artifact-identity.sh resolves it ' +
  'against the bytes on disk. The digests of the tarball container and of the SBOM vary between builds for the ' +
  'documented reasons (tar mtimes, CycloneDX run identifiers) and the reconciliation is recorded in the identity.';

const inputsKey = manifest.telemetry_resource.keys['vanishgraph.build.inputs_digest'];
inputsKey.resolution = 'STATIC';
inputsKey.value = lockfileDigest;
delete inputsKey.reason;
inputsKey.note =
  'The build inputs this repository can digest are its locked dependencies: the digest recorded here is the ' +
  'package-lock.json digest from ARTIFACT_IDENTITY.json. It is NOT a digest of the toolchain or of the whole ' +
  'build environment, and this note says so rather than letting the attribute imply more than it carries.';

const protectedAfter = {
  registry_count: manifest.registry_count,
  dod_count: manifest.dod_count,
  candidate_epoch: manifest.candidate_epoch,
};
for (const [field, value] of Object.entries(protectedBefore)) {
  if (protectedAfter[field] !== value) throw new Error(`refusing to write: ${field} changed from ${value} to ${protectedAfter[field]}`);
}

writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest refreshed: artifact digest ${tarballDigest.slice(0, 26)}…, inputs digest ${lockfileDigest.slice(0, 26)}…, registry_count ${manifest.registry_count}, dod_count ${manifest.dod_count}, candidate_epoch ${manifest.candidate_epoch}`);
