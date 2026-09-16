-- 0033 — the capability policy for webhook ingress (SPEC-003 §6.1/§6.2).
--
-- WHY THIS IS A SEPARATE MIGRATION RATHER THAN A LINE IN 0032, and the reason is a MEASURED hazard rather than
-- tidiness. `scripts/generate-rls.ts` renders a migration that creates a tenant-scoped table as
-- `head = original.split('-- RLS-GENERATED-BEGIN')[0]` followed by regenerated blocks — so EVERYTHING AFTER THE
-- FIRST MARKER is discarded on `--write`, silently, while `--check` still reports zero drift. The policy below was
-- first written into 0032 after the generated block; it did not survive, 0032 applied without it, and every
-- capability resolution returned `undefined` until the database was inspected. A migration that creates no table is
-- returned UNCHANGED by the generator, which makes this file a safe home for hand-written policy.
--
-- THE POLICY. §6's ingress is the only surface with no bearer token, so the route cannot know the tenant when it must
-- resolve the binding. `FORCE ROW LEVEL SECURITY` applies to the table OWNER too, so a `SECURITY DEFINER` lookup
-- would not bypass it, and the role model has no BYPASSRLS role (vg_owner migrates, vg_app runs, neither bypasses).
-- The resolver therefore proves knowledge of the CAPABILITY to the database, which is the same shape as the tenant
-- policy: the caller presents a value, and sees only the row that value names.
--
--   * without `app.tenant_id` AND without a capability value: NO row is visible;
--   * with `app.webhook_token_hash`: exactly the row whose hash matches — a value the caller necessarily had;
--   * with `app.webhook_provider_key`: exactly the row whose advertised key id matches;
--   * with `app.tenant_id`: the tenant's own rows, exactly as before.
--
-- A policy that merely allowed unbound SELECT (`current_setting('app.tenant_id', true) IS NULL`) would have exposed
-- every binding — case ids and secret names included — to any session that forgot to set a tenant. `nullif(..., '')`
-- is deliberate: an EMPTY setting must not match a row whose column is not null and not empty, and an unset setting
-- returns NULL either way.

CREATE POLICY webhook_capability_lookup ON webhook_binding FOR SELECT
  USING (
    (token_hash IS NOT NULL AND token_hash = nullif(current_setting('app.webhook_token_hash', true), ''))
    OR (provider_key_id IS NOT NULL
        AND provider_key_id = nullif(current_setting('app.webhook_provider_key', true), ''))
  );
