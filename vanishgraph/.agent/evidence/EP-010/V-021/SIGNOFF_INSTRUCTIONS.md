# External gate sign-off records (EP-010 M12)

**This file is the ONLY way an external gate can register as signed.** It is authored OUTSIDE the harness: no
script in this repository writes `.agent/evidence/EP-010/V-021/signoffs.jsonl`, so a record can only get here
because a human put it here. That is deliberate — DOD-039 forbids an agent, a model or automation from satisfying
one of these gates, and a mechanism that let the harness write its own sign-off would make the whole gate theatre.

A machine check reads every record. A gate counts as **signed** only when its record names the signer, the method,
the date, the scope and the unresolved findings, and **covers the pinned artifact digest**. Anything less is
reported as a blocker and does **not** count.

## Record format — one JSON object per line in `signoffs.jsonl`

```json
{"gate_id":"EXT-GATE-01","gate":"human UAT of the golden path","status":"SIGNED","externalPartyRole":"Named authorised business participant","signerRef":"REFERENCE ONLY - role + roster/ticket label, never personal data beyond what the role requires","signatureMethod":"how the sign-off was produced and where it is kept, e.g. detached GPG signature over SHA256SUMS, or a committed review record","signedAt":"2026-09-22T10:00:00Z","signedArtifactDigest":"sha256:<the digest you actually signed - must equal the pinned artifact digest>","scope":"what you reviewed or exercised, against which scenario list","unresolvedFindings":"the findings you leave open; write 'none' if there are none - an empty value is rejected","evidencePath":"path to the stored signature or review record - the file must EXIST","evidenceDigest":"<sha256 of that file's bytes>","note":"optional free text"}
```

### Required fields and why

| field | DOD-039's required evidence | what the check does |
|---|---|---|
| `signerRef` | Named authorized sign-off | rejected if absent or blank |
| `signatureMethod` | (how it is authenticated) | rejected if absent or blank |
| `signedAt` | Date | rejected if absent or blank |
| `scope` | Scope | rejected if absent or blank |
| `unresolvedFindings` | Unresolved findings | rejected if absent or blank; write `none` |
| `signedArtifactDigest` | Scenarios/evidence | must equal the **pinned** artifact digest, printed by `sh scripts/production-readiness-check.sh` and recorded in `.agent/verification/state/ARTIFACT_IDENTITY.json` |
| `externalPartyRole` | (who may sign) | must be exactly the role in the request file |
| `evidencePath` | (where the sign-off is kept) | must name a file that **exists**, or the record is refused |
| `evidenceDigest` | (the sign-off resolves to a hash) | must be the sha256 of that file's bytes, or the record is refused |

The last two exist because this repository's own rule is that every claim resolves to a stored artifact hash
(VG-EVIDENCE-002). A sign-off that names no artifact, or names one whose bytes do not match the recorded hash, is
refused by name with both values printed.

**What no check can do, stated plainly:** none of this proves a signature is *authentic*. The rules verify the
record's SHAPE. A fabricated record would have to fabricate a stored artifact and its hash too, which is a
deliberate act rather than an accident — that is the whole of the guarantee, and it is not more than that.

The rules are implemented once, in `sh scripts/external-gates-status.sh` (sentinel
`external gates status: N/M signed`), and both the ship gate and the DOD gate read its output. They used to be
implemented twice, and both copies were wrong in EP-010 M12: one hardcoded every gate to `EXTERNAL_REQUIRED`, the
other hardcoded the signed count to `0`, so no sign-off could affect the verdict. That is why the rules now live in
one script with its own mechanism test at `.agent/evidence/EP-010/M12/signoff-mechanism-test.sh`.

A sign-off whose digest is a **superseded** artifact is refused by name, with both digests printed, because a
signature over bytes that no longer exist attests nothing. Check the current digest before you sign:

```sh
python3 -c "import json;d=json.load(open('.agent/verification/state/ARTIFACT_IDENTITY.json'));print(d['artifact_digests'][[p for p in d['artifact_paths'] if p.endswith('.tgz')][0]])"
```

## The five gates and who may sign each

| gate_id | gate | role that must sign |
|---|---|---|
| EXT-GATE-01 | human UAT of the golden path | Named authorised business participant |
| EXT-GATE-02 | manual assistive-technology validation at WCAG 2.2 AA | Named assistive-technology practitioner |
| EXT-GATE-03 | legal and compliance review of jurisdictions, agent evidence, templates and claims | Qualified counsel |
| EXT-GATE-04 | hardware, HSM or accredited assessment where applicable | Accredited assessor |
| EXT-GATE-05 | production deployment authorization | Authorised operator (manual only) |

## What happens when you add a record

1. Put the participant's signature or review record somewhere durable and reference it in `evidencePath`
   (for example `deploy/production/signoffs/uat-2026-09-22.md` or a detached `.asc` beside `SHA256SUMS`).
2. Append one JSON line per gate to `signoffs.jsonl`; keep one line per gate, do not rewrite other lines.
3. Re-run `sh scripts/production-readiness-check.sh`. The verdict's `external_gates[]` then carries `SIGNED` with
   the signer, method, date, scope and findings, `external gates N/5 signed` moves, and once all five are in and no
   other blocker holds, the `GO` branch becomes reachable.
4. If a record is refused, the verdict says exactly which field failed and prints `EXTERNAL-GATE-SIGNOFF-INVALID-*`
   as a blocker naming both digests or the mismatched role. Nothing is silently ignored.
