-- 0003 clinical core: anatomy, encounters, chart entries, signing and amendments (§8-§13).
--
-- Immutability model
--   * Every chart entry belongs to an encounter (a visit), which is what the chart's visit
--     layers are built from.
--   * While the encounter is open, entries are drafts: editable in place with optimistic
--     versioning, every edit audited.
--   * Signing stamps locked_at on every entry of the encounter. From then on the database
--     refuses UPDATE or DELETE of the clinical content of that row, whoever asks.
--   * An amendment never edits a locked row: it inserts a new row whose supersedes_id points
--     at the old one, so the signed version stays readable forever.

-- ---------------------------------------------------------------- anatomy (§9)

CREATE TABLE dental_position (
  id                   text PRIMARY KEY,         -- stable code, e.g. P30, DK
  dentition            text NOT NULL CHECK (dentition IN ('permanent', 'primary')),
  universal            text NOT NULL UNIQUE,
  fdi                  text NOT NULL UNIQUE,
  palmer               text NOT NULL,
  arch                 text NOT NULL,
  quadrant             smallint NOT NULL,
  position_in_quadrant smallint NOT NULL,
  tooth_class          text NOT NULL,
  name                 text NOT NULL
);

-- A patient's actual tooth (or implant, or supernumerary). Its UUID is the key; the displayed
-- tooth number is only a label from dental_position.
CREATE TABLE tooth_instance (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL,
  patient_id         uuid NOT NULL,
  dental_position_id text REFERENCES dental_position(id),
  label              text,                        -- for supernumerary teeth without a standard slot
  kind               text NOT NULL DEFAULT 'natural' CHECK (kind IN ('natural', 'supernumerary', 'implant', 'pontic')),
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  retired_at         timestamptz,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  CHECK (dental_position_id IS NOT NULL OR label IS NOT NULL)
);
CREATE UNIQUE INDEX tooth_instance_slot ON tooth_instance (patient_id, dental_position_id, kind) WHERE retired_at IS NULL;
SELECT enable_tenant_rls('tooth_instance');

-- ---------------------------------------------------------------- encounter (§8)

CREATE TABLE encounter (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL,
  patient_id         uuid NOT NULL,
  location_id        uuid NOT NULL,
  appointment_id     uuid,
  status             text NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'VERIFIED', 'SIGNED', 'AMENDMENT_REQUIRED', 'AMENDING')),
  chief_complaint    text,
  opened_by          uuid NOT NULL,
  opened_at          timestamptz NOT NULL DEFAULT now(),
  verified_by        uuid,
  verified_at        timestamptz,
  signed_by          uuid,
  signed_at          timestamptz,
  current_version_no integer NOT NULL DEFAULT 0,
  version            integer NOT NULL DEFAULT 1,
  updated_by         uuid,
  updated_at         timestamptz,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, location_id) REFERENCES location(org_id, id)
);
SELECT enable_tenant_rls('encounter');
CREATE INDEX encounter_patient ON encounter (org_id, patient_id, opened_at DESC);

CREATE OR REPLACE FUNCTION encounter_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'encounters are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('SIGNED', 'AMENDING') AND NEW.chief_complaint IS DISTINCT FROM OLD.chief_complaint THEN
    RAISE EXCEPTION 'signed encounter header is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'SIGNED' AND NEW.status NOT IN ('SIGNED', 'AMENDING') THEN
    RAISE EXCEPTION 'signed encounter can only move to AMENDING' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER encounter_guard BEFORE UPDATE OR DELETE ON encounter FOR EACH ROW EXECUTE FUNCTION encounter_guard();

-- ---------------------------------------------------------------- immutability triggers

-- Blocks writes to entries of an encounter that is not open for charting (e.g. VERIFIED or
-- SIGNED). The lock operation itself, and post-lock status changes (checked by
-- locked_content_guard), are let through.
CREATE OR REPLACE FUNCTION assert_encounter_writable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.locked_at IS NOT NULL OR NEW.locked_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  SELECT status INTO v_status FROM encounter WHERE id = NEW.encounter_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'encounter % not found', NEW.encounter_id USING ERRCODE = '23503';
  END IF;
  IF v_status NOT IN ('DRAFT', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'AMENDMENT_REQUIRED', 'AMENDING') THEN
    RAISE EXCEPTION 'encounter is % and not open for charting', v_status USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- After locked_at is set, only the columns named in the trigger arguments may change
