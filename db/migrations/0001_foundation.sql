-- 0001 foundation: tenancy, identity, audit chain, patients, health history.
-- Runs as teeth_owner. The API connects as teeth_app, which is subject to row-level security
-- on every tenant table (teeth_app has no BYPASSRLS and owns nothing).

-- ---------------------------------------------------------------- helpers

CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid
LANGUAGE sql VOLATILE AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
              FROM 1 FOR 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;

-- Tenant and actor come from transaction-local settings the API sets on every request.
CREATE OR REPLACE FUNCTION app_org() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_actor() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.actor_id', true), '')::uuid $$;

-- Adds the standard tenant policy to a table: rows are visible and writable only when their
-- org_id matches the transaction's app.org_id. A query that forgets a WHERE clause still cannot
-- see another practice's rows.
CREATE OR REPLACE FUNCTION enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (org_id = app_org()) WITH CHECK (org_id = app_org())', tbl);
END $$;

-- ---------------------------------------------------------------- tenancy

CREATE TABLE organization (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  name        text NOT NULL,
  npi         text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- An organization row is visible only to its own members.
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization USING (id = app_org());

CREATE TABLE location (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id       uuid NOT NULL REFERENCES organization(id),
  name         text NOT NULL,
  address_line text NOT NULL,
  city         text NOT NULL,
  state        char(2) NOT NULL,
  zip          text NOT NULL,
  time_zone    text NOT NULL,
  phone        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
SELECT enable_tenant_rls('location');

CREATE TABLE operatory (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id      uuid NOT NULL REFERENCES organization(id),
  location_id uuid NOT NULL,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  FOREIGN KEY (org_id, location_id) REFERENCES location(org_id, id)
);
SELECT enable_tenant_rls('operatory');

CREATE TABLE resource (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id      uuid NOT NULL REFERENCES organization(id),
  location_id uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('scanner', 'sedation', 'imaging_room', 'equipment')),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  FOREIGN KEY (org_id, location_id) REFERENCES location(org_id, id)
);
SELECT enable_tenant_rls('resource');

CREATE TABLE org_counter (
  org_id uuid NOT NULL REFERENCES organization(id),
  name   text NOT NULL,
  value  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, name)
);
SELECT enable_tenant_rls('org_counter');

CREATE OR REPLACE FUNCTION next_counter(p_name text) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO org_counter (org_id, name, value) VALUES (app_org(), p_name, 1)
  ON CONFLICT (org_id, name) DO UPDATE SET value = org_counter.value + 1
  RETURNING value
$$;

-- ---------------------------------------------------------------- identity

-- A person's login. Global (one person may work for several practices); holds no PHI.
CREATE TABLE user_account (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  email           text NOT NULL,
  display_name    text NOT NULL,
  password_hash   text NOT NULL,
  totp_secret_enc text NOT NULL,
  disabled_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_account_email ON user_account (lower(email));

-- Server-side sessions: opaque bearer token (only its SHA-256 is stored), idle and absolute
-- timeouts, and the time of the last step-up authentication.
CREATE TABLE user_session (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  token_hash      text NOT NULL UNIQUE,
  user_id         uuid NOT NULL REFERENCES user_account(id),
  org_id          uuid NOT NULL REFERENCES organization(id),
  staff_member_id uuid NOT NULL,
  auth_methods    text[] NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  step_up_at      timestamptz,
  step_up_method  text,
  revoked_at      timestamptz
);

-- Membership of a person in a practice. Privileges are explicit; role_template only records
-- which template an administrator started from.
CREATE TABLE staff_member (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id        uuid NOT NULL REFERENCES organization(id),
  user_id       uuid NOT NULL REFERENCES user_account(id),
  display_name  text NOT NULL,
  role_template text NOT NULL,
  privileges    text[] NOT NULL DEFAULT '{}',
  location_ids  uuid[] NOT NULL DEFAULT '{}',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id),
  UNIQUE (org_id, id)
);
SELECT enable_tenant_rls('staff_member');

CREATE TABLE credential (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                uuid NOT NULL REFERENCES organization(id),
  staff_member_id       uuid NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('dental_license', 'hygiene_license', 'assistant_certificate', 'npi', 'dea_registration')),
  title                 text,            -- DDS, DMD, RDH, CDA
  identifier            text,            -- license or NPI number
  identifier_enc        text,            -- DEA number, envelope-encrypted by the application
  state                 char(2),
  dea_schedules         text[] NOT NULL DEFAULT '{}',
  epcs_status           text NOT NULL DEFAULT 'not_enrolled'
                        CHECK (epcs_status IN ('not_enrolled', 'identity_proofed', 'active', 'suspended')),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'suspended', 'revoked')),
  expires_on            date,
  verified_by           uuid,
  verified_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, staff_member_id) REFERENCES staff_member(org_id, id)
);
SELECT enable_tenant_rls('credential');

