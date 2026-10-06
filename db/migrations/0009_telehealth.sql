-- 0009 Dental triage telehealth (docs/architecture/telehealth/handoff-v1.1.0.md, TH-001–TH-016).
--
-- Telehealth is a module of the same platform, not a second system: cases point at the shared
-- patient, appointment, encounter, consent, media and prescription rows. What is new here:
--   * a governed jurisdiction registry (global, read-only to the API) and dated credential evidence;
--   * the triage case, its versioned intake, location confirmations and eligibility decisions;
--   * the RTC session, its participants and events (no media is ever stored here);
--   * the remote assessment/disposition, which locks with the encounter when it is signed;
--   * follow-up tasks and completion metering.
-- Decisions, intakes, locations and events are append-only; corrections are new rows.

-- ---------------------------------------------------------------- jurisdiction registry (LIC-004, LIC-005)

-- Reference data loaded by the migrate script from config/jurisdiction_registry.json (50 states + D.C.).
CREATE TABLE jurisdiction (
  code  char(2) PRIMARY KEY,
  name  text NOT NULL,
  kind  text NOT NULL CHECK (kind IN ('state', 'district', 'synthetic'))
);

-- Rule versions. Never edited after activation: a new version supersedes the old one. A rule is
-- usable only when reviewed AND active AND inside its effective and review dates; anything else
-- evaluates to REVIEW_REQUIRED. Publication needs two different people (LIC-005).
CREATE TABLE jurisdiction_rule (
  id                         uuid PRIMARY KEY DEFAULT uuid_v7(),
  jurisdiction_code          char(2) NOT NULL REFERENCES jurisdiction(code),
  version                    integer NOT NULL,
  status                     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded', 'withdrawn')),
  review_status              text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'reviewed')),
  synthetic                  boolean NOT NULL DEFAULT false,
  allowed_purposes           text[] NOT NULL DEFAULT '{}',
  accepted_authority_types   text[] NOT NULL DEFAULT '{full_license}',
  provider_location_requires_local_authority boolean,
  effective_from             date,
  effective_to               date,
  review_expires_on          date,
  sources                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes                      text,
  proposed_by                text,
  approved_by                text,
  activated_at               timestamptz,
  digest                     text NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (jurisdiction_code, version),
  CHECK (allowed_purposes <@ ARRAY['synchronous_consult', 'asynchronous_review', 'audio_only_consult', 'prescribe_noncontrolled', 'prescribe_controlled']::text[]),
  CHECK (status <> 'active' OR (review_status = 'reviewed' AND effective_from IS NOT NULL AND proposed_by IS NOT NULL
                                 AND approved_by IS NOT NULL AND proposed_by <> approved_by AND activated_at IS NOT NULL))
);
CREATE UNIQUE INDEX jurisdiction_rule_one_active ON jurisdiction_rule (jurisdiction_code) WHERE status = 'active';

