-- 0016 EPCS: electronic prescribing of controlled substances (MASTER_SPEC §15.4, 21 CFR 1311).
-- The certified partner owns identity proofing, the two-factor credential, the signature and
-- the DEA-required audit of the signing itself. We keep what the practice is responsible for:
-- DEA registrations, who is enrolled, the two-person logical access decisions, and evidence that
-- each controlled prescription was signed in the partner's flow over exactly the content we hold.

-- ---------------------------------------------------------------- DEA registrations
-- DEA registrations live in credential (kind = 'dea_registration'). The number is envelope-encrypted
-- in identifier_enc; identifier holds only a masked form for display.
ALTER TABLE credential ADD CONSTRAINT credential_dea_schedules
  CHECK (dea_schedules <@ ARRAY['II', 'III', 'IV', 'V']::text[]);
ALTER TABLE credential ADD CONSTRAINT credential_dea_shape
  CHECK (kind <> 'dea_registration' OR (identifier_enc IS NOT NULL AND state IS NOT NULL AND expires_on IS NOT NULL AND cardinality(dea_schedules) > 0));

-- ---------------------------------------------------------------- enrollment
-- One row per person enrolled with the partner: prescribers, and the people who approve their
-- access (they need a two-factor credential too, 21 CFR 1311.125(c)). Statuses are copied from the
-- partner; nothing here is set by hand.
CREATE TABLE epcs_enrollment (
  id                        uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                    uuid NOT NULL REFERENCES organization(id),
  staff_member_id           uuid NOT NULL,
  partner_prescriber_id     text NOT NULL UNIQUE,
  identity_proofing_status  text NOT NULL DEFAULT 'pending' CHECK (identity_proofing_status IN ('pending', 'verified', 'failed')),
  two_factor_status         text NOT NULL DEFAULT 'none' CHECK (two_factor_status IN ('none', 'bound', 'revoked')),
  identity_proofed_at       timestamptz,
  two_factor_bound_at       timestamptz,
  enrolled_by               uuid NOT NULL,
  enrolled_at               timestamptz NOT NULL DEFAULT now(),
  synced_at                 timestamptz NOT NULL DEFAULT now(),
  version                   integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, id),
  UNIQUE (org_id, staff_member_id),
  FOREIGN KEY (org_id, staff_member_id) REFERENCES staff_member(org_id, id),
  -- A token is only ever bound to a proofed identity.
  CHECK (two_factor_status = 'none' OR identity_proofing_status = 'verified')
);
SELECT enable_tenant_rls('epcs_enrollment');
CREATE TRIGGER epcs_enrollment_no_delete BEFORE DELETE ON epcs_enrollment FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- logical access (21 CFR 1311.125)
-- Permission for one prescriber to sign controlled prescriptions for some schedules under one
-- DEA registration. One access manager proposes; a second, different person approves with their
-- partner two-factor credential. Either may revoke alone, at once. Rows move forward only.
CREATE TABLE epcs_access_grant (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL REFERENCES organization(id),
  prescriber_id      uuid NOT NULL,
  dea_credential_id  uuid NOT NULL REFERENCES credential(id),
  schedules          text[] NOT NULL CHECK (cardinality(schedules) > 0 AND schedules <@ ARRAY['II', 'III', 'IV', 'V']::text[]),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'revoked')),
  proposed_by        uuid NOT NULL,
  proposed_at        timestamptz NOT NULL DEFAULT now(),
  approved_by        uuid,
  approved_at        timestamptz,
  approval_session_id uuid,
  ended_by           uuid,
  ended_at           timestamptz,
  end_reason         text,
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, prescriber_id) REFERENCES staff_member(org_id, id),
  -- Two different people, and never the prescriber approving their own access.
  CHECK (approved_by IS NULL OR (approved_by <> proposed_by AND approved_by <> prescriber_id)),
  CHECK (status <> 'active' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (status NOT IN ('rejected', 'revoked') OR (ended_by IS NOT NULL AND ended_at IS NOT NULL))
);
SELECT enable_tenant_rls('epcs_access_grant');
CREATE UNIQUE INDEX epcs_access_grant_live ON epcs_access_grant (prescriber_id, dea_credential_id) WHERE status IN ('pending', 'active');

CREATE OR REPLACE FUNCTION epcs_access_grant_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EPCS access decisions are never deleted; revoke instead' USING ERRCODE = '42501';
  END IF;
  IF (NEW.org_id, NEW.prescriber_id, NEW.dea_credential_id, NEW.schedules, NEW.proposed_by, NEW.proposed_at)
     IS DISTINCT FROM (OLD.org_id, OLD.prescriber_id, OLD.dea_credential_id, OLD.schedules, OLD.proposed_by, OLD.proposed_at) THEN
    RAISE EXCEPTION 'what an EPCS access decision covers never changes; propose a new one' USING ERRCODE = '42501';
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('active', 'rejected')) OR (OLD.status = 'active' AND NEW.status = 'revoked')) THEN
    RAISE EXCEPTION 'EPCS access cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'active' AND (NEW.approved_by, NEW.approved_at, NEW.approval_session_id) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at, OLD.approval_session_id) THEN
    RAISE EXCEPTION 'an approval is never rewritten' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER epcs_access_grant_guard BEFORE UPDATE OR DELETE ON epcs_access_grant FOR EACH ROW EXECUTE FUNCTION epcs_access_grant_guard();