-- (workflow status on plan items and prescriptions); everything clinical is frozen.
-- Deletes are never allowed on clinical rows.
CREATE OR REPLACE FUNCTION locked_content_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- With no trigger arguments TG_ARGV is NULL, and jsonb - NULL is NULL, which would make
  -- the comparison below always pass; default to an empty list so every column is frozen.
  v_mutable text[] := CASE WHEN TG_NARGS = 0 THEN '{}'::text[] ELSE TG_ARGV::text[] END;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'clinical rows are never deleted (%); void or amend instead', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  IF OLD.locked_at IS NOT NULL THEN
    IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
      RAISE EXCEPTION 'signed clinical record in % is immutable; create an amendment', TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Applies the standard columns' guards to a chart-entry table.
CREATE OR REPLACE FUNCTION protect_chart_table(tbl regclass, mutable_after_lock text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_args text;
BEGIN
  SELECT coalesce(string_agg(quote_literal(c), ', '), '') INTO v_args FROM unnest(mutable_after_lock) c;
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION assert_encounter_writable()',
                 tbl::text || '_writable', tbl);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION locked_content_guard(%s)',
                 tbl::text || '_locked', tbl, v_args);
  PERFORM enable_tenant_rls(tbl);
END $$;

-- ---------------------------------------------------------------- chart entries (§10)
-- Shared columns on every entry:
--   org_id, patient_id, encounter_id      where and for whom
--   tooth_instance_id, surfaces           what anatomy (surfaces stored in canonical M O I D B F L order)
--   recorded_by/at, updated_by/at         who and when
--   version, supersedes_id, amendment_id  versioning and amendment lineage
--   locked_at                             set when the encounter is signed
--   entered_in_error, void_reason         retraction without deletion

CREATE TABLE encounter_note (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  patient_id        uuid NOT NULL,
  encounter_id      uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('clinical', 'hpi', 'postop_instructions', 'followup_plan')),
  body              text NOT NULL,
  recorded_by       uuid NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  updated_at        timestamptz,
  version           integer NOT NULL DEFAULT 1,
  supersedes_id     uuid REFERENCES encounter_note(id),
  amendment_id      uuid,
  locked_at         timestamptz,
  entered_in_error  boolean NOT NULL DEFAULT false,
  void_reason       text,
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id)
);
SELECT protect_chart_table('encounter_note', '{}');

CREATE TABLE clinical_finding (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  patient_id        uuid NOT NULL,
  encounter_id      uuid NOT NULL,
  tooth_instance_id uuid,
  surfaces          text[] NOT NULL DEFAULT '{}',
  category          text NOT NULL CHECK (category IN ('anatomic', 'pathology')),
  finding_type      text NOT NULL,
  certainty         text NOT NULL CHECK (certainty IN ('suspected', 'probable', 'confirmed', 'historical', 'resolved')),
  note              text,
  verified_by       uuid,
  verified_at       timestamptz,
  recorded_by       uuid NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  updated_at        timestamptz,
  version           integer NOT NULL DEFAULT 1,
  supersedes_id     uuid REFERENCES clinical_finding(id),
  amendment_id      uuid,
  locked_at         timestamptz,
  entered_in_error  boolean NOT NULL DEFAULT false,
  void_reason       text,
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id)
);
SELECT protect_chart_table('clinical_finding', '{}');
CREATE INDEX clinical_finding_patient ON clinical_finding (org_id, patient_id);

