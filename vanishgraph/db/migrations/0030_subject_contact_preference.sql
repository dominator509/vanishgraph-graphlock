-- 0030 — the subject's contact preference, which §5.1.4 declares patchable and the schema had nowhere to keep.
--
-- SPEC-003 §5.1.4's request body is "any subset of {displayRef, isMinor, contactPreference: {channel:
-- "EMAIL", contactRefId: "cref_01H…"}}", and `protected_subject` carried neither member: a PATCH that
-- accepted `contactPreference` would have had to drop it silently, which is the failure mode §2.6's
-- strict parsing exists to prevent (a caller believes a preference is recorded when nothing was).
--
-- TWO COLUMNS, NOT ONE JSONB BLOB. `contactRefId` is an OPAQUE REFERENCE to a contact channel record —
-- never the address or number itself, which is why it is named a ref — and it is separate so a later
-- verified-notice feature (SPEC-005 VG-AUTHZ-014's notice to the subject's verified contact channel) can
-- join on the channel kind without unpacking JSON.
--
-- THE CHANNEL TOKENS ARE NOT A DATABASE ENUM, and that is deliberate: NO specification enumerates the
-- contact channels a subject may prefer (`EMAIL` appears once, inside §5.1.4's example). An enum would
-- turn an unlisted-but-legitimate channel into a write failure, and inventing the list here would be
-- exactly the kind of unlegislated vocabulary this repository refuses elsewhere. The CHECK bounds the
-- SHAPE only — upper snake case — so a typo is still refused, and the value's meaning stays where it
-- belongs.
--
-- NULLable with no default: a subject with no recorded preference has none, and defaulting to a channel
-- would record a preference the subject never expressed. `contact_channel` and `contact_ref_id` are
-- constrained TOGETHER, because a channel with no reference cannot deliver anything and a reference with
-- no channel cannot be used.

ALTER TABLE protected_subject
  ADD COLUMN contact_channel text,
  ADD COLUMN contact_ref_id  text;

ALTER TABLE protected_subject
  ADD CONSTRAINT protected_subject_contact_shape
    CHECK (contact_channel IS NULL OR contact_channel ~ '^[A-Z][A-Z0-9_]{1,31}$');

ALTER TABLE protected_subject
  ADD CONSTRAINT protected_subject_contact_pair
    CHECK ((contact_channel IS NULL) = (contact_ref_id IS NULL));