-- ---------------------------------------------------------------- partner two-factor sessions
-- Each time someone authenticates in the partner's certified window: to sign a controlled
-- prescription, or to approve someone's access. A finished session is the evidence (factors,
-- the partner's signature reference, the content hash it signed) and never changes again.
CREATE TABLE epcs_session (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id              uuid NOT NULL REFERENCES organization(id),
  partner_session_id  text NOT NULL UNIQUE,
  purpose             text NOT NULL CHECK (purpose IN ('sign_controlled', 'approve_access')),
  staff_member_id     uuid NOT NULL,           -- who authenticates
  prescription_id     uuid,
  grant_id            uuid,
  content_hash        text,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'declined', 'expired', 'failed')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  finished_at         timestamptz,
  factors             text[] NOT NULL DEFAULT '{}',
  signature_ref       text,
  detail              text,
  partner_event_id    text UNIQUE,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, staff_member_id) REFERENCES staff_member(org_id, id),
  FOREIGN KEY (org_id, prescription_id) REFERENCES prescription(org_id, id),
  FOREIGN KEY (org_id, grant_id) REFERENCES epcs_access_grant(org_id, id),
  CHECK ((purpose = 'sign_controlled') = (prescription_id IS NOT NULL AND content_hash IS NOT NULL)),
  CHECK ((purpose = 'approve_access') = (grant_id IS NOT NULL)),
  -- Completion always means two distinct factors (21 CFR 1311.115).
  CHECK (status <> 'completed' OR (cardinality(factors) >= 2 AND finished_at IS NOT NULL))
);
SELECT enable_tenant_rls('epcs_session');
CREATE INDEX epcs_session_rx ON epcs_session (org_id, prescription_id) WHERE prescription_id IS NOT NULL;

CREATE OR REPLACE FUNCTION epcs_session_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EPCS sessions are evidence and are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'a finished EPCS session is immutable' USING ERRCODE = '42501';
  END IF;
  IF (NEW.org_id, NEW.partner_session_id, NEW.purpose, NEW.staff_member_id, NEW.prescription_id, NEW.grant_id, NEW.content_hash, NEW.started_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.org_id, OLD.partner_session_id, OLD.purpose, OLD.staff_member_id, OLD.prescription_id, OLD.grant_id, OLD.content_hash, OLD.started_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'what an EPCS session covers never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER epcs_session_guard BEFORE UPDATE OR DELETE ON epcs_session FOR EACH ROW EXECUTE FUNCTION epcs_session_guard();

-- Partner callbacks about a session arrive without a tenant (like erx_resolve_org).
CREATE OR REPLACE FUNCTION epcs_resolve_session(p_partner_session text) RETURNS TABLE (org_id uuid, session_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT org_id, id FROM epcs_session WHERE partner_session_id = p_partner_session
$$;

-- ---------------------------------------------------------------- prescriptions
-- EPCS_PENDING: content locked and hashed, waiting for the prescriber to sign in the partner's
-- window. The partner signs and transmits in one step, so a completed session goes straight to SENT.
ALTER TABLE prescription DROP CONSTRAINT prescription_status_check;
ALTER TABLE prescription ADD CONSTRAINT prescription_status_check
  CHECK (status IN ('DRAFT', 'EPCS_PENDING', 'SIGNED', 'QUEUED', 'SENT', 'ACCEPTED', 'ERROR', 'CANCELLED'));
-- From the partner's drug database at drafting time, never from the client.
ALTER TABLE prescription ADD COLUMN controlled_class text CHECK (controlled_class IN ('opioid', 'benzodiazepine', 'other'));
ALTER TABLE prescription ADD COLUMN dea_credential_id uuid REFERENCES credential(id);
ALTER TABLE prescription ADD COLUMN pdmp_reviewed_at timestamptz;
ALTER TABLE prescription ADD CONSTRAINT prescription_controlled_shape
  CHECK ((controlled_schedule IS NULL) = (controlled_class IS NULL));
ALTER TABLE prescription ADD CONSTRAINT prescription_controlled_refills
  CHECK (controlled_schedule IS NULL OR (controlled_schedule = 'II' AND refills = 0) OR (controlled_schedule <> 'II' AND refills <= 5));
ALTER TABLE prescription ADD CONSTRAINT prescription_epcs_locked
  CHECK (status <> 'EPCS_PENDING' OR (controlled_schedule IS NOT NULL AND locked_at IS NOT NULL AND content_hash IS NOT NULL AND dea_credential_id IS NOT NULL));
-- A controlled prescription is never sent without a completed partner signing.
ALTER TABLE prescription ADD CONSTRAINT prescription_controlled_never_queued
  CHECK (controlled_schedule IS NULL OR status NOT IN ('SIGNED', 'QUEUED'));

-- A controlled prescription is signed when the partner says so, after the content was locked:
-- signed_at may be filled in once, never changed.
DROP TRIGGER prescription_locked ON prescription;
CREATE TRIGGER prescription_locked BEFORE UPDATE OR DELETE ON prescription
  FOR EACH ROW EXECUTE FUNCTION locked_content_guard('status', 'partner_prescription_id', 'version', 'signed_at');
CREATE OR REPLACE FUNCTION prescription_signed_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL AND NEW.signed_at IS DISTINCT FROM OLD.signed_at THEN
    RAISE EXCEPTION 'a prescription signature time never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prescription_signed_once BEFORE UPDATE ON prescription FOR EACH ROW EXECUTE FUNCTION prescription_signed_once();

GRANT SELECT, INSERT, UPDATE ON epcs_enrollment, epcs_access_grant, epcs_session TO teeth_app;
GRANT EXECUTE ON FUNCTION epcs_resolve_session(text) TO teeth_app;