CREATE OR REPLACE FUNCTION jurisdiction_rule_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rule versions are never deleted; withdraw instead' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('active', 'superseded', 'withdrawn')
     AND (to_jsonb(NEW) - ARRAY['status']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status']) THEN
    RAISE EXCEPTION 'published rule versions are immutable; publish a new version' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jurisdiction_rule_immutable BEFORE UPDATE OR DELETE ON jurisdiction_rule FOR EACH ROW EXECUTE FUNCTION jurisdiction_rule_guard();

-- ---------------------------------------------------------------- credential evidence (LIC-001, LIC-006, LIC-007)

-- Primary-source verification has a freshness date; unknown freshness counts as stale for
-- telehealth. Alternate authorities (telehealth registration, temporary permit, compact privilege)
-- are typed so a rule must accept that exact type.
ALTER TABLE credential ADD COLUMN authority_type text NOT NULL DEFAULT 'full_license'
  CHECK (authority_type IN ('full_license', 'telehealth_registration', 'temporary_permit', 'compact_privilege'));
ALTER TABLE credential ADD COLUMN verification_expires_on date;
ALTER TABLE credential ADD COLUMN restrictions text[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------- scheduling: virtual resources

-- Telehealth reserves provider time and a virtual room, never an operatory. The existing
-- no_double_booking constraint then stops an in-office and a virtual visit sharing a clinician.
ALTER TABLE resource DROP CONSTRAINT resource_kind_check;
ALTER TABLE resource ADD CONSTRAINT resource_kind_check CHECK (kind IN ('scanner', 'sedation', 'imaging_room', 'equipment', 'virtual_room'));
ALTER TABLE appointment_resource DROP CONSTRAINT appointment_resource_resource_kind_check;
ALTER TABLE appointment_resource ADD CONSTRAINT appointment_resource_resource_kind_check
  CHECK (resource_kind IN ('provider', 'operatory', 'equipment', 'patient', 'virtual_room'));
ALTER TABLE appointment_type ADD COLUMN is_virtual boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- triage case (TH-007)

CREATE TABLE telehealth_case (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                 uuid NOT NULL REFERENCES organization(id),
  patient_id             uuid NOT NULL,
  location_id            uuid NOT NULL,           -- the practice location that owns the case
  status                 text NOT NULL DEFAULT 'intake_pending'
                         CHECK (status IN ('requested', 'intake_pending', 'eligibility_pending', 'ready', 'waiting', 'assigned',
                                           'assessment_active', 'disposition_pending', 'closed', 'cancelled', 'no_show', 'escalated', 'blocked')),
  mode                   text NOT NULL CHECK (mode IN ('on_demand', 'scheduled')),
  modality               text NOT NULL DEFAULT 'synchronous_consult' CHECK (modality IN ('synchronous_consult')),
  requested_via          text NOT NULL CHECK (requested_via IN ('portal', 'staff')),
  requested_by_portal_id uuid REFERENCES portal_account(id),
  requested_by_staff_id  uuid,
  urgency                text NOT NULL DEFAULT 'unassessed' CHECK (urgency IN ('emergency', 'urgent', 'priority', 'routine', 'unassessed')),
  emergency_screen       text NOT NULL DEFAULT 'not_screened' CHECK (emergency_screen IN ('not_screened', 'clear', 'priority', 'emergency')),
  assigned_provider_id   uuid,
  appointment_id         uuid,
  encounter_id           uuid,
  clinical_hold          text,                    -- why clinical actions are suspended (location change, consent withdrawal, credential change)
  emergency_plan         text,                    -- local emergency contacts and disconnect plan the provider recorded at clinical start
  identity_confirmed_by  uuid,
  identity_confirmed_at  timestamptz,
  -- Separate clocks (TH-009). Reconnects never reset them.
  requested_at           timestamptz NOT NULL DEFAULT now(),
  matched_at             timestamptz,
  joined_at              timestamptz,
  clinical_start_at      timestamptz,
  clinical_end_at        timestamptz,
  signed_at              timestamptz,
  closed_at              timestamptz,
  close_reason           text CHECK (close_reason IN ('completed', 'cancelled', 'no_show', 'blocked', 'emergency_handoff')),
  close_note             text,
  version                integer NOT NULL DEFAULT 1,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, location_id) REFERENCES location(org_id, id),
  FOREIGN KEY (org_id, assigned_provider_id) REFERENCES staff_member(org_id, id),
  FOREIGN KEY (org_id, appointment_id) REFERENCES appointment(org_id, id),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  CHECK ((requested_via = 'portal') = (requested_by_portal_id IS NOT NULL))
);
SELECT enable_tenant_rls('telehealth_case');
CREATE INDEX telehealth_case_open ON telehealth_case (org_id, status, requested_at);
CREATE UNIQUE INDEX telehealth_case_encounter ON telehealth_case (encounter_id) WHERE encounter_id IS NOT NULL;

CREATE TABLE telehealth_case_event (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id          uuid NOT NULL,
  patient_id      uuid NOT NULL,
  case_id         uuid NOT NULL,
  from_status     text,
  to_status       text NOT NULL,
  reason          text,
  actor_staff_id  uuid,
  actor_portal_id uuid,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, case_id) REFERENCES telehealth_case(org_id, id)
);
SELECT enable_tenant_rls('telehealth_case_event');
CREATE TRIGGER telehealth_case_event_append_only BEFORE UPDATE OR DELETE ON telehealth_case_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Appointments booked from a case keep the lineage (urgent booking, in-person conversion).
ALTER TABLE appointment ADD COLUMN telehealth_case_id uuid;
ALTER TABLE appointment ADD FOREIGN KEY (org_id, telehealth_case_id) REFERENCES telehealth_case(org_id, id);

