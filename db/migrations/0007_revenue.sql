-- 0007 revenue cycle (MASTER_SPEC §17): fee schedules, payers and benefits, eligibility,
-- an append-only patient ledger, payments, claims and remittance posting.
--
-- Money is integer cents. Nothing financial is edited in place: corrections are new rows
-- (a reversal entry, a newer fee, a new claim event), so the ledger always explains itself.

-- ---------------------------------------------------------------- code sets
-- CDT is licensed by the ADA and is loaded per deployment from the licensed file (never
-- committed). Development and tests use an invented SYNTHETIC set whose codes cannot be
-- mistaken for real ones. Each code carries the benefit category payers cover it under.

ALTER TABLE billing_code DROP CONSTRAINT billing_code_code_system_check;
ALTER TABLE billing_code ADD CONSTRAINT billing_code_code_system_check CHECK (code_system IN ('CDT', 'SYNTHETIC'));
ALTER TABLE billing_code ADD COLUMN category text NOT NULL DEFAULT 'basic'
  CHECK (category IN ('diagnostic', 'preventive', 'basic', 'endodontic', 'periodontic', 'oral_surgery', 'major', 'implant', 'orthodontic'));

-- One code can serve several tooth classes or surface counts (e.g. canine and incisor), so a
-- rule is identified by all of its conditions, not just concept and code.
ALTER TABLE billing_code_rule DROP CONSTRAINT billing_code_rule_pkey;
CREATE UNIQUE INDEX billing_code_rule_key ON billing_code_rule (procedure_concept, version, coalesce(surface_count, -1), coalesce(tooth_class, ''), code);

-- Immutable guard for append-only financial tables.
CREATE OR REPLACE FUNCTION append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; post a correcting entry instead', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

-- Staff-only data with no patient column: hidden from portal sessions entirely.
CREATE OR REPLACE FUNCTION app_is_staff_session() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.portal_patients', true), '') = ''
$$;

-- ---------------------------------------------------------------- fee schedules

CREATE TABLE fee_schedule (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id      uuid NOT NULL REFERENCES organization(id),
  name        text NOT NULL,
  -- office: the practice's own (usual) fees, one active per practice.
  -- network: fees a payer contract allows; the difference is written off as contractual.
  kind        text NOT NULL CHECK (kind IN ('office', 'network')),
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, name)
);
CREATE UNIQUE INDEX fee_schedule_one_office ON fee_schedule (org_id) WHERE kind = 'office' AND active;
SELECT enable_tenant_rls('fee_schedule');

-- A fee change is a new row with a later effective date; the fee on a date of service is the
-- newest row effective on or before it. Fees follow the code across code-set versions.
CREATE TABLE fee_schedule_fee (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id           uuid NOT NULL,
  fee_schedule_id  uuid NOT NULL,
  code             text NOT NULL,
  amount_cents     integer NOT NULL CHECK (amount_cents >= 0),
  effective_from   date NOT NULL,
  set_by           uuid NOT NULL,
  set_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fee_schedule_id, code, effective_from),
  FOREIGN KEY (org_id, fee_schedule_id) REFERENCES fee_schedule(org_id, id)
);
CREATE INDEX fee_lookup ON fee_schedule_fee (fee_schedule_id, code, effective_from DESC);
SELECT enable_tenant_rls('fee_schedule_fee');
CREATE TRIGGER fee_schedule_fee_append_only BEFORE UPDATE OR DELETE ON fee_schedule_fee FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- ---------------------------------------------------------------- payers and coverage

CREATE TABLE payer (
  id                       uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                   uuid NOT NULL REFERENCES organization(id),
  name                     text NOT NULL,
  -- The payer's id at the clearinghouse (routes 270/837D/276 transactions).
  clearinghouse_payer_id   text NOT NULL,
  -- In network when set: the contracted fee schedule. Out of network when null.
  network_fee_schedule_id  uuid,
  active                   boolean NOT NULL DEFAULT true,
  created_by               uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, clearinghouse_payer_id),
  FOREIGN KEY (org_id, network_fee_schedule_id) REFERENCES fee_schedule(org_id, id)
);
SELECT enable_tenant_rls('payer');

