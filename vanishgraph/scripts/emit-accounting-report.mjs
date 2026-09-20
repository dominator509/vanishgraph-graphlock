// Emit COMPLETE_TEST_ACCOUNTING.csv from the registry, the applicability matrix and the epoch's ledger rows
// (EP-010 M7(a), DOD-030, VG-SHIP-015).
//
// WHY THIS IS A FILE AND NOT AN INLINE PROGRAM: the first version of this generation lived inside a shell heredoc
// that was patched from the outside, and the patch mangled its own quoting -- the CSV reader lost every double quote
// and the script died with a syntax error. A generator that rewrites a 484-row report belongs in a file where its
// text cannot be altered by the tooling that maintains it.
//
// MEASURED PLAN-VS-TREE DIFFERENCE, RECORDED RATHER THAN WORKED AROUND: the milestone says "the header stays as it
// is", and the header in this tree was `test_id,status,evidence_path` -- three columns, not the eleven the milestone
// lists. The header is therefore REPLACED with the eleven columns, and the difference is recorded in the ledger.
//
// EVERY ROW IS BACKED BY A LEDGER ENTRY: an id with no status row in the current epoch is written as UNACCOUNTED
// with the action that would account for it, never omitted and never given a status it has not earned.
import { readFileSync, writeFileSync } from 'node:fs';

const REGISTRY = '.agent/verification/MASTER_TEST_REGISTRY.csv';
const MATRIX = '.agent/verification/APPLICABILITY_MATRIX.csv';
const LEDGER = '.agent/verification/state/TEST_LEDGER.jsonl';
const RUN_STATE = '.agent/verification/state/RUN_STATE.json';
const OUTPUT = '.agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv';

/** A real RFC4180 reader: titles in this registry contain commas and quotes. */
function readCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; } else { quoted = false; }
      } else { field += character; }
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ',') { row.push(field); field = ''; continue; }
    if (character === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (character === '\r') continue;
    field += character;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((entry) => entry.length > 1 || (entry[0] ?? '').trim() !== '');
}

const toRecords = (text) => {
  const rows = readCsv(text);
  const header = rows[0].map((name) => name.trim().replace(/^\ufeff/, ''));
  return rows.slice(1).map((values) => Object.fromEntries(header.map((name, index) => [name, (values[index] ?? '').trim()])));
};

const quote = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const runState = JSON.parse(readFileSync(RUN_STATE, 'utf8'));
const epoch = runState.epoch;
const registry = toRecords(readFileSync(REGISTRY, 'utf8'));
const matrix = toRecords(readFileSync(MATRIX, 'utf8'));
const matrixById = new Map(matrix.map((row) => [row.test_id, row]));
const registryIds = new Set(registry.map((record) => record.test_id));

const latest = new Map();
for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  const row = JSON.parse(line);
  const id = row.test_id ?? row.id;
  if (!registryIds.has(id)) continue;
  if ((row.epochId ?? row.epoch) !== epoch) continue;
  latest.set(id, row);
}

const HEADER = ['test_id', 'source_group', 'owner_stage', 'applicability', 'status', 'reason', 'evidence_path', 'epoch_id', 'artifact_digest', 'blocking_dependency', 'next_action'];
const lines = [HEADER.join(',')];
let unaccounted = 0;
const statusCounts = {};
for (const record of registry) {
  const id = record.test_id;
  const row = latest.get(id);
  const matrixRow = matrixById.get(id) ?? {};
  if (row === undefined) unaccounted += 1;
  else statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  lines.push([
    id,
    record.source_group ?? '',
    matrixRow.owner_stage ?? '',
    matrixRow.applicability ?? '',
    row === undefined ? 'UNACCOUNTED' : row.status,
    row === undefined ? 'no status row for this id in the current epoch' : (row.reason ?? ''),
    row === undefined ? '' : (row.evidencePath ?? ''),
    row === undefined ? epoch : (row.epochId ?? row.epoch ?? ''),
    row === undefined ? '' : (row.artifactDigest ?? ''),
    row === undefined ? '' : (row.blockingDependency ?? ''),
    row === undefined ? 'run the stage that owns this id' : (row.nextAction ?? ''),
  ].map(quote).join(','));
}
writeFileSync(OUTPUT, `${lines.join('\n')}\n`);
console.log(`accounting report: ${OUTPUT} holds ${lines.length - 1} data row(s) for epoch ${epoch}; ${unaccounted} unaccounted; statuses ${JSON.stringify(statusCounts)}`);