CREATE TABLE existing_restoration (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  patient_id        uuid NOT NULL,
  encounter_id      uuid NOT NULL,
  tooth_instance_id uuid NOT NULL,
  surfaces          text[] NOT NULL DEFAULT '{}',
  treatment_type    text NOT NULL,
  material          text,
  note              text,
  recorded_by       uuid NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  updated_at        timestamptz,
  version           integer NOT NULL DEFAULT 1,
  supersedes_id     uuid REFERENCES existing_restoration(id),
  amendment_id      uuid,
  locked_at         timestamptz,
  entered_in_error  boolean NOT NULL DEFAULT false,
  void_reason       text,
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id)
);
SELECT protect_chart_table('existing_restoration', '{}');
CREATE INDEX existing_restoration_patient ON existing_restoration (org_id, patient_id);

CREATE TABLE diagnosis (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  patient_id        uuid NOT NULL,
  encounter_id      uuid NOT NULL,
  tooth_instance_id uuid,
  surfaces          text[] NOT NULL DEFAULT '{}',
  label             text NOT NULL,
  concept_system    text NOT NULL DEFAULT 'internal' CHECK (concept_system IN ('snodent', 'snomed', 'icd10cm', 'internal')),
  concept_code      text,
  certainty         text NOT NULL CHECK (certainty IN ('suspected', 'probable', 'confirmed', 'historical', 'resolved')),
  finding_ids       uuid[] NOT NULL DEFAULT '{}',
  note              text,
  recorded_by       uuid NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  updated_at        timestamptz,
  version           integer NOT NULL DEFAULT 1,
  supersedes_id     uuid REFERENCES diagnosis(id),
  amendment_id      uuid,
  locked_at         timestamptz,
  entered_in_error  boolean NOT NULL DEFAULT false,
  void_reason       text,
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id)
);
SELECT protect_chart_table('diagnosis', '{}');

CREATE TABLE treatment_plan (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id      uuid NOT NULL,
  patient_id  uuid NOT NULL,
  name        text NOT NULL DEFAULT 'Treatment plan',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
CREATE UNIQUE INDEX treatment_plan_one_active ON treatment_plan (patient_id) WHERE status = 'active';
SELECT enable_tenant_rls('treatment_plan');

-- Plan items outlive the visit that proposed them: their clinical content locks at signing,
-- but their workflow status (accepted, scheduled, fulfilled...) keeps moving afterwards.
CREATE TABLE planned_procedure (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id              uuid NOT NULL,
  patient_id          uuid NOT NULL,
  encounter_id        uuid NOT NULL,
  treatment_plan_id   uuid NOT NULL,
  tooth_instance_id   uuid,
  surfaces            text[] NOT NULL DEFAULT '{}',
  procedure_concept   text NOT NULL,
  status              text NOT NULL DEFAULT 'PROPOSED'
                      CHECK (status IN ('PROPOSED', 'PLANNED', 'PATIENT_ACCEPTED', 'SCHEDULED', 'DECLINED', 'DEFERRED',
                                        'CANCELLED', 'REFERRED', 'FULFILLED', 'VOIDED_WITH_REASON')),
  phase               smallint NOT NULL DEFAULT 1,
  priority            text NOT NULL DEFAULT 'routine',
  finding_ids         uuid[] NOT NULL DEFAULT '{}',
  diagnosis_ids       uuid[] NOT NULL DEFAULT '{}',
  fulfilled_by        uuid,
  status_changed_by   uuid,
  status_changed_at   timestamptz,
  status_reason       text,
  note                text,
  recorded_by         uuid NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  updated_at          timestamptz,
  version             integer NOT NULL DEFAULT 1,
  supersedes_id       uuid REFERENCES planned_procedure(id),
  amendment_id        uuid,
  locked_at           timestamptz,
  entered_in_error    boolean NOT NULL DEFAULT false,
  void_reason         text,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, treatment_plan_id) REFERENCES treatment_plan(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id)
);
-- Status columns stay mutable after lock; the writability check is skipped for locked rows.
SELECT protect_chart_table('planned_procedure',
  '{status,fulfilled_by,status_changed_by,status_changed_at,status_reason,version}');
CREATE INDEX planned_procedure_patient ON planned_procedure (org_id, patient_id, status);

