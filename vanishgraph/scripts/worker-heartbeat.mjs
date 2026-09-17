#!/usr/bin/env node
/**
 * The minimal worker heartbeat runtime (SPEC-007 §7.2's `job-worker` probe; EP-008 M5).
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT. The `job-worker` probe asks one question: is at least one worker
 * heartbeat inside the declared freshness window? Answering it needs a process that REGISTERS ITSELF in `job_worker` and
 * REFRESHES `heartbeat_at` on an interval — which is what this is. IT PROCESSES NO JOBS: it does not claim work from the
 * `job` table, it does not run a recipe, and it must never be described as a worker that does. It exists so the declared
 * probe can be exercised against the REAL table with REAL heartbeats and then be induced to fail by stopping it, and so
 * that the row stops being blocked for a reason that is code rather than environment.
 *
 * IT WRITES ONLY ITS OWN ROW, keyed by `worker_id` (the primary key of `job_worker`), and it touches no other table. The
 * heartbeat interval is configurable because the probe's freshness window is: the two must be chosen together, and the
 * defaults below keep at least ten heartbeats inside a sixty-second window.
 *
 * USAGE:
 *   node scripts/worker-heartbeat.mjs --dsn <DSN> [--worker-id ID] [--interval-ms N] [--once]
 *   SIGTERM / SIGINT: removes its own heartbeat row and exits, so a stopped worker leaves no stale row behind. A stale
 *   row would make the probe pass for a worker that is not running, which is the failure the freshness window exists to
 *   prevent.
 */

import { setTimeout as delay } from 'node:timers/promises';

function parseArgs(argv) {
  const args = { dsn: process.env.VG_TEST_DSN_APP ?? '', workerId: 'vg-worker-heartbeat-1', intervalMs: 5000, once: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dsn') args.dsn = argv[index + 1];
    else if (argv[index] === '--worker-id') args.workerId = argv[index + 1];
    else if (argv[index] === '--interval-ms') args.intervalMs = Number(argv[index + 1]);
    else if (argv[index] === '--once') args.once = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.dsn.trim().length === 0) {
  console.error('worker-heartbeat: FAIL - no DSN; pass --dsn or set VG_TEST_DSN_APP');
  process.exit(2);
}
if (!Number.isInteger(args.intervalMs) || args.intervalMs <= 0) {
  console.error('worker-heartbeat: FAIL - interval must be a positive integer number of milliseconds');
  process.exit(2);
}

// pg IS COMMONJS, SO .default IS THE MODULE OBJECT: destructuring default and then reading .default.Pool again
// yields undefined, which is what the first version did in both this file and the check script.
const pg = (await import('pg')).default;
const pool = new pg.Pool({ connectionString: args.dsn, max: 1 });

/** One heartbeat. The upsert is written out rather than using ON CONFLICT so it does not depend on a constraint shape. */
async function beat() {
  const client = await pool.connect();
  try {
    const updated = await client.query('UPDATE job_worker SET heartbeat_at = now(), current_kind = $2 WHERE worker_id = $1', [args.workerId, 'HEARTBEAT_ONLY']);
    if (updated.rowCount === 0) {
      await client.query('INSERT INTO job_worker (worker_id, current_kind, heartbeat_at) VALUES ($1, $2, now())', [args.workerId, 'HEARTBEAT_ONLY']);
    }
  } finally {
    client.release();
  }
}

/** Leave no row behind: a stale heartbeat would make the probe pass for a worker that is not running. */
async function deregister() {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM job_worker WHERE worker_id = $1', [args.workerId]);
  } finally {
    client.release();
  }
}

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true;
  });
}

await beat();
console.log(`worker-heartbeat: registered ${args.workerId}, beating every ${String(args.intervalMs)} ms (HEARTBEAT ONLY: this process claims no jobs)`);
if (args.once) {
  await deregister();
  await pool.end();
  console.log('worker-heartbeat: one beat written and removed');
  process.exit(0);
}

while (!stopping) {
  await delay(args.intervalMs);
  if (stopping) break;
  await beat();
}

await deregister();
await pool.end();
console.log(`worker-heartbeat: ${args.workerId} stopped and deregistered`);
process.exit(0);
