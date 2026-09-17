/**
 * One-off check: run the real job-worker probe against the real `job_worker` table.
 *
 * IT LIVES INSIDE THE REPOSITORY SO `pg` RESOLVES: a copy in a temporary directory failed with ERR_MODULE_NOT_FOUND
 * because node_modules is here, which is worth recording as the reason this file is not in /tmp. The DSN is read from
 * the database state file rather than passed on a command line (VG-SEC-002).
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const statePath = process.env.VG_DB_STATE_FILE ?? 'C:/tmp/vanishgraph-db.env';
const dsn = /^export VG_TEST_DSN_APP=(.*)$/m
  .exec(readFileSync(statePath, 'utf8'))?.[1]
  ?.trim()
  .replace(/^['"]|['"]$/g, '') ?? '';
if (dsn.length === 0) {
  console.error('no VG_TEST_DSN_APP in the state file');
  process.exit(2);
}

const probes = await import(pathToFileURL(`${process.cwd()}/src/adapters/observability/dependency-probes.ts`).href);
const pg = (await import('pg')).default;
const pool = new pg.Pool({ connectionString: dsn, max: 1 });
const probe = probes.jobWorkerProbe({
  windowMs: 60_000,
  freshHeartbeats: async () => {
    const result = await pool.query("SELECT count(*)::int AS fresh FROM job_worker WHERE heartbeat_at > now() - interval '60 seconds'");
    return Number(result.rows[0]?.fresh ?? 0);
  },
});
try {
  console.log('probe ->', await probe());
} catch (error) {
  console.log('probe -> refused:', error.reasonCode, '|', error.message);
}
await pool.end();