-- Append-only trail of plan status changes (accepted, declined, scheduled, fulfilled).
CREATE TABLE planned_procedure_event (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id               uuid NOT NULL,
  planned_procedure_id uuid NOT NULL,
  from_status          text NOT NULL,
  to_status            text NOT NULL,
  reason               text,
  actor_id             uuid NOT NULL,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, planned_procedure_id) REFERENCES planned_procedure(org_id, id)
);
SELECT enable_tenant_rls('planned_procedure_event');
CREATE TRIGGER planned_procedure_event_append_only BEFORE UPDATE OR DELETE ON planned_procedure_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Work actually performed (§10.3). Common annotation fields are real columns; fields specific
-- to one procedure concept (canals, implant lot...) go in concept_details, whose keys the API
-- validates against the concept catalog.
CREATE TABLE procedure_occurrence (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                 uuid NOT NULL,
  patient_id             uuid NOT NULL,
  encounter_id           uuid NOT NULL,
  tooth_instance_id      uuid,
  surfaces               text[] NOT NULL DEFAULT '{}',
  procedure_concept      text NOT NULL,
  planned_procedure_id   uuid,
  status                 text NOT NULL DEFAULT 'IN_PROGRESS'
                         CHECK (status IN ('IN_PROGRESS', 'PERFORMED', 'PARTIALLY_COMPLETED', 'FAILED', 'CLINICALLY_VERIFIED',
                                           'SIGNED', 'CLAIMED', 'REPLACED', 'AMENDED', 'VOIDED_WITH_REASON')),
  technique              text,
  isolation              text,
  shade                  text,
  liner_base             text,
  matrix_system          text,
  bonding_system         text,
  cement                 text,
  materials_removed      text,
  contact_verified       boolean,
  occlusion_verified     boolean,
  hemostasis             boolean,
  complications          text,
  lab_case_reference     text,
  postop_instructions    boolean,
  concept_details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  performed_by           uuid[] NOT NULL,
  assisted_by            uuid[] NOT NULL DEFAULT '{}',
  started_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  verified_by            uuid,
  verified_at            timestamptz,
  -- Billing projection (CDT, versioned by date of service). Suggested from the licensed code
  -- table when loaded; editable by billing without touching clinical columns.
  billing_code           text,
  billing_code_version   text,
  note                   text,
  recorded_by            uuid NOT NULL,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  updated_at             timestamptz,
  version                integer NOT NULL DEFAULT 1,
  supersedes_id          uuid REFERENCES procedure_occurrence(id),
  amendment_id           uuid,
  locked_at              timestamptz,
  entered_in_error       boolean NOT NULL DEFAULT false,
  void_reason            text,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id),
  FOREIGN KEY (org_id, planned_procedure_id) REFERENCES planned_procedure(org_id, id)
);
-- After signing only the claim status (Phase 5) and billing projection may change.
SELECT protect_chart_table('procedure_occurrence', '{status,billing_code,billing_code_version}');
CREATE INDEX procedure_occurrence_patient ON procedure_occurrence (org_id, patient_id);

CREATE TABLE procedure_material (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                  uuid NOT NULL,
  patient_id              uuid NOT NULL,
  encounter_id            uuid NOT NULL,
  procedure_occurrence_id uuid NOT NULL,
  action                  text NOT NULL CHECK (action IN ('placed', 'removed')),
  material                text NOT NULL,
  product                 text,
  lot                     text,
  recorded_by             uuid NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  locked_at               timestamptz,
  FOREIGN KEY (org_id, procedure_occurrence_id) REFERENCES procedure_occurrence(org_id, id)
);
SELECT protect_chart_table('procedure_material', '{}');

