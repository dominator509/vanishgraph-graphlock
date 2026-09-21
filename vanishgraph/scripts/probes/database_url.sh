#!/usr/bin/env sh
# DATABASE_URL readiness probe. Sentinel: `<NAME>: ok - <detail>`; contract in scripts/lib/loud-fail.sh.
#
# SPEC BASIS AND THE DECLARED ACTION. PREFLIGHT.md declares this probe for DATABASE_URL and SPEC-007 section 7.2
# declares what the PostgreSQL dependency must do: "pooled connection: BEGIN; SELECT 1; ROLLBACK, and the session role
# must be the tenant-scoped application role". This probe performs exactly that action against the DSN.
#
# WHY IT ALSO CHECKS THE ROLE. A DSN that connects as the database OWNER answers SELECT 1 and passes every readiness
# check while the tenancy boundary the product depends on does not exist: row-level security does not apply to a
# superuser, so a probe that only ran SELECT 1 would report a database that is reachable and unusable for its purpose.
# The probe therefore also reads whether the session role is a superuser, and refuses when it is.
#
# IT USES THE APPLICATION'S OWN DRIVER - `pg`, the declared runtime dependency - rather than `psql`, which is not
# installed on this host and would test a different client than the one that has to work.
#
# IT NEVER PRINTS THE DSN OR THE ROLE NAME: the DSN carries a password and the role name is the deployment's, so only a
# short outcome word crosses back out of node.
set -eu
. "$(dirname "$0")/../lib/loud-fail.sh"
vg_require_env 'DATABASE_URL' 'EP-003'

RESULT=$(node -e '
(async () => {
  const dsn = String(process.env.DATABASE_URL ?? "");
  let pool;
  try {
    const pg = await import("pg");
    pool = new pg.default.Pool({ connectionString: dsn, max: 1, connectionTimeoutMillis: 3000 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1");
      await client.query("ROLLBACK");
      const role = await client.query("SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = current_user");
      if (role.rows.length === 0) { process.stdout.write("ROLE_NOT_VISIBLE"); return; }
      if (role.rows[0].rolsuper === true) { process.stdout.write("SESSION_IS_SUPERUSER"); return; }
      if (role.rows[0].rolcanlogin !== true) { process.stdout.write("ROLE_CANNOT_LOGIN"); return; }
      // AND IT MUST NOT BE THE DATABASE OWNER EITHER. MEASURED REASON FOR THIS SECOND CHECK: a control that pointed
      // this probe at the provisioned OWNER DSN PASSED the superuser test, because that role owns the database without
      // being a superuser - so the first version of this probe would have accepted the owner credential and reported a
      // tenancy boundary that does not exist. The owner is read from the catalogue rather than assumed.
      const owner = await client.query("SELECT current_user = pg_get_userbyid(datdba) AS is_owner FROM pg_database WHERE datname = current_database()");
      if (owner.rows.length > 0 && owner.rows[0].is_owner === true) { process.stdout.write("SESSION_IS_DATABASE_OWNER"); return; }
      process.stdout.write("OK");
    } finally {
      client.release();
    }
  } catch (error) {
    process.stdout.write(String(error && error.code ? error.code : "UNREACHABLE"));
  } finally {
    if (pool !== undefined) { try { await pool.end(); } catch { /* the pool is already closed */ } }
  }
})();
' 2>/dev/null || printf 'UNREACHABLE')

case "$RESULT" in
  OK)
    vg_probe_ok 'DATABASE_URL' 'a pooled connection opened, BEGIN/SELECT 1/ROLLBACK answered, and the session role is not a superuser'
    ;;
  SESSION_IS_DATABASE_OWNER)
    echo "ERROR: DATABASE_URL connected as the OWNER of this database; the owner bypasses row-level security, so this DSN cannot serve the tenant-scoped role the service requires (VG-DATA-001)" >&2
    exit 1
    ;;
  SESSION_IS_SUPERUSER)
    echo "ERROR: DATABASE_URL connected, but its session role is a SUPERUSER; row-level security does not apply to a superuser, so this DSN cannot serve the tenant-scoped role the service requires (VG-DATA-001)" >&2
    exit 1
    ;;
  ROLE_CANNOT_LOGIN)
    echo "ERROR: DATABASE_URL connected, but its session role cannot log in, so it is not a usable application role" >&2
    exit 1
    ;;
  ROLE_NOT_VISIBLE)
    echo "ERROR: DATABASE_URL connected, but the session role is not visible in pg_roles, so this probe cannot classify it" >&2
    exit 1
    ;;
  28P01|28000)
    echo "ERROR: DATABASE_URL was refused with ${RESULT}: the credential is provisioned and NOT accepted" >&2
    exit 1
    ;;
  3D000)
    echo "ERROR: DATABASE_URL names a database that does not exist (3D000)" >&2
    exit 1
    ;;
  ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|UNREACHABLE)
    vg_probe_cannot 'DATABASE_URL' "the declared database is not reachable from this environment (${RESULT}), so the credential could not be tested; an unreachable service is not a refused credential"
    ;;
  *)
    echo "ERROR: the database probe failed with ${RESULT}, which is neither acceptance nor a declared unreachability" >&2
    exit 1
    ;;
esac
