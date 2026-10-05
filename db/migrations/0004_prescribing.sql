-- 0004 prescribing (§15). We own the prescription record, the patient's pharmacy choice and
-- the transmission history; the certified partner owns the pharmacy network, NCPDP SCRIPT
-- transport and (later) EPCS signing.

-- Cache of pharmacy directory entries returned by the partner. Public business data, no PHI.
CREATE TABLE pharmacy (
  id            text PRIMARY KEY,          -- partner's pharmacy id
  ncpdp_id      text NOT NULL,
  name          text NOT NULL,
  address_line  text NOT NULL,
  city          text NOT NULL,
  state         char(2) NOT NULL,
  zip           text NOT NULL,
  phone         text,
  open_24h      boolean NOT NULL DEFAULT false,
  epcs_capable  boolean NOT NULL DEFAULT false,
  mail_order    boolean NOT NULL DEFAULT false,
  refreshed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patient_pharmacy_preference (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id      uuid NOT NULL,
  patient_id  uuid NOT NULL,
  pharmacy_id text NOT NULL REFERENCES pharmacy(id),
  rank        text NOT NULL CHECK (rank IN ('primary', 'alternate', '24_hour', 'mail_order')),
  active      boolean NOT NULL DEFAULT true,
  source      text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff', 'patient_portal')),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_by  uuid,
  removed_at  timestamptz,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
CREATE UNIQUE INDEX pharmacy_pref_one_per_rank ON patient_pharmacy_preference (patient_id, rank) WHERE active;
SELECT enable_tenant_rls('patient_pharmacy_preference');

CREATE TABLE prescription (
  id                       uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                   uuid NOT NULL,
  patient_id               uuid NOT NULL,
  encounter_id             uuid,
  status                   text NOT NULL DEFAULT 'DRAFT'
                           CHECK (status IN ('DRAFT', 'SIGNED', 'QUEUED', 'SENT', 'ACCEPTED', 'ERROR', 'CANCELLED')),
  drug_key                 text NOT NULL,
  drug_display             text NOT NULL,
  sig                      text NOT NULL,
  quantity                 numeric(10, 2) NOT NULL,
  quantity_unit            text NOT NULL,
  days_supply              integer NOT NULL,
  refills                  integer NOT NULL,
  substitution_allowed     boolean NOT NULL DEFAULT true,
  indication               text NOT NULL,
  controlled_schedule      text CHECK (controlled_schedule IN ('II', 'III', 'IV', 'V')),
  prepared_by              uuid NOT NULL,
  prepared_at              timestamptz NOT NULL DEFAULT now(),
  -- set at signing
  signed_by                uuid,
  signed_at                timestamptz,
  prescriber_credential_id uuid,
  step_up_method           text,
  pharmacy_preference_id   uuid,
  pharmacy_snapshot        jsonb,         -- name/address/NCPDP as of transmission (§15.2)
  alerts                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  acknowledged_alert_ids   text[] NOT NULL DEFAULT '{}',
  content_hash             text,
  idempotency_key          uuid,
  partner_prescription_id  text,
  version                  integer NOT NULL DEFAULT 1,
  locked_at                timestamptz,
  UNIQUE (org_id, id),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('prescription');
CREATE TRIGGER prescription_locked BEFORE UPDATE OR DELETE ON prescription
  FOR EACH ROW EXECUTE FUNCTION locked_content_guard('status', 'partner_prescription_id', 'version');
CREATE INDEX prescription_patient ON prescription (org_id, patient_id, prepared_at DESC);

CREATE TABLE prescription_event (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id           uuid NOT NULL,
  prescription_id  uuid NOT NULL,
  status           text NOT NULL,
  detail           text,
  source           text NOT NULL CHECK (source IN ('app', 'worker', 'partner_webhook')),
  partner_event_id text,
  actor_id         uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, prescription_id) REFERENCES prescription(org_id, id)
);
CREATE UNIQUE INDEX prescription_event_partner ON prescription_event (partner_event_id) WHERE partner_event_id IS NOT NULL;
SELECT enable_tenant_rls('prescription_event');
CREATE TRIGGER prescription_event_append_only BEFORE UPDATE OR DELETE ON prescription_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Partner webhooks arrive without a tenant; this definer function resolves which org owns a
-- partner prescription id so the handler can bind its transaction to that org.
CREATE OR REPLACE FUNCTION erx_resolve_org(p_partner_rx text) RETURNS TABLE (org_id uuid, prescription_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT org_id, id FROM prescription WHERE partner_prescription_id = p_partner_rx
$$;

-- ---------------------------------------------------------------- licensed code sets
-- CDT and SNODENT are licensed by the ADA. These tables ship empty and are loaded per licensed
-- deployment by scripts/load-code-set; their content is never committed to the repository.
CREATE TABLE billing_code (
  code_system  text NOT NULL CHECK (code_system IN ('CDT')),
  version      text NOT NULL,            -- e.g. CDT 2027
  code         text NOT NULL,
  descriptor   text NOT NULL,
  valid_from   date NOT NULL,
  valid_to     date,
  PRIMARY KEY (code_system, version, code)
);
CREATE TABLE billing_code_rule (
  procedure_concept text NOT NULL,
  version           text NOT NULL,
  surface_count     smallint,              -- null = any
  tooth_class       text,                  -- null = any
  code              text NOT NULL,
  PRIMARY KEY (procedure_concept, version, code)
);