-- ---------------------------------------------------------------- intake (TH-004)

-- Versioned: a correction is a new row that supersedes the old one. Medical history is not copied
-- here; the intake records which history versions were shown and what the patient says changed.
CREATE TABLE triage_intake (
  id                        uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                    uuid NOT NULL,
  patient_id                uuid NOT NULL,
  case_id                   uuid NOT NULL,
  version                   integer NOT NULL,
  supersedes_id             uuid REFERENCES triage_intake(id),
  source                    text NOT NULL CHECK (source IN ('patient_portal', 'staff_phone', 'staff_in_session')),
  recorded_by_staff_id      uuid,
  recorded_by_portal_id     uuid REFERENCES portal_account(id),
  recorded_at               timestamptz NOT NULL DEFAULT now(),
  patient_confirmed         boolean NOT NULL,
  protocol_version          text NOT NULL,
  protocol_validated        boolean NOT NULL,
  chief_complaint           text NOT NULL,
  onset                     text,
  duration                  text,
  progression               text NOT NULL CHECK (progression IN ('better', 'same', 'worse', 'unknown')),
  prior_episodes            text NOT NULL CHECK (prior_episodes IN ('yes', 'no', 'unknown')),
  triggering_event          text,
  pain_score                smallint CHECK (pain_score BETWEEN 0 AND 10),
  pain_triggers             text[] NOT NULL DEFAULT '{}',
  pain_affects_sleep        text NOT NULL CHECK (pain_affects_sleep IN ('yes', 'no', 'unknown')),
  relief_attempts           text,
  patient_indicated_tooth   text,                  -- as the patient said it; never a confirmed tooth
  patient_indicated_region  text NOT NULL,
  swelling_location         text,
  emergency_answers         jsonb NOT NULL,        -- { key: yes|no|unknown } for the protocol's questions
  priority_answers          jsonb NOT NULL,
  screen_result             text NOT NULL CHECK (screen_result IN ('clear', 'priority', 'emergency')),
  trauma_details            text,
  postop_procedure          text,
  postop_date               date,
  postop_instructions_followed text CHECK (postop_instructions_followed IN ('yes', 'no', 'unknown')),
  pregnancy                 text NOT NULL CHECK (pregnancy IN ('yes', 'no', 'unknown', 'not_applicable')),
  history_changes           text,
  reviewed_history_refs     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- ids of allergy/medication/condition versions shown
  interpreter_language      text,
  accessibility_needs       text,
  FOREIGN KEY (org_id, case_id) REFERENCES telehealth_case(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  UNIQUE (case_id, version),
  CHECK ((recorded_by_staff_id IS NULL) <> (recorded_by_portal_id IS NULL))
);
SELECT enable_tenant_rls('triage_intake');
CREATE TRIGGER triage_intake_append_only BEFORE UPDATE OR DELETE ON triage_intake FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- locations (LIC-002)

-- The patient's PHYSICAL location right now, as stated by the patient or confirmed aloud by the
-- provider. Never derived from mailing address, pharmacy or IP.
CREATE TABLE telehealth_location_confirmation (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL,
  patient_id         uuid NOT NULL,
  case_id            uuid NOT NULL,
  state              char(2) NOT NULL,
  address_text       text NOT NULL,
  callback_phone     text NOT NULL,
  stationary         boolean NOT NULL,
  confirmed_by_role  text NOT NULL CHECK (confirmed_by_role IN ('patient', 'provider', 'staff')),
  confirmed_by_staff_id  uuid,
  confirmed_by_portal_id uuid REFERENCES portal_account(id),
  confirmed_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, case_id) REFERENCES telehealth_case(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  CHECK ((confirmed_by_staff_id IS NULL) <> (confirmed_by_portal_id IS NULL))
);
SELECT enable_tenant_rls('telehealth_location_confirmation');
CREATE TRIGGER telehealth_location_append_only BEFORE UPDATE OR DELETE ON telehealth_location_confirmation FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE INDEX telehealth_location_case ON telehealth_location_confirmation (case_id, confirmed_at DESC);

CREATE TABLE telehealth_provider_location (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id          uuid NOT NULL REFERENCES organization(id),
  staff_member_id uuid NOT NULL,
  state           char(2) NOT NULL,
  confirmed_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, staff_member_id) REFERENCES staff_member(org_id, id)
);
SELECT enable_tenant_rls('telehealth_provider_location');
CREATE TRIGGER telehealth_provider_location_append_only BEFORE UPDATE OR DELETE ON telehealth_provider_location FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- eligibility decisions (LIC-003, LIC-009–LIC-011)

