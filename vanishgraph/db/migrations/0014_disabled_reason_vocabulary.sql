-- 0014 — withdraw the `disabled_reason` vocabulary CHECK added by 0012.
--
-- WHY IT IS WITHDRAWN RATHER THAN WIDENED. `removal_recipe.disabled_reason` carries TWO different
-- provenances and a single CHECK cannot express both:
--
--   * a SYSTEM-computed reason, when VG-CHANNEL-002 auto-disables a recipe because its source's
--     permission was downgraded or its freshness lapsed. This vocabulary is closed and genuinely
--     belongs in the schema.
--   * an OPERATOR-supplied reason, when §5.3.10 disables a recipe deliberately and the request body
--     carries `reason`. §5.3.10's own example is `PERMISSION_REFRESHED`, which 0012's list did not
--     contain — so the CHECK would have rejected the specification's own example with a `23514`
--     constraint violation, surfacing as a 500 on a legitimate request.
--
-- Widening the list to include every operator token is not available: the tokens are caller input and
-- unbounded by any specification, so the CHECK would either reject legitimate reasons or grow until it
-- constrained nothing. The closed half of the rule moves to a TypeScript union in
-- `src/adapters/persistence/sources.ts`, where the system reasons are produced, and the operator half
-- is validated as a bounded token at the route. That keeps the constraint where it can actually hold.
--
-- The column itself, and both of its consumers (§5.3.8's `disabledReason`, §5.3.10's write), are
-- unchanged: this migration only removes an over-tight constraint, so no row is rewritten and no
-- existing value becomes invalid.

ALTER TABLE removal_recipe
  DROP CONSTRAINT removal_recipe_disabled_reason_vocabulary;

-- The withdrawn constraint's intent, kept where it can be enforced: a SYSTEM reason is never NULL when
-- a recipe was disabled by the permission path. `disabled_reason` stays meaningful for operators
-- reading the row, which is what §5.3.8 surfaces it for.
COMMENT ON COLUMN removal_recipe.disabled_reason IS
  'Why this recipe version is not enabled. Set by the permission path (closed token vocabulary) or by '
  '§5.3.10 with the operator''s reason. NULL while enabled.';
