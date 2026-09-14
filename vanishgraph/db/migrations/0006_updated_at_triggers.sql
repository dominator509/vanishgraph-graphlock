-- 0006 — maintain updated_at truthfully (SPEC-002 §1).
--
-- Additive only (MIG-3): it adds a function and triggers and changes no column. It exists as
-- its own migration precisely so the upgrade matrix has a real "prior schema + new migration"
-- pair to exercise with data already in the tables.

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER protected_subject_set_updated_at BEFORE UPDATE ON protected_subject
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER exposure_set_updated_at BEFORE UPDATE ON exposure
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER request_case_set_updated_at BEFORE UPDATE ON request_case
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