-- Immutable, evidence-bound decisions. A re-evaluation is a new row; nothing here is overridden.
CREATE TABLE eligibility_evaluation (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                uuid NOT NULL,
  patient_id            uuid NOT NULL,
  case_id               uuid NOT NULL,
  provider_id           uuid NOT NULL,
  encounter_id          uuid,
  purpose               text NOT NULL CHECK (purpose IN ('synchronous_consult', 'asynchronous_review', 'audio_only_consult', 'prescribe_noncontrolled', 'prescribe_controlled')),
  outcome               text NOT NULL CHECK (outcome IN ('ALLOW', 'DENY', 'REVIEW_REQUIRED')),
  reasons               text[] NOT NULL DEFAULT '{}',
  evaluated_at          timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  input_digest          text NOT NULL,
  patient_location_id   uuid,
  provider_location_id  uuid,
  rule_refs             jsonb NOT NULL DEFAULT '[]'::jsonb,
  credential_ids        uuid[] NOT NULL DEFAULT '{}',
  selected_credential_id uuid,
  requested_by          uuid NOT NULL,
  FOREIGN KEY (org_id, case_id) REFERENCES telehealth_case(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  CHECK (outcome = 'ALLOW' OR selected_credential_id IS NULL)
);
SELECT enable_tenant_rls('eligibility_evaluation');
CREATE TRIGGER eligibility_evaluation_append_only BEFORE UPDATE OR DELETE ON eligibility_evaluation FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE INDEX eligibility_evaluation_case ON eligibility_evaluation (case_id, evaluated_at DESC);

-- ---------------------------------------------------------------- RTC session (TH-007, TH-014)

-- No media lives here. Room names are opaque; join tokens are never stored.
CREATE TABLE telehealth_session (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL,
  patient_id         uuid NOT NULL,
  case_id            uuid NOT NULL,
  room_name          text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'lobby', 'active', 'reconnecting', 'ended', 'failed', 'revoked')),
  recording_status   text NOT NULL DEFAULT 'not_requested'
                     CHECK (recording_status IN ('not_requested', 'awaiting_consent', 'permitted', 'active', 'stopped', 'failed')),
  egress_id          text,
  -- The memory-only replay buffer is not built; the column records that it is off for this session.
  replay_buffer      text NOT NULL DEFAULT 'disabled' CHECK (replay_buffer = 'disabled'),
  start_evaluation_id uuid REFERENCES eligibility_evaluation(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  active_at          timestamptz,
  ended_at           timestamptz,
  end_reason         text,
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, case_id) REFERENCES telehealth_case(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('telehealth_session');
CREATE UNIQUE INDEX telehealth_session_one_live ON telehealth_session (case_id) WHERE status NOT IN ('ended', 'failed', 'revoked');

CREATE TABLE telehealth_participant (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL,
  patient_id         uuid NOT NULL,
  session_id         uuid NOT NULL,
  role               text NOT NULL CHECK (role IN ('patient', 'provider', 'coordinator', 'guardian', 'interpreter')),
  staff_member_id    uuid,
  portal_account_id  uuid REFERENCES portal_account(id),
  display_name       text NOT NULL,
  recording_consent  text NOT NULL DEFAULT 'not_asked' CHECK (recording_consent IN ('given', 'refused', 'not_asked')),
  admitted_at        timestamptz,
  admitted_by        uuid,
  connected          boolean NOT NULL DEFAULT false,
  last_event_at      timestamptz,
  joined_seconds     integer NOT NULL DEFAULT 0,
  removed_at         timestamptz,
  removed_reason     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, session_id) REFERENCES telehealth_session(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('telehealth_participant');

CREATE TABLE telehealth_session_event (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id           uuid NOT NULL,
  patient_id       uuid NOT NULL,
  session_id       uuid NOT NULL,
  participant_id   uuid,
  kind             text NOT NULL,
  detail           text,
  vendor_event_id  text,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, session_id) REFERENCES telehealth_session(org_id, id)
);
SELECT enable_tenant_rls('telehealth_session_event');
CREATE UNIQUE INDEX telehealth_session_event_vendor ON telehealth_session_event (vendor_event_id) WHERE vendor_event_id IS NOT NULL;
CREATE TRIGGER telehealth_session_event_append_only BEFORE UPDATE OR DELETE ON telehealth_session_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- RTC webhooks arrive without a tenant; resolve the room's owner (like erx_resolve_org).
CREATE OR REPLACE FUNCTION rtc_resolve_room(p_room text) RETURNS TABLE (org_id uuid, session_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT org_id, id FROM telehealth_session WHERE room_name = p_room
$$;

-- ---------------------------------------------------------------- remote assessment and disposition (TH-006, TH-008)

-- A chart entry of the shared encounter: editable while the visit is open, frozen when it is
-- signed (protect_chart_table), amended only by superseding rows.
CREATE TABLE telehealth_assessment (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                 uuid NOT NULL,
  patient_id             uuid NOT NULL,
  encounter_id           uuid NOT NULL,
  case_id                uuid NOT NULL,
  assessment_modality    text NOT NULL CHECK (assessment_modality IN ('synchronous_video', 'asynchronous_photo', 'audio_only')),
  disposition            text NOT NULL CHECK (disposition IN ('emergency_transfer', 'urgent_in_person', 'scheduled_in_person', 'specialist_referral',
                                                              'remote_follow_up', 'self_care_with_safety_net', 'insufficient_information')),
  urgency                text NOT NULL CHECK (urgency IN ('emergency', 'urgent', 'priority', 'routine', 'unassessed')),
  rationale              text NOT NULL,
  limitations            text NOT NULL,
  evidence_quality       text NOT NULL CHECK (evidence_quality IN ('adequate', 'limited', 'poor', 'not_assessable')),
  recommended_timing     text,
  destination            text,
  instructions           text NOT NULL,
  patient_understanding  text NOT NULL CHECK (patient_understanding IN ('confirmed', 'unclear', 'not_confirmed')),
  return_precautions     text NOT NULL,
  follow_up_owner_id     uuid,
  emergency_handoff      text,
  -- Evidence references frozen at signing (handoff: signed hash includes consent/location/evaluation).
  location_confirmation_id uuid,
  eligibility_evaluation_id uuid,
  consent_signature_ids  uuid[] NOT NULL DEFAULT '{}',
  participant_ids        uuid[] NOT NULL DEFAULT '{}',
  recorded_by            uuid NOT NULL,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  updated_at             timestamptz,
  version                integer NOT NULL DEFAULT 1,
  supersedes_id          uuid REFERENCES telehealth_assessment(id),
  amendment_id           uuid,
  locked_at              timestamptz,
  entered_in_error       boolean NOT NULL DEFAULT false,
  void_reason            text,
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, case_id) REFERENCES telehealth_case(org_id, id)
);
SELECT protect_chart_table('telehealth_assessment', '{}');

-- Remote findings (TH-005): how the finding was observed, from what, and how well.
ALTER TABLE clinical_finding ADD COLUMN assessment_modality text NOT NULL DEFAULT 'in_person'
  CHECK (assessment_modality IN ('in_person', 'synchronous_video', 'asynchronous_photo', 'audio_only'));
ALTER TABLE clinical_finding ADD COLUMN source_media_id uuid;
ALTER TABLE clinical_finding ADD COLUMN remote_exam_limitations text;
ALTER TABLE clinical_finding ADD COLUMN evidence_quality text CHECK (evidence_quality IN ('adequate', 'limited', 'poor', 'not_assessable'));
ALTER TABLE clinical_finding ADD CONSTRAINT clinical_finding_remote_limits
  CHECK (assessment_modality = 'in_person' OR (remote_exam_limitations IS NOT NULL AND evidence_quality IS NOT NULL));

-- Snapshot provenance on the shared media record (selected PNG frames only; never video).
ALTER TABLE media_object ADD COLUMN source_session_id uuid;
ALTER TABLE media_object ADD COLUMN frame_captured_at timestamptz;
ALTER TABLE media_object ADD COLUMN quality_note text;

-- Patient-sent photos wait here (encrypted, checksummed) until a clinician attaches them to the
-- visit's encounter as media, or rejects them. Not part of the chart until attached.
CREATE TABLE telehealth_upload (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL,
  patient_id         uuid NOT NULL,
  case_id            uuid NOT NULL,
  storage_key        text NOT NULL,
  content_type       text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  byte_size          bigint NOT NULL,
  sha256             text NOT NULL,
  body_site          text NOT NULL,
  acquired_on        date NOT NULL,
  patient_authorized boolean NOT NULL CHECK (patient_authorized),
  uploaded_by_portal_id uuid REFERENCES portal_account(id),
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached', 'rejected')),
  media_object_id    uuid,
  reviewed_by        uuid,
  reviewed_at        timestamptz,
  FOREIGN KEY (org_id, case_id) REFERENCES telehealth_case(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('telehealth_upload');

-- ---------------------------------------------------------------- follow-up and metering (TH-008, TH-009)

CREATE TABLE telehealth_task (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id           uuid NOT NULL,
  patient_id       uuid NOT NULL,
  case_id          uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('book_in_person', 'referral', 'erx_failure', 'patient_contact', 'emergency_handoff', 'sign_note', 'other')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'failed', 'unable_to_contact', 'cancelled')),
  owner_staff_id   uuid NOT NULL,
  destination      text,
  due_note         text,
  note             text,
  outcome_note     text,
  appointment_id   uuid,
  prescription_id  uuid,
  dedupe_key       text UNIQUE,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_by     uuid,
  completed_at     timestamptz,
  version          integer NOT NULL DEFAULT 1,
  FOREIGN KEY (org_id, case_id) REFERENCES telehealth_case(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, owner_staff_id) REFERENCES staff_member(org_id, id)
);
SELECT enable_tenant_rls('telehealth_task');
CREATE INDEX telehealth_task_open ON telehealth_task (org_id, status, owner_staff_id);

-- One completion meter event per tenant + encounter + meter version (no commercial terms here).
CREATE TABLE telehealth_meter_event (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL REFERENCES organization(id),
  case_id           uuid NOT NULL,
  encounter_id      uuid NOT NULL,
  meter_version     text NOT NULL,
  consult_seconds   integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, encounter_id, meter_version)
);
SELECT enable_tenant_rls('telehealth_meter_event');
CREATE TRIGGER telehealth_meter_event_append_only BEFORE UPDATE OR DELETE ON telehealth_meter_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Prescriptions written during remote care carry their own prescribing evaluation (TH-010).
ALTER TABLE prescription ADD COLUMN telehealth_evaluation_id uuid;

