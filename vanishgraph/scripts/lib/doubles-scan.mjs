// The scan behind scripts/double-boundary-guard.sh (EP-007 M6). Not a test: a guard's implementation.
//
// INPUT: argv[2] = the PATH of an allowlist file of `file|symbol|reason` lines.
//
// WHY A PATH AND NOT THE TEXT: MEASURED in round 92 — the first version passed the allowlist as a multi-line argument
// inside a double-quoted shell variable, and the two halves of one invocation disagreed about the same value (the
// wrapper recorded "allowlist entries: 2" while the scan reported "all 0 explained"). The guard printed its sentinel
// with a fabricated adapter present in `src/**`, which is the one outcome this guard exists to prevent. A path is a
// single token: no newlines, no quoting, nothing to split.
//
// OUTPUT: one line per finding, a summary line, exit 1 when anything is unexplained.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const allowlistPath = process.argv[2];
if (allowlistPath === undefined || allowlistPath.length === 0) {
  console.error('double boundary scan: ERROR - no allowlist path was given');
  process.exit(2);
}

const allowlist = readFileSync(allowlistPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))
  .map((line) => {
    const parts = line.split('|');
    return { file: (parts[0] ?? '').trim(), symbol: (parts[1] ?? '').trim(), reason: parts.slice(2).join('|').trim() };
  })
  .filter((entry) => entry.file.length > 0 && entry.symbol.length > 0);

// DECLARATIONS, NOT MENTIONS — MEASURED: a bare-occurrence pattern flagged `src/domain/ports/authority-repository.ts`
// for the word `InMemory` inside the doc comment that explains why `InMemory` is a deliberate marker, and a guard that
// fires on the prose explaining the rule is a guard people learn to ignore.
const DOUBLE_SHAPED =
  String.raw`(?:class|interface|type|const|function|let|var)\s+((?:InMemory|Fake|Stub|Mock|Simulated|Double|Dummy)[A-Za-z0-9_]*)`;

/** `rg` that returns an empty list instead of throwing when nothing matches. */
function rg(args) {
  try {
    return execFileSync('rg', args, { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

const normalise = (file) => file.replace(/\\/g, '/');
const findings = [];

// CHECK 1: a production module must not import the test tree.
for (const file of rg(['-l', String.raw`from\s+['"][^'"]*tests/`, 'src']).map(normalise)) {
  findings.push(`src imports the test tree: ${file}`);
}

// CHECK 2: no double-shaped DECLARATION under src/**, except the justified entries.
const files = rg(['-l', DOUBLE_SHAPED, 'src']).map(normalise);
const allowed = (file, symbol) => allowlist.some((entry) => entry.file === file && entry.symbol === symbol);
for (const file of files) {
  for (const symbol of rg(['-o', '-N', '--no-heading', '-r', '$1', DOUBLE_SHAPED, file])) {
    if (allowed(file, symbol)) continue;
    findings.push(`double-shaped symbol in a production path: ${file} declares ${symbol}`);
  }
}

// CHECK 3: an allowlist entry that matches nothing is a waiver nobody can audit.
for (const entry of allowlist) {
  let present = true;
  try {
    execFileSync('rg', ['-F', '-q', entry.symbol, entry.file], { stdio: 'ignore' });
  } catch {
    present = false;
  }
  if (!present) findings.push(`stale allowlist entry (no longer matches anything): ${entry.file} ${entry.symbol}`);
}

if (findings.length > 0) {
  for (const finding of findings) console.log(`  - ${finding}`);
  console.log(`double boundary scan: ${String(findings.length)} finding(s) over ${String(files.length)} file(s) under src/**`);
  process.exit(1);
}

console.log(
  `double boundary scan: src/** imports no test module; ${String(files.length)} file(s) carry a double-shaped ` +
    `declaration, all ${String(allowlist.length)} explained by an allowlist entry; the allowlist matches exactly what it names`,
);
console.log('NOTE ON THE LIMIT: this is a NAME scan. A double named something ordinary is invisible to it, and the file');
console.log('that would be one — src/adapters/crypto/local-key-provider.ts — is justified in ASSUMPTIONS §3.8 and in its');
console.log('own header rather than allowlisted here, because it is a real provider with a real bound, not a double.');
process.exit(0);