-- Benefits live on the policy (the practice's copy of the plan summary). Coverage is a percent
-- per benefit category; deductible applies to categories not listed in deductible_waived.
ALTER TABLE insurance_policy
  ADD COLUMN payer_id               uuid,
  ADD COLUMN subscriber_name        text,
  ADD COLUMN plan_name              text,
  ADD COLUMN annual_max_cents       integer CHECK (annual_max_cents >= 0),
  ADD COLUMN deductible_cents       integer NOT NULL DEFAULT 0 CHECK (deductible_cents >= 0),
  ADD COLUMN deductible_waived      text[] NOT NULL DEFAULT '{diagnostic,preventive}',
  ADD COLUMN coverage               jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN benefit_year_start_month smallint NOT NULL DEFAULT 1 CHECK (benefit_year_start_month BETWEEN 1 AND 12),
  ADD COLUMN effective_from         date,
  ADD COLUMN effective_to           date,
  ADD COLUMN created_by             uuid,
  ADD COLUMN updated_by             uuid,
  ADD COLUMN updated_at             timestamptz,
  ADD COLUMN version                integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT insurance_policy_org_id UNIQUE (org_id, id),
  ADD CONSTRAINT insurance_policy_payer FOREIGN KEY (org_id, payer_id) REFERENCES payer(org_id, id),
  ADD CONSTRAINT insurance_policy_rank CHECK (rank IN (1, 2));
CREATE UNIQUE INDEX insurance_policy_one_rank ON insurance_policy (patient_id, rank) WHERE active;

-- Every eligibility answer is kept (what we knew when we quoted the patient).
CREATE TABLE eligibility_check (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                uuid NOT NULL,
  patient_id            uuid NOT NULL,
  insurance_policy_id   uuid NOT NULL,
  status                text NOT NULL CHECK (status IN ('active', 'inactive', 'error')),
  -- Normalized answer (no vendor payload): remaining maximum and deductible, coverage percents.
  remaining_max_cents   integer,
  deductible_remaining_cents integer,
  coverage              jsonb,
  detail                text,
  requested_by          uuid NOT NULL,
  checked_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, insurance_policy_id) REFERENCES insurance_policy(org_id, id)
);
CREATE INDEX eligibility_latest ON eligibility_check (insurance_policy_id, checked_at DESC);
SELECT enable_tenant_rls('eligibility_check');
CREATE TRIGGER eligibility_check_append_only BEFORE UPDATE OR DELETE ON eligibility_check FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- ---------------------------------------------------------------- payments

-- Money received. A patient payment belongs to one patient; an insurance payment (check or
-- EFT) can cover many patients and is split across them by remittance posting.
CREATE TABLE payment (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id        uuid NOT NULL,
  patient_id    uuid,
  source        text NOT NULL CHECK (source IN ('patient', 'insurance')),
  method        text NOT NULL CHECK (method IN ('cash', 'check', 'card_terminal', 'eft', 'other')),
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  received_on   date NOT NULL,
  -- Check number or terminal receipt number. Never a card number.
  reference     text CHECK (reference IS NULL OR reference !~ '\d{12,}'),
  payer_id      uuid,
  note          text,
  posted_by     uuid,
  posted_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK ((source = 'patient') = (patient_id IS NOT NULL)),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, payer_id) REFERENCES payer(org_id, id)
);
SELECT enable_tenant_rls('payment');
CREATE TRIGGER payment_append_only BEFORE UPDATE OR DELETE ON payment FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- ---------------------------------------------------------------- claims

CREATE TABLE claim (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                 uuid NOT NULL,
  patient_id             uuid NOT NULL,
  insurance_policy_id    uuid NOT NULL,
  payer_id               uuid NOT NULL,
  location_id            uuid NOT NULL,
  rendering_provider_id  uuid NOT NULL,
  status                 text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'queued', 'submitted', 'accepted', 'rejected', 'paid', 'denied', 'void')),
  service_date           date NOT NULL,
  -- Sent to the clearinghouse as the patient control number; retries reuse it.
  idempotency_key        uuid NOT NULL DEFAULT gen_random_uuid(),
  clearinghouse_claim_id text,
  status_detail          text,
  created_by             uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  submitted_by           uuid,
  submitted_at           timestamptz,
  updated_at             timestamptz,
  version                integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, insurance_policy_id) REFERENCES insurance_policy(org_id, id),
  FOREIGN KEY (org_id, payer_id) REFERENCES payer(org_id, id),
  FOREIGN KEY (org_id, location_id) REFERENCES location(org_id, id)
);
CREATE INDEX claim_status ON claim (org_id, status, created_at);
SELECT enable_tenant_rls('claim');