-- Local anesthetic and other in-office medication administration (§10.9).
CREATE TABLE anesthetic_event (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                  uuid NOT NULL,
  patient_id              uuid NOT NULL,
  encounter_id            uuid NOT NULL,
  procedure_occurrence_id uuid,
  drug                    text NOT NULL,
  concentration           text,
  vasoconstrictor         text,
  amount_ml               numeric(5, 2) NOT NULL,
  route                   text NOT NULL,
  site                    text,
  administered_at         timestamptz NOT NULL,
  administered_by         uuid NOT NULL,
  adverse_event           text,
  recorded_by             uuid NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  version                 integer NOT NULL DEFAULT 1,
  supersedes_id           uuid REFERENCES anesthetic_event(id),
  amendment_id            uuid,
  locked_at               timestamptz,
  entered_in_error        boolean NOT NULL DEFAULT false,
  void_reason             text,
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id)
);
SELECT protect_chart_table('anesthetic_event', '{}');

-- ---------------------------------------------------------------- media (§18)
-- Radiographs and photos belong to a visit, which is what anchors each chart layer.
CREATE TABLE media_object (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL,
  patient_id         uuid NOT NULL,
  encounter_id       uuid NOT NULL,
  modality           text NOT NULL,
  content_type       text NOT NULL,
  storage_key        text NOT NULL,      -- opaque object key; contains no PHI
  byte_size          bigint NOT NULL,
  sha256             text NOT NULL,
  tooth_instance_ids uuid[] NOT NULL DEFAULT '{}',
  acquired_at        timestamptz NOT NULL,
  original_source    text NOT NULL DEFAULT 'upload',
  recorded_by        uuid NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  locked_at          timestamptz,
  entered_in_error   boolean NOT NULL DEFAULT false,
  void_reason        text,
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id)
);
SELECT protect_chart_table('media_object', '{}');

-- ---------------------------------------------------------------- signing (§13)

CREATE TABLE encounter_version (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  encounter_id      uuid NOT NULL,
  version_no        integer NOT NULL,
  canonical_payload text NOT NULL,     -- exact bytes that were hashed and signed
  content_hash      text NOT NULL,     -- SHA-256 hex of canonical_payload
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (encounter_id, version_no),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id)
);
SELECT enable_tenant_rls('encounter_version');
CREATE TRIGGER encounter_version_append_only BEFORE UPDATE OR DELETE ON encounter_version
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE attestation (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id               uuid NOT NULL,
  encounter_id         uuid NOT NULL,
  encounter_version_id uuid NOT NULL,
  signer_staff_id      uuid NOT NULL,
  signer_display       text NOT NULL,
  credential_id        uuid NOT NULL,
  credential_title     text,
  role_template        text NOT NULL,
  auth_methods         text[] NOT NULL,
  step_up_method       text NOT NULL,
  step_up_at           timestamptz NOT NULL,
  session_id           uuid NOT NULL,
  signed_at            timestamptz NOT NULL DEFAULT now(),
  content_hash         text NOT NULL,
  signature            text NOT NULL,
  key_id               text NOT NULL,
  algorithm            text NOT NULL,
  FOREIGN KEY (org_id, encounter_version_id) REFERENCES encounter_version(org_id, id)
);
SELECT enable_tenant_rls('attestation');
CREATE TRIGGER attestation_append_only BEFORE UPDATE OR DELETE ON attestation
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE amendment (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  encounter_id      uuid NOT NULL,
  signed_version_id uuid NOT NULL,     -- the version being amended
  reason            text NOT NULL,
  started_by        uuid NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'signed')),
  changed_fields    jsonb,
  amended_by        uuid,
  amended_at        timestamptz,
  new_version_id    uuid,
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, signed_version_id) REFERENCES encounter_version(org_id, id)
);
SELECT enable_tenant_rls('amendment');
CREATE UNIQUE INDEX amendment_one_open ON amendment (encounter_id) WHERE status = 'open';

CREATE OR REPLACE FUNCTION amendment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'signed' THEN
    RAISE EXCEPTION 'signed amendment is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.reason IS DISTINCT FROM OLD.reason OR NEW.signed_version_id IS DISTINCT FROM OLD.signed_version_id THEN
    RAISE EXCEPTION 'amendment reason and base version are fixed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amendment_guard BEFORE UPDATE OR DELETE ON amendment FOR EACH ROW EXECUTE FUNCTION amendment_guard();
