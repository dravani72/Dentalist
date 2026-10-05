-- 0006 Patient portal (MASTER_SPEC §16, §19).
--
-- Patients and their authorized representatives get their own identities, separate from
-- workforce accounts. A portal identity sees a patient only through an explicit access grant
-- that names the relationship (self, parent/guardian, legal representative, caregiver), the
-- record areas it covers, who verified it, and when it ends.
--
-- Two walls keep a portal session inside its grants:
--   1. the API resolves grants for every request and checks the patient and scope;
--   2. every table with a patient_id gets a RESTRICTIVE row-level policy: when the transaction
--      carries app.portal_patients (set only for portal requests), rows of any other patient are
--      invisible and unwritable, even if a query forgets its WHERE clause.

-- ---------------------------------------------------------------- the second wall

CREATE OR REPLACE FUNCTION app_portal_allows(p_patient uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN coalesce(current_setting('app.portal_patients', true), '') = '' THEN true
    ELSE p_patient = ANY (current_setting('app.portal_patients', true)::uuid[])
  END
$$;

-- ---------------------------------------------------------------- identities and sessions

-- One identity per person, across practices (a parent may use two practices). Not tenant data.
CREATE TABLE portal_account (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  email            text NOT NULL,
  display_name     text NOT NULL,
  password_hash    text NOT NULL,
  email_verified_at timestamptz,
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  disabled_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX portal_account_email ON portal_account (lower(email));

-- Second factor: a short-lived code sent to the account's email (plan: portal MFA by email/SMS).
-- Only a hash of the code is stored.
CREATE TABLE portal_login_challenge (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  portal_account_id uuid NOT NULL REFERENCES portal_account(id),
  code_hash         text NOT NULL,
  attempts          integer NOT NULL DEFAULT 0,
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE portal_session (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  token_hash        text NOT NULL UNIQUE,
  portal_account_id uuid NOT NULL REFERENCES portal_account(id),
  org_id            uuid NOT NULL REFERENCES organization(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz
);

-- ---------------------------------------------------------------- delegated access

CREATE TABLE portal_access_grant (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL,
  portal_account_id  uuid NOT NULL REFERENCES portal_account(id),
  patient_id         uuid NOT NULL,
  relationship       text NOT NULL CHECK (relationship IN ('self', 'parent_guardian', 'legal_representative', 'caregiver')),
  scopes             text[] NOT NULL,
  -- How staff confirmed the relationship (ID checked in person, court order on file...). Required
  -- for anyone other than the patient. No document contents here, only a description.
  verification_note  text,
  granted_by         uuid NOT NULL,
  granted_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz,
  revoked_at         timestamptz,
  revoked_by         uuid,
  revoke_reason      text,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  CHECK (relationship = 'self' OR verification_note IS NOT NULL),
  CHECK (scopes <@ ARRAY['appointments', 'visits', 'treatment_plan', 'health_record', 'prescriptions',
                         'pharmacies', 'messages', 'forms', 'requests']::text[])
);
CREATE UNIQUE INDEX portal_grant_one_active ON portal_access_grant (org_id, portal_account_id, patient_id) WHERE revoked_at IS NULL;
SELECT enable_tenant_rls('portal_access_grant');

-- An invitation is how a grant starts: staff verify the person, and the code reaches them by
-- email or in person. Only the code's hash is stored.
CREATE TABLE portal_invitation (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL,
  patient_id         uuid NOT NULL,
  email              text NOT NULL,
  invitee_name       text NOT NULL,
  relationship       text NOT NULL CHECK (relationship IN ('self', 'parent_guardian', 'legal_representative', 'caregiver')),
  scopes             text[] NOT NULL,
  verification_note  text,
  expires_grant_at   timestamptz,
  code_hash          text NOT NULL UNIQUE,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  accepted_at        timestamptz,
  accepted_grant_id  uuid,
  revoked_at         timestamptz,
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  CHECK (relationship = 'self' OR verification_note IS NOT NULL)
);
SELECT enable_tenant_rls('portal_invitation');

-- Resolves an invitation code to its practice before the request knows its tenant.
CREATE OR REPLACE FUNCTION portal_invitation_org(p_code_hash text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT org_id FROM portal_invitation
   WHERE code_hash = p_code_hash AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
$$;

-- Practices where an account holds at least one live grant (for choosing a practice at sign-in).
CREATE OR REPLACE FUNCTION portal_account_orgs(p_account uuid)
RETURNS TABLE (org_id uuid, org_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT o.id, o.name
    FROM portal_access_grant g JOIN organization o ON o.id = g.org_id
   WHERE g.portal_account_id = p_account AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
   ORDER BY o.name
$$;

-- ---------------------------------------------------------------- secure messaging

CREATE TABLE portal_thread (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                uuid NOT NULL,
  patient_id            uuid NOT NULL,
  subject               text NOT NULL,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  started_by_portal_id  uuid REFERENCES portal_account(id),
  started_by_staff_id   uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_message_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('portal_thread');

CREATE TABLE portal_message (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL,
  thread_id          uuid NOT NULL,
  patient_id         uuid NOT NULL,
  author_portal_id   uuid REFERENCES portal_account(id),
  author_staff_id    uuid,
  body               text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at         timestamptz NOT NULL DEFAULT now(),
  read_by_staff_at   timestamptz,
  read_by_patient_at timestamptz,
  FOREIGN KEY (org_id, thread_id) REFERENCES portal_thread(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  CHECK ((author_portal_id IS NULL) <> (author_staff_id IS NULL))
);
SELECT enable_tenant_rls('portal_message');
CREATE INDEX portal_message_thread ON portal_message (thread_id, created_at);

-- Messages are part of the record: only read receipts may change after sending.
CREATE OR REPLACE FUNCTION portal_message_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['read_by_staff_at', 'read_by_patient_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['read_by_staff_at', 'read_by_patient_at']) THEN
    RAISE EXCEPTION 'sent messages are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_message_immutable BEFORE UPDATE ON portal_message FOR EACH ROW EXECUTE FUNCTION portal_message_guard();

-- ---------------------------------------------------------------- patient requests

-- Patient-submitted items go to a staff queue; nothing a patient submits changes the clinical
-- record directly. Staff review a history update and record it through the normal versioned
-- history, so the chart always says which clinician confirmed it.
CREATE TABLE portal_request (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL,
  patient_id         uuid NOT NULL,
  portal_account_id  uuid NOT NULL REFERENCES portal_account(id),
  kind               text NOT NULL CHECK (kind IN ('appointment', 'appointment_cancel', 'history_update', 'records_copy', 'amendment')),
  details            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'in_review', 'completed', 'declined')),
  -- HIPAA response clocks: 30 days for access (45 CFR 164.524), 60 days for amendment (164.526).
  respond_by         date,
  staff_note         text,
  handled_by         uuid,
  handled_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('portal_request');

-- ---------------------------------------------------------------- communication preferences

CREATE TABLE patient_comm_preference (
  org_id               uuid NOT NULL,
  patient_id           uuid NOT NULL,
  email_reminders      boolean NOT NULL DEFAULT true,
  sms_reminders        boolean NOT NULL DEFAULT false,
  portal_notifications boolean NOT NULL DEFAULT true,
  preferred_language   text NOT NULL DEFAULT 'en',
  updated_by_portal_id uuid,
  updated_by_staff_id  uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, patient_id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('patient_comm_preference');

-- ---------------------------------------------------------------- consents (§19)

-- Consents are versioned objects, not mutable PDFs. A template version never changes; a new
-- wording is a new version. Signatures store the exact text presented and its SHA-256.
CREATE TABLE consent_template (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id       uuid NOT NULL,
  template_key text NOT NULL,
  version      integer NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL,
  language     text NOT NULL DEFAULT 'en',
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz,
  UNIQUE (org_id, template_key, version),
  UNIQUE (org_id, id)
);
SELECT enable_tenant_rls('consent_template');

CREATE TABLE consent_request (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                uuid NOT NULL,
  patient_id            uuid NOT NULL,
  template_id           uuid NOT NULL,
  planned_procedure_ids uuid[] NOT NULL DEFAULT '{}',
  provider_id           uuid,
  requested_by          uuid NOT NULL,
  requested_at          timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'declined', 'cancelled')),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, template_id) REFERENCES consent_template(org_id, id)
);
SELECT enable_tenant_rls('consent_request');

CREATE TABLE consent_signature (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL,
  consent_request_id uuid NOT NULL,
  patient_id         uuid NOT NULL,
  template_id        uuid NOT NULL,
  signer_relationship text NOT NULL CHECK (signer_relationship IN ('self', 'parent_guardian', 'legal_representative')),
  signer_portal_id   uuid REFERENCES portal_account(id),
  signer_typed_name  text NOT NULL,
  presented_at       timestamptz NOT NULL,
  signed_at          timestamptz NOT NULL DEFAULT now(),
  rendered_text      text NOT NULL,
  rendered_sha256    text NOT NULL,
  revoked_at         timestamptz,
  revoke_reason      text,
  FOREIGN KEY (org_id, consent_request_id) REFERENCES consent_request(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, template_id) REFERENCES consent_template(org_id, id)
);
SELECT enable_tenant_rls('consent_signature');

CREATE OR REPLACE FUNCTION consent_template_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'retired_at') IS DISTINCT FROM (to_jsonb(OLD) - 'retired_at') THEN
    RAISE EXCEPTION 'consent template versions are immutable; create a new version' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_template_immutable BEFORE UPDATE ON consent_template FOR EACH ROW EXECUTE FUNCTION consent_template_guard();

CREATE OR REPLACE FUNCTION consent_signature_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['revoked_at', 'revoke_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revoke_reason']) THEN
    RAISE EXCEPTION 'signed consents are immutable; revoke instead' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'consent already revoked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_signature_immutable BEFORE UPDATE ON consent_signature FOR EACH ROW EXECUTE FUNCTION consent_signature_guard();

-- ---------------------------------------------------------------- apply the second wall

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name FROM information_schema.columns c
      JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = 'public'::regnamespace
     WHERE c.table_schema = 'public' AND c.column_name = 'patient_id' AND k.relkind = 'r' AND k.relrowsecurity
  LOOP
    EXECUTE format('CREATE POLICY portal_scope ON %I AS RESTRICTIVE USING (app_portal_allows(patient_id)) WITH CHECK (app_portal_allows(patient_id))', r.table_name);
  END LOOP;
END $$;
CREATE POLICY portal_scope ON patient AS RESTRICTIVE USING (app_portal_allows(id)) WITH CHECK (app_portal_allows(id));

-- ---------------------------------------------------------------- grants

GRANT SELECT, INSERT, UPDATE ON portal_account, portal_login_challenge, portal_session,
  portal_access_grant, portal_invitation, portal_thread, portal_message, portal_request,
  patient_comm_preference, consent_template, consent_request, consent_signature TO teeth_app;
GRANT EXECUTE ON FUNCTION portal_invitation_org(text), portal_account_orgs(uuid) TO teeth_app;