CREATE TABLE claim_line (
  id                       uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                   uuid NOT NULL,
  patient_id               uuid NOT NULL,
  claim_id                 uuid NOT NULL,
  procedure_occurrence_id  uuid NOT NULL,
  charge_entry_id          uuid NOT NULL,
  code                     text NOT NULL,
  code_version             text NOT NULL,
  category                 text NOT NULL,
  -- Display attributes copied for the claim form; never used as keys.
  tooth_label              text,
  surfaces                 text[] NOT NULL DEFAULT '{}',
  fee_cents                integer NOT NULL CHECK (fee_cents >= 0),
  est_insurance_cents      integer NOT NULL DEFAULT 0,
  -- Filled from the remittance.
  allowed_cents            integer,
  paid_cents               integer,
  deductible_cents         integer,
  patient_resp_cents       integer,
  adjudication             text CHECK (adjudication IN ('paid', 'denied')),
  denial_reason            text,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, claim_id) REFERENCES claim(org_id, id),
  FOREIGN KEY (org_id, procedure_occurrence_id) REFERENCES procedure_occurrence(org_id, id)
);
CREATE INDEX claim_line_claim ON claim_line (claim_id);
SELECT enable_tenant_rls('claim_line');

-- Once a claim leaves draft its billed content is frozen; only adjudication fields may change.
CREATE OR REPLACE FUNCTION claim_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'claim lines are never deleted; void the claim' USING ERRCODE = '42501';
  END IF;
  SELECT status INTO v_status FROM claim WHERE id = OLD.claim_id;
  IF v_status <> 'draft' AND
     (to_jsonb(NEW) - '{allowed_cents,paid_cents,deductible_cents,patient_resp_cents,adjudication,denial_reason}'::text[])
       IS DISTINCT FROM
     (to_jsonb(OLD) - '{allowed_cents,paid_cents,deductible_cents,patient_resp_cents,adjudication,denial_reason}'::text[]) THEN
    RAISE EXCEPTION 'submitted claim lines are frozen' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER claim_line_guard BEFORE UPDATE OR DELETE ON claim_line FOR EACH ROW EXECUTE FUNCTION claim_line_guard();

-- A procedure sits on at most one live claim per coverage rank.
CREATE OR REPLACE FUNCTION claim_line_single_live() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM claim_line l JOIN claim c ON c.id = l.claim_id
      JOIN insurance_policy p ON p.id = c.insurance_policy_id
     WHERE l.procedure_occurrence_id = NEW.procedure_occurrence_id AND l.id <> NEW.id
       AND c.status NOT IN ('void', 'rejected')
       AND p.rank = (SELECT p2.rank FROM claim c2 JOIN insurance_policy p2 ON p2.id = c2.insurance_policy_id WHERE c2.id = NEW.claim_id)
  ) THEN
    RAISE EXCEPTION 'procedure is already on a claim' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER claim_line_single_live BEFORE INSERT ON claim_line FOR EACH ROW EXECUTE FUNCTION claim_line_single_live();

CREATE TABLE claim_event (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id      uuid NOT NULL,
  patient_id  uuid NOT NULL,
  claim_id    uuid NOT NULL,
  status      text NOT NULL,
  source      text NOT NULL CHECK (source IN ('app', 'clearinghouse')),
  detail      text,
  actor_id    uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, claim_id) REFERENCES claim(org_id, id)
);
CREATE INDEX claim_event_claim ON claim_event (claim_id, occurred_at);
SELECT enable_tenant_rls('claim_event');
CREATE TRIGGER claim_event_append_only BEFORE UPDATE OR DELETE ON claim_event FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- An 835-equivalent payment advice, posted once (unique per clearinghouse reference).
CREATE TABLE remittance (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  payer_id          uuid NOT NULL,
  clearinghouse_ref text NOT NULL,
  payment_id        uuid,
  trace_number      text NOT NULL,
  total_paid_cents  integer NOT NULL CHECK (total_paid_cents >= 0),
  paid_on           date NOT NULL,
  claim_count       integer NOT NULL,
  unmatched         jsonb NOT NULL DEFAULT '[]'::jsonb,
  posted_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, clearinghouse_ref),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, payer_id) REFERENCES payer(org_id, id),
  FOREIGN KEY (org_id, payment_id) REFERENCES payment(org_id, id)
);
SELECT enable_tenant_rls('remittance');
CREATE POLICY staff_only ON remittance AS RESTRICTIVE USING (app_is_staff_session()) WITH CHECK (app_is_staff_session());
CREATE TRIGGER remittance_append_only BEFORE UPDATE OR DELETE ON remittance FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- ---------------------------------------------------------------- the ledger

