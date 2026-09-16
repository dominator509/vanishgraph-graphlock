#!/usr/bin/env node
/**
 * JUnit XML summary parser used by scripts/test-collection-guard.sh.
 *
 * Implements DOD-007: "The harness fails when zero tests or fewer than the
 * expected manifest are collected." Many runners exit zero for empty,
 * misconfigured, or partially discovered suites, so a green suite that collected
 * nothing is the most dangerous result in the harness because it is
 * indistinguishable from success.
 *
 * JUnit is used rather than TAP because Node's TAP reporter emits only subtest
 * *names*; the JUnit reporter emits a `file` attribute per test case, which is what
 * makes per-suite manifest verification possible at all.
 *
 * MEASURED RUNNER BEHAVIOUR (verified in this repository, not assumed):
 *   - A glob matching no files at all makes `node --test` exit non-zero and emit no
 *     summary -> reported as "zero tests collected".
 *   - A test FILE that declares no tests still emits ONE `<testcase>` whose `name`
 *     is the file path. That is a runner artifact, not a test. Counting it as a
 *     test would silently mask an emptied suite, so this parser excludes any
 *     test case whose name is itself a file path.
 *
 * Reads JUnit XML on stdin. Exits 0 when collection is valid, 1 otherwise.
 *
 * Environment:
 *   VG_EXPECTED_MANIFEST  newline-delimited list of test files that must each
 *                         contribute at least one real test. Optional.
 */

import { readFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const xml = Buffer.concat(chunks).toString('utf8');

/** Normalise a path for comparison across platforms. */
const norm = (p) => p.replace(/\\/g, '/').replace(/^.*?\/vanishgraph\//, '');

/**
 * A test case whose NAME is a test-file path is the runner's file-level artifact
 * for a file that declares no tests.
 *
 * This must test the *extension ending*, not "contains a path separator": a real
 * test in this repository is named
 *   "SM-2/SM-3: every transition names evidence, so audit has something to record"
 * which contains a slash. A broader rule silently excluded that genuine test and
 * undercounted the suite (measured: 93 instead of 94). Precision here is what keeps
 * the guard from either missing an emptied suite or hiding a real one.
 */
const isFileLevelArtifact = (name) => /\.test\.[cm]?[jt]s\s*$/.test(name);

/**
 * Node's JUnit reporter nests `<testcase>` elements: a `describe` suite emits an
 * outer testcase containing an inner testcase per test. A non-greedy
 * `<testcase>...</testcase>` match therefore swallows nested cases and undercounts
 * (measured: 66 instead of 94). Counting opening tags is the correct approach.
 */
const cases = [...xml.matchAll(/<testcase\b[^>]*>/g)].map((m) => {
  const tag = m[0];
  const name = (tag.match(/\bname="([^"]*)"/) ?? [, ''])[1];
  const file = (tag.match(/\bfile="([^"]*)"/) ?? [, ''])[1];
  return { name, file: norm(file), placeholder: isFileLevelArtifact(name) };
});

const real = cases.filter((c) => !c.placeholder);
const tests = real.length;

// Failures and skips are counted from their own elements; each belongs to one case.
const failures = [...xml.matchAll(/<(failure|error)\b/g)].length;
const skipped = [...xml.matchAll(/<skipped\b/g)].length;

/** JUnit escapes the message text; decode the few entities the reporter emits so the name is readable. */
const decodeEntities = (s) =>
  s
    .replace(/&#10;/g, ' ')
    .replace(/&#13;/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * The IDENTITY of each failing test, not just how many failed.
 *
 * WHY THIS EXISTS. The guard's failure path printed only a count, and `scripts/test-integration.sh` preserves that
 * output as the evidence for a failure that does not reproduce. MEASURED (EP-006 M10): the stage failed with
 * `{"tests":338,"fail":1,…}` and the preserved file `integration-guard.failed.txt` named no test at all, so the
 * failure had to be reproduced by hand from a suite that runs in ninety seconds. A count is the verdict; a name is
 * what makes the verdict actionable, and DOD-025 wants evidence a reader can act on.
 *
 * The per-case region is the text between one `<testcase>` opening tag and the NEXT one, which is exactly the
 * non-nested content: a `describe` suite's failure belongs to its inner testcase, and the inner tag IS the next
 * opening tag, so a nested failure is never attributed to its parent suite.
 */
const failureDetails = [];
{
  const opens = [...xml.matchAll(/<testcase\b[^>]*>/g)];
  for (let i = 0; i < opens.length; i += 1) {
    const start = opens[i].index + opens[i][0].length;
    const end = i + 1 < opens.length ? opens[i + 1].index : xml.length;
    const body = xml.slice(start, end);
    if (!/<(failure|error)\b/.test(body)) continue;
    const tag = opens[i][0];
    const name = (tag.match(/\bname="([^"]*)"/) ?? [, ''])[1];
    const file = norm((tag.match(/\bfile="([^"]*)"/) ?? [, ''])[1]);
    const message = decodeEntities(
      (body.match(/<(?:failure|error)\b[^>]*\bmessage="([^"]*)"/) ?? [, ''])[1],
    )
      .split('\n')[0]
      .trim()
      .slice(0, 300);
    failureDetails.push({ file, name, message });
  }
}

if (tests === 0) {
  if (!/<testsuites?\b/.test(xml)) {
    console.error('test collection guard: FAIL - zero tests were collected');
    console.error('No JUnit output was produced at all: the runner failed to start or crashed.');
  } else if (cases.length > 0) {
    console.error('test collection guard: FAIL - zero real tests were collected');
    console.error(
      `The runner reported ${cases.length} file-level artifact(s) but no actual test cases. ` +
        'A suite whose tests were all removed must not pass (DOD-007).',
    );
  } else {
    console.error('test collection guard: FAIL - zero tests were collected');
    console.error('An empty or misconfigured suite must never pass (DOD-007).');
  }
  process.exit(1);
}

const problems = [];

const manifestPath = process.env.VG_EXPECTED_MANIFEST;
let manifestChecked = 0;
if (manifestPath) {
  let entries;
  try {
    entries = readFileSync(manifestPath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch (err) {
    console.error(`test collection guard: FAIL - cannot read manifest ${manifestPath}: ${err.message}`);
    process.exit(1);
  }
  for (const entry of entries) {
    manifestChecked += 1;
    const wanted = norm(entry);
    const contributed = real.filter((c) => c.file === wanted || c.file.endsWith(wanted)).length;
    if (contributed === 0) {
      const sawArtifact = cases.some((c) => c.placeholder && (c.file === wanted || c.file.endsWith(wanted)));
      problems.push(
        sawArtifact
          ? `expected suite ran but contributed no real tests (emptied suite): ${entry}`
          : `expected suite produced no results: ${entry}`,
      );
    }
  }
}

process.stdout.write(
  JSON.stringify({
    tests,
    fail: failures,
    skipped,
    fileArtifactsExcluded: cases.length - real.length,
    filesSeen: new Set(real.map((c) => c.file)).size,
    manifestChecked,
    // Named so a preserved failing run is diagnosable without a re-run; empty on a green run.
    failed: failureDetails.map((d) => `${d.file} :: ${d.name}`),
    verdict: problems.length === 0 && failures === 0 ? 'OK' : 'FAIL',
  }) + '\n',
);

if (problems.length > 0) {
  console.error('test collection guard: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('A suite that silently stops running removes its coverage without any red build.');
  process.exit(1);
}
if (failures > 0) {
  console.error(`test collection guard: FAIL - ${failures} test(s) failed`);
  if (failureDetails.length === 0) {
    // A failure element the region walk could not attribute is reported as such rather than silently omitted.
    console.error('  (the failing test names could not be attributed from the JUnit document)');
  }
  for (const detail of failureDetails) {
    console.error(`  - ${detail.file} :: ${detail.name}`);
    if (detail.message.length > 0) console.error(`      ${detail.message}`);
  }
  process.exit(1);
}
if (skipped > 0) {
  console.error(
    `test collection guard: NOTE - ${skipped} test(s) skipped; DOD-006 requires an approved, ` +
      'time-bounded waiver for each skipped test, with owner and rationale.',
  );
}
process.exit(0);
