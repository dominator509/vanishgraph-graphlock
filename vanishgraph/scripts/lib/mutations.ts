/**
 * Mutation registry and runner for the DOD-018 check.
 *
 * Each entry is a controlled defect applied to a real source file. The harness requires
 * that at least one real test FAILS while the mutation is present, and that the file is
 * restored byte-identically afterwards. A suite that stays green under a mutation is not
 * observing the behaviour it claims to protect.
 *
 * Anchors are exact source text: if an anchor stops matching, the mutation is reported as
 * a harness ERROR rather than silently skipping the check (DOD-024, DOD-033).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export interface Mutation {
  readonly id: string;
  readonly file: string;
  readonly description: string;
  readonly find: string;
  readonly replace: string;
  readonly testFile: string;
}

export const MUTATIONS: readonly Mutation[] = Object.freeze([
  {
    id: 'MUT-1',
    file: 'src/domain/values.ts',
    description: 'Confidence range check replaced by a tautology',
    find: 'if (value < 0 || value > 1) {',
    replace: 'if (false) {',
    testFile: 'tests/domain/values.test.ts',
  },
  {
    id: 'MUT-2',
    file: 'src/domain/values.ts',
    description: 'Confidence basis requirement removed',
    find: 'if (!Array.isArray(basis) || basis.length === 0) {',
    replace: 'if (false) {',
    testFile: 'tests/domain/values.test.ts',
  },
  {
    id: 'MUT-3',
    file: 'src/domain/truth-state.ts',
    description: 'T14 independence guard weakened to always satisfied',
    find: "independentObservation: { description: 'independent observation', satisfiedBy: (f: TransitionFacts) => f.independentObservation },",
    replace: "independentObservation: { description: 'independent observation', satisfiedBy: () => true },",
    testFile: 'tests/domain/state-machine.test.ts',
  },
  {
    id: 'MUT-4',
    file: 'src/domain/state-machine.ts',
    description: 'forbidden-pair check disabled',
    find: 'const forbidden = forbiddenReason(from, to);\n  if (forbidden !== undefined) {',
    replace: 'const forbidden = forbiddenReason(from, to);\n  if (false && forbidden !== undefined) {',
    testFile: 'tests/domain/state-machine.test.ts',
  },
  {
    id: 'MUT-5',
    file: 'src/domain/entities.ts',
    description: 'self-verification check removed from VerificationObservation',
    find: 'if (input.actorIdentity === input.actingIdentity) {',
    replace: 'if (false) {',
    testFile: 'tests/domain/entities.test.ts',
  },
  {
    id: 'MUT-6',
    file: 'src/domain/commands.ts',
    description: 'idempotency-key replay check disabled',
    find: 'if (input.existingIdempotencyKeys.includes(input.action.idempotencyKey.value)) {',
    replace: 'if (false) {',
    testFile: 'tests/domain/commands.test.ts',
  },
  {
    id: 'MUT-7',
    file: 'src/domain/invariants.ts',
    description: 'observation-window check removed',
    find: 'if (!window.hasElapsed(observedAtMs, actionAtMs)) {',
    replace: 'if (false) {',
    testFile: 'tests/domain/invariants.test.ts',
  },
]);

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function runTests(testFile: string): { status: number | null; output: string } {
  const result = spawnSync('node', ['--test', testFile], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

export function runMutationCheck(): number {
  let failures = 0;
  for (const mutation of MUTATIONS) {
    const original = readFileSync(mutation.file, 'utf8');
    const originalDigest = sha256(original);
    if (!original.includes(mutation.find)) {
      console.error(
        `mutations: ERROR - anchor for ${mutation.id} not found in ${mutation.file}; ` +
          'the mutation must be re-anchored, never skipped (DOD-033)',
      );
      return 1;
    }
    const mutated = original.replace(mutation.find, mutation.replace);
    writeFileSync(mutation.file, mutated);
    let detected = false;
    try {
      const run = runTests(mutation.testFile);
      detected = run.status !== 0;
      console.log(
        `mutations: ${mutation.id} ${detected ? 'DETECTED' : 'MISSED'} - ${mutation.description} ` +
          `(${mutation.testFile} exit ${String(run.status)})`,
      );
      if (!detected) {
        console.error(run.output.split('\n').slice(-20).join('\n'));
      }
    } finally {
      writeFileSync(mutation.file, original);
      if (sha256(readFileSync(mutation.file, 'utf8')) !== originalDigest) {
        console.error(`mutations: ERROR - ${mutation.file} was not restored byte-identically`);
        return 1;
      }
    }
    if (!detected) failures += 1;
  }
  if (failures > 0) {
    console.error(`mutations: ${failures} mutation(s) were not detected by any test`);
    return 1;
  }
  console.log('mutations: all detected');
  console.log('restore: verified');
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1].replace(/\\/g, '/').endsWith('scripts/lib/mutations.ts');

if (invokedDirectly) {
  process.exit(runMutationCheck());
}