-- Signed amounts, from the patient account's point of view: a charge raises what is owed,
-- payments and write-offs lower it, a refund raises it again. The balance is the sum.
-- Allocation: applies_to_id names the charge a payment or adjustment settles (null = an
-- unapplied credit on the account). A reversal names the entry it cancels, exactly once.
CREATE TABLE ledger_entry (
  id                       uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                   uuid NOT NULL,
  patient_id               uuid NOT NULL,
  kind                     text NOT NULL CHECK (kind IN ('charge', 'patient_payment', 'insurance_payment', 'adjustment', 'refund', 'reversal')),
  amount_cents             integer NOT NULL,
  service_date             date,
  description              text NOT NULL,
  procedure_occurrence_id  uuid,
  code                     text,
  code_version             text,
  provider_id              uuid,
  location_id              uuid,
  applies_to_id            uuid REFERENCES ledger_entry(id),
  reverses_id              uuid UNIQUE REFERENCES ledger_entry(id),
  payment_id               uuid,
  claim_id                 uuid,
  adjustment_reason        text CHECK (adjustment_reason IN ('contractual', 'courtesy', 'bad_debt', 'small_balance', 'correction', 'other')),
  note                     text,
  posted_by                uuid,
  posted_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, procedure_occurrence_id) REFERENCES procedure_occurrence(org_id, id),
  FOREIGN KEY (org_id, payment_id) REFERENCES payment(org_id, id),
  FOREIGN KEY (org_id, claim_id) REFERENCES claim(org_id, id),
  CHECK (kind <> 'charge' OR (amount_cents >= 0 AND procedure_occurrence_id IS NOT NULL AND code IS NOT NULL)),
  CHECK (kind NOT IN ('patient_payment', 'insurance_payment') OR (amount_cents <= 0 AND payment_id IS NOT NULL)),
  CHECK (kind <> 'adjustment' OR adjustment_reason IS NOT NULL),
  CHECK (kind <> 'refund' OR amount_cents > 0),
  CHECK ((kind = 'reversal') = (reverses_id IS NOT NULL))
);
CREATE INDEX ledger_patient ON ledger_entry (org_id, patient_id, posted_at);
CREATE INDEX ledger_applies ON ledger_entry (applies_to_id);
CREATE INDEX ledger_procedure ON ledger_entry (procedure_occurrence_id);
SELECT enable_tenant_rls('ledger_entry');
CREATE TRIGGER ledger_entry_append_only BEFORE UPDATE OR DELETE ON ledger_entry FOR EACH ROW EXECUTE FUNCTION append_only_guard();

ALTER TABLE claim_line ADD FOREIGN KEY (org_id, charge_entry_id) REFERENCES ledger_entry(org_id, id);

-- ---------------------------------------------------------------- portal: billing scope

ALTER TABLE portal_access_grant DROP CONSTRAINT portal_access_grant_scopes_check;
ALTER TABLE portal_access_grant ADD CONSTRAINT portal_access_grant_scopes_check
  CHECK (scopes <@ ARRAY['appointments', 'visits', 'treatment_plan', 'health_record', 'prescriptions',
                         'pharmacies', 'messages', 'forms', 'requests', 'billing']::text[]);

-- The second wall for the new patient tables (same rule as 0006).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['eligibility_check', 'payment', 'claim', 'claim_line', 'claim_event', 'ledger_entry'] LOOP
    EXECUTE format('CREATE POLICY portal_scope ON %I AS RESTRICTIVE USING (app_portal_allows(patient_id)) WITH CHECK (app_portal_allows(patient_id))', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- grants

GRANT SELECT, INSERT ON fee_schedule_fee, eligibility_check, payment, claim_event, remittance, ledger_entry TO teeth_app;
GRANT SELECT, INSERT, UPDATE ON fee_schedule, payer, claim, claim_line TO teeth_app;