-- Login needs to list a person's memberships before a tenant is chosen. This narrow
-- SECURITY DEFINER function is the only cross-tenant read path, and returns no PHI.
CREATE OR REPLACE FUNCTION auth_memberships(p_user uuid)
RETURNS TABLE (staff_member_id uuid, org_id uuid, org_name text, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.org_id, o.name, s.display_name
  FROM staff_member s JOIN organization o ON o.id = s.org_id
  WHERE s.user_id = p_user AND s.active
  ORDER BY o.name
$$;

-- ---------------------------------------------------------------- audit (append-only, hash chained)

CREATE TABLE audit_event (
  seq            bigserial PRIMARY KEY,
  id             uuid NOT NULL DEFAULT uuid_v7() UNIQUE,
  chain_id       uuid NOT NULL,           -- org_id, or the nil UUID for pre-tenant events (failed logins)
  org_id         uuid,
  occurred_at    timestamptz NOT NULL,
  actor_user_id  uuid,
  actor_staff_id uuid,
  session_id     uuid,
  action         text NOT NULL,
  object_type    text,
  object_id      text,
  patient_id     uuid,
  purpose        text,
  outcome        text NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  prev_hash      text NOT NULL,
  hash           text NOT NULL
);
CREATE INDEX audit_event_chain ON audit_event (chain_id, seq);
CREATE INDEX audit_event_patient ON audit_event (org_id, patient_id, occurred_at);
CREATE INDEX audit_event_actor ON audit_event (org_id, actor_staff_id, occurred_at);

-- teeth_app may read its own tenant's audit rows (gated again by audit.read in the API);
-- it cannot insert directly, only through audit_append().
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit_event FOR SELECT USING (org_id = app_org());

CREATE OR REPLACE FUNCTION audit_hash(
  p_prev text, p_id uuid, p_at timestamptz, p_org uuid, p_user uuid, p_staff uuid, p_session uuid,
  p_action text, p_object_type text, p_object_id text, p_patient uuid, p_purpose text, p_outcome text,
  p_details jsonb, p_correlation text
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(concat_ws('|',
    p_prev, p_id::text,
    to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(p_org::text, ''), coalesce(p_user::text, ''), coalesce(p_staff::text, ''),
    coalesce(p_session::text, ''), p_action, coalesce(p_object_type, ''), coalesce(p_object_id, ''),
    coalesce(p_patient::text, ''), coalesce(p_purpose, ''), p_outcome, p_details::text,
    coalesce(p_correlation, '')), 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION audit_append(
  p_org uuid, p_user uuid, p_staff uuid, p_session uuid, p_action text, p_object_type text,
  p_object_id text, p_patient uuid, p_purpose text, p_outcome text, p_details jsonb, p_correlation text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_chain uuid := coalesce(p_org, '00000000-0000-0000-0000-000000000000');
  v_prev  text;
  v_id    uuid := uuid_v7();
  v_at    timestamptz := clock_timestamp();
  v_seq   bigint;
BEGIN
  -- Callers may only write events for the tenant their transaction is bound to.
  IF p_org IS NOT NULL AND p_org IS DISTINCT FROM app_org() THEN
    RAISE EXCEPTION 'audit org does not match session tenant' USING ERRCODE = '42501';
  END IF;
  -- Serialize appends per chain so prev_hash is always the true predecessor.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_chain::text, 7));
  SELECT hash INTO v_prev FROM audit_event WHERE chain_id = v_chain ORDER BY seq DESC LIMIT 1;
  v_prev := coalesce(v_prev, repeat('0', 64));
  INSERT INTO audit_event (id, chain_id, org_id, occurred_at, actor_user_id, actor_staff_id, session_id, action,
                           object_type, object_id, patient_id, purpose, outcome, details, correlation_id, prev_hash, hash)
  VALUES (v_id, v_chain, p_org, v_at, p_user, p_staff, p_session, p_action, p_object_type, p_object_id, p_patient,
          p_purpose, p_outcome, coalesce(p_details, '{}'::jsonb), p_correlation, v_prev,
          audit_hash(v_prev, v_id, v_at, p_org, p_user, p_staff, p_session, p_action, p_object_type, p_object_id,
                     p_patient, p_purpose, p_outcome, coalesce(p_details, '{}'::jsonb), p_correlation))
  RETURNING seq INTO v_seq;
  RETURN v_seq;
END $$;

-- Recomputes every hash in a chain; returns the first broken sequence number, or NULL if intact.
CREATE OR REPLACE FUNCTION audit_verify_chain(p_chain uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r audit_event%ROWTYPE;
  v_prev text := repeat('0', 64);
BEGIN
  FOR r IN SELECT * FROM audit_event WHERE chain_id = p_chain ORDER BY seq LOOP
    IF r.prev_hash <> v_prev OR r.hash <> audit_hash(r.prev_hash, r.id, r.occurred_at, r.org_id, r.actor_user_id,
        r.actor_staff_id, r.session_id, r.action, r.object_type, r.object_id, r.patient_id, r.purpose, r.outcome,
        r.details, r.correlation_id) THEN
      RETURN r.seq;
    END IF;
    v_prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: append-only record', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- patients

CREATE TABLE patient (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL REFERENCES organization(id),
  home_location_id   uuid NOT NULL,
  chart_number       text NOT NULL,
  legal_given_name   text NOT NULL,
  legal_family_name  text NOT NULL,
  preferred_name     text,
  former_names       text[] NOT NULL DEFAULT '{}',
  date_of_birth      date NOT NULL,
  sex_at_birth       text NOT NULL CHECK (sex_at_birth IN ('female', 'male', 'intersex', 'unknown')),
  gender_identity    text,
  preferred_language text NOT NULL DEFAULT 'en',
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  updated_at         timestamptz,
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, id),
  UNIQUE (org_id, chart_number),
  FOREIGN KEY (org_id, home_location_id) REFERENCES location(org_id, id)
);
SELECT enable_tenant_rls('patient');
CREATE INDEX patient_name ON patient (org_id, lower(legal_family_name), lower(legal_given_name));

CREATE TABLE patient_contact (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id      uuid NOT NULL,
  patient_id  uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('email', 'phone', 'address')),
  value       text NOT NULL,
  is_primary  boolean NOT NULL DEFAULT false,
  sms_opt_in  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('patient_contact');

CREATE TABLE guardian_link (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id               uuid NOT NULL,
  patient_id           uuid NOT NULL,
  guardian_name        text NOT NULL,
  relationship         text NOT NULL,
  is_responsible_party boolean NOT NULL DEFAULT false,
  can_access_portal    boolean NOT NULL DEFAULT false,
  phone                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('guardian_link');

CREATE TABLE insurance_policy (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                 uuid NOT NULL,
  patient_id             uuid NOT NULL,
  rank                   smallint NOT NULL DEFAULT 1,
  payer_name             text NOT NULL,
  member_id_enc          text NOT NULL,
  group_number           text,
  subscriber_relationship text NOT NULL DEFAULT 'self',
  active                 boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('insurance_policy');

-- ---------------------------------------------------------------- health history (§6)
-- Versioned facts: an edit inserts a new row that supersedes the old one, so the history of
-- what was known when is never lost.

CREATE TABLE allergy (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  patient_id        uuid NOT NULL,
  substance         text NOT NULL,
  reaction          text,
  severity          text NOT NULL CHECK (severity IN ('mild', 'moderate', 'severe', 'unknown')),
  source            text NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'entered_in_error')),
  recorded_by       uuid NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  last_confirmed_by uuid,
  last_confirmed_at timestamptz,
  version           integer NOT NULL DEFAULT 1,
  supersedes_id     uuid REFERENCES allergy(id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('allergy');

CREATE TABLE medication_statement (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  patient_id        uuid NOT NULL,
  medication        text NOT NULL,
  dose              text,
  frequency         text,
  is_anticoagulant  boolean NOT NULL DEFAULT false,
  source            text NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'entered_in_error')),
  recorded_by       uuid NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  last_confirmed_by uuid,
  last_confirmed_at timestamptz,
  version           integer NOT NULL DEFAULT 1,
  supersedes_id     uuid REFERENCES medication_statement(id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('medication_statement');

CREATE TABLE medical_condition (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  patient_id        uuid NOT NULL,
  condition         text NOT NULL,
  note              text,
  source            text NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'entered_in_error')),
  recorded_by       uuid NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  last_confirmed_by uuid,
  last_confirmed_at timestamptz,
  version           integer NOT NULL DEFAULT 1,
  supersedes_id     uuid REFERENCES medical_condition(id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('medical_condition');

CREATE TABLE history_review (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id       uuid NOT NULL,
  patient_id   uuid NOT NULL,
  encounter_id uuid,
  reviewed_by  uuid NOT NULL,
  reviewed_at  timestamptz NOT NULL DEFAULT now(),
  note         text,
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('history_review');
CREATE TRIGGER history_review_append_only BEFORE UPDATE OR DELETE ON history_review
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Emergency (break-glass) access to a patient outside the user's normal location scope (§20.3).
CREATE TABLE break_glass_grant (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id          uuid NOT NULL,
  staff_member_id uuid NOT NULL,
  patient_id      uuid NOT NULL,
  reason          text NOT NULL,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  review_note     text,
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('break_glass_grant');

-- ---------------------------------------------------------------- outbox
-- Reliable async work (prescription transmission, reminders, notifications). Payloads carry
-- ids only, never PHI, so this table is not tenant-filtered: the worker claims jobs across
-- tenants and then binds each job's transaction to that job's org.

CREATE TABLE outbox (
  id              bigserial PRIMARY KEY,
  org_id          uuid NOT NULL,
  topic           text NOT NULL,
  payload         jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  available_at    timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);
CREATE INDEX outbox_ready ON outbox (status, available_at);
