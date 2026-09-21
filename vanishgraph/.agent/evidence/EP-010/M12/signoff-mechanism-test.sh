#!/usr/bin/env sh
# EP-010 M12: fast mechanism test for the external gate sign-off rules (scripts/external-gates-status.sh).
# Three labelled fixtures prove the accept path and both refusal paths in seconds, because the rules now live in one
# script instead of inside the ship gate. Every fixture is deleted before the script exits, and the final assertion
# requires the store to be empty and the status document to read 0/5.
set -u
# Run from the REPOSITORY ROOT: this script lives at .agent/evidence/EP-010/M12/, four levels down, and an earlier
# version walked up only two and operated on a path that did not exist. Guarding beats guessing the depth.
[ -f package.json ] || { echo "signoff-mechanism-test: run me from the repository root (package.json not found in $(pwd))" >&2; exit 2; }
STORE=.agent/evidence/EP-010/V-021/signoffs.jsonl
EVID=.agent/evidence/EP-010/M12/signoff-evidence-fixture.txt
LOG=.agent/evidence/EP-010/M12
mkdir -p "$LOG"
: > "$STORE"
printf 'MECHANISM TEST EVIDENCE ARTIFACT - not a sign-off. It exists so the rules can be shown to require a stored, hashed artifact.\n' > "$EVID"
EVID_DIGEST=$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$EVID")
DIGEST=$(node -e 'const d=require("./.agent/verification/state/ARTIFACT_IDENTITY.json");const t=d.artifact_paths.find(p=>p.endsWith(".tgz"));process.stdout.write(d.artifact_digests[t])')
STALE=sha256:6fe9573315f6fb4d559a7e47df0437b7caa49780f31567229a109e610a633cab
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "pinned:   $DIGEST"
echo "evidence: $EVID_DIGEST"

# f1 ACCEPT: correct digest, role, all five fields, stored evidence with matching digest.
printf '{"gate_id":"EXT-GATE-01","gate":"human UAT of the golden path","status":"SIGNED","externalPartyRole":"Named authorised business participant","signerRef":"MECHANISM-TEST-FIXTURE - NOT A SIGNATURE","signatureMethod":"mechanism test","signedAt":"%s","signedArtifactDigest":"%s","scope":"mechanism test","unresolvedFindings":"none","evidencePath":"%s","evidenceDigest":"%s"}\n' "$NOW" "$DIGEST" "$EVID" "$EVID_DIGEST" > "$STORE"
# f2 REFUSE: correct everything except the digest, which is the SUPERSEDED artifact.
printf '{"gate_id":"EXT-GATE-02","gate":"manual assistive-technology validation at WCAG 2.2 AA","status":"SIGNED","externalPartyRole":"Named assistive-technology practitioner","signerRef":"MECHANISM-TEST-FIXTURE","signatureMethod":"mechanism test","signedAt":"%s","signedArtifactDigest":"%s","scope":"mechanism test","unresolvedFindings":"none","evidencePath":"%s","evidenceDigest":"%s"}\n' "$NOW" "$STALE" "$EVID" "$EVID_DIGEST" >> "$STORE"
# f3 REFUSE: correct digest but the evidence artifact does not exist.
printf '{"gate_id":"EXT-GATE-03","gate":"legal and compliance review of jurisdictions, agent evidence, templates and claims","status":"SIGNED","externalPartyRole":"Qualified counsel","signerRef":"MECHANISM-TEST-FIXTURE","signatureMethod":"mechanism test","signedAt":"%s","signedArtifactDigest":"%s","scope":"mechanism test","unresolvedFindings":"none","evidencePath":".agent/evidence/EP-010/M12/does-not-exist.txt","evidenceDigest":"%s"}\n' "$NOW" "$DIGEST" "$EVID_DIGEST" >> "$STORE"

echo "=== RUN A: one valid fixture, one stale-digest fixture, one missing-evidence fixture ==="
sh scripts/external-gates-status.sh > "$LOG/signoff-test-runA.log" 2>&1
echo "exit=$?"
cat "$LOG/signoff-test-runA.log"
python3 -c "
import json;d=json.load(open('.agent/verification/state/EXTERNAL_GATES_STATUS.json'))
print('ASSERT signed==1 :', d['gates_signed']==1)
print('ASSERT refusals==2:', len(d['blockers'])==2)
print('ASSERT stale named:', any('6fe95733' in b['what'] for b in d['blockers']))
print('ASSERT missing evidence named:', any('does not exist' in b['what'] for b in d['blockers']))
"

echo "=== fixtures removed ==="
: > "$STORE"
rm -f "$EVID"
echo "=== RUN B: the committed state ==="
sh scripts/external-gates-status.sh > "$LOG/signoff-test-runB.log" 2>&1
echo "exit=$?"
cat "$LOG/signoff-test-runB.log"
python3 -c "
import json;d=json.load(open('.agent/verification/state/EXTERNAL_GATES_STATUS.json'))
print('ASSERT signed==0 :', d['gates_signed']==0)
print('ASSERT blockers==0:', len(d['blockers'])==0)
"
echo "store bytes: $(wc -c < "$STORE")"
