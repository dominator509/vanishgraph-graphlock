// Record the withdrawals for rows superseded by harness changes inside the current epoch (EP-010 M7(d), SPEC-006 ST-2).
//
// WHY THIS IS NEEDED RATHER THAN A RELAXED CHECK: the accounting refuses an ID with more than one status row in the
// current epoch unless the audit trail records a withdrawal, and it is right to — a status that changes without a
// recorded reason is exactly what ST-2 forbids. This round re-ran every stage after the executor gained the
// per-status required fields and the dependency-edge reference, so each ID has an earlier row from before that
// change. Those rows are superseded, not erased: this pass writes the withdrawal the re-runs did not write, with the
// reason naming the change, and the ledger stays append-only.
import { readFileSync, appendFileSync } from 'node:fs';

const LEDGER = '.agent/verification/state/TEST_LEDGER.jsonl';
const AUDIT = '.agent/verification/state/STATUS_TRANSITION_AUDIT.jsonl';
const RUN_STATE = '.agent/verification/state/RUN_STATE.json';

const epoch = JSON.parse(readFileSync(RUN_STATE, 'utf8')).epoch;
const REASON = 'harness change inside the epoch: the stage executor gained the per-status required fields of SPEC-006 section 4.1 (coveredSurface/uncoveredSurface/coverageDenominator for PARTIAL, the blocked-status fields, the deferred provenance) and the dependency-edge reference, so every status row written before that change is superseded by the re-run that followed it (EP-010 M7)';

const rows = readFileSync(LEDGER, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
const byId = new Map();
for (const row of rows) {
  const id = row.test_id ?? row.id;
  if (!/^(GEN|HIPAA|BC|E2E|SUP)-/.test(String(id ?? ''))) continue;
  if ((row.epochId ?? row.epoch) !== epoch) continue;
  if (!byId.has(id)) byId.set(id, []);
  byId.get(id).push(row);
}

const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const withdrawals = [];
for (const [id, history] of byId) {
  if (history.length < 2) continue;
  // Every row except the LAST one is superseded, and each gets its own withdrawal naming the status it carried.
  for (const row of history.slice(0, -1)) {
    withdrawals.push({ test_id: id, from: row.status, to: 'WITHDRAWN', reason: REASON, epochId: epoch, at, ownerStage: row.ownerStage ?? null });
  }
}
if (withdrawals.length > 0) appendFileSync(AUDIT, `${withdrawals.map((row) => JSON.stringify(row)).join('\n')}\n`);
console.log(`supersession recorded: ${withdrawals.length} withdrawal(s) across ${new Set(withdrawals.map((row) => row.test_id)).size} id(s) in epoch ${epoch}`);