-- ---------------------------------------------------------------- portal: telehealth scope and the second wall

ALTER TABLE portal_access_grant DROP CONSTRAINT portal_access_grant_scopes_check;
ALTER TABLE portal_access_grant ADD CONSTRAINT portal_access_grant_scopes_check
  CHECK (scopes <@ ARRAY['appointments', 'visits', 'treatment_plan', 'health_record', 'prescriptions',
                         'pharmacies', 'messages', 'forms', 'requests', 'billing', 'telehealth']::text[]);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['telehealth_case', 'telehealth_case_event', 'triage_intake', 'telehealth_location_confirmation',
                           'eligibility_evaluation', 'telehealth_session', 'telehealth_participant', 'telehealth_session_event',
                           'telehealth_assessment', 'telehealth_upload', 'telehealth_task'] LOOP
    EXECUTE format('CREATE POLICY portal_scope ON %I AS RESTRICTIVE USING (app_portal_allows(patient_id)) WITH CHECK (app_portal_allows(patient_id))', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- grants

GRANT SELECT ON jurisdiction, jurisdiction_rule TO teeth_app;
GRANT SELECT, INSERT, UPDATE ON telehealth_case, telehealth_session, telehealth_participant, telehealth_assessment,
  telehealth_upload, telehealth_task TO teeth_app;
GRANT SELECT, INSERT ON telehealth_case_event, triage_intake, telehealth_location_confirmation, telehealth_provider_location,
  eligibility_evaluation, telehealth_session_event, telehealth_meter_event TO teeth_app;
GRANT EXECUTE ON FUNCTION rtc_resolve_room(text) TO teeth_app;
REVOKE EXECUTE ON FUNCTION rtc_resolve_room(text) FROM PUBLIC;
