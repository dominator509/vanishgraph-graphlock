-- 0013 — the natural key SPEC-003 §5.3.6's `CATALOG_ENTRY_DUPLICATE` needs.
--
-- WHY A SEPARATE MIGRATION RATHER THAN AN EDIT TO 0012: migrations are immutable (DOD-040, and
-- `migrate.ts verify` fails on any drift). 0012 was applied before this key was needed, so the key
-- arrives as its own version. That is the intended cost of immutability, not an inconvenience.
--
-- WHY THE KEY IS `(source_id, category)`: §5.3.6 raises `409 CATALOG_ENTRY_DUPLICATE` and §5.3.5
-- describes the catalogue as the set of things a source covers — one entry per category. SPEC-002 §2
-- declares no natural key for `source_catalog_entry`, so without one the conflict code is
-- undecidable: a second POST for the same category would either create a duplicate row (and the
-- endpoint's documented error could never occur) or require application-level locking, which is a
-- check-then-insert that two concurrent requests both pass.
--
-- A UNIQUE index is the only construction that makes the refusal atomic, and it is the same device
-- 0012 used for `(tenant_id, name)` on `source` for `SOURCE_ALREADY_DECLARED`.

CREATE UNIQUE INDEX source_catalog_entry_source_category_uniq
  ON source_catalog_entry (source_id, category);
