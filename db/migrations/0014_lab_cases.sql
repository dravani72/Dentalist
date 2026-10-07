-- 0014 lab cases (Phase 6): work orders to dental laboratories.
--
--   dental_lab      the practice's labs (name and how to reach them)
--   lab_case        one case for one patient: the prescription (lab, prescribing dentist,
--                   impression, enclosures, instructions, due date) and where it stands
--   lab_case_item   the units on the prescription: a tooth or an arch, what is made, material, shade
--   lab_case_event  append-only history of every status change, with the frozen prescription
--                   and its SHA-256 on every send
--
-- The prescription is editable only while the case is a draft. Sending (a licensed dentist's
-- authorization) freezes it; later changes go to the lab as instructions on a send-back, which
-- keeps its own frozen copy. Tooth numbers are stored for display only; the unit points at the
-- patient's tooth instance.

CREATE TABLE dental_lab (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id       uuid NOT NULL,
  name         text NOT NULL,
  phone        text,
  email        text,
  address      text,
  note         text,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  updated_at   timestamptz,
  UNIQUE (org_id, id),
  UNIQUE (org_id, name)
);
SELECT enable_tenant_rls('dental_lab');

CREATE TABLE lab_case (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                  uuid NOT NULL,
  seq                     integer NOT NULL,
  patient_id              uuid NOT NULL,
  location_id             uuid NOT NULL,
  lab_id                  uuid NOT NULL,
  prescribing_dentist_id  uuid NOT NULL,
  impression_type         text NOT NULL CHECK (impression_type IN ('digital_scan', 'conventional')),
  scan_reference          text,
  enclosures              text[] NOT NULL DEFAULT '{}'
                          CHECK (enclosures <@ ARRAY['impression', 'models', 'bite_registration', 'opposing_model', 'photos', 'shade_tab', 'scan_files', 'implant_components']),
  instructions            text,
  due_date                date,
  status                  text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SENT', 'RECEIVED', 'SEATED', 'CANCELLED')),
  round                   integer NOT NULL DEFAULT 0,
  authorized_by           uuid,
  authorized_at           timestamptz,
  authorizing_credential_id uuid,
  sent_on                 date,
  received_on             date,
  seated_on               date,
  seated_procedure_id     uuid,
  cancel_reason           text,
  appointment_id          uuid,
  created_by              uuid NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  updated_at              timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, id),
  UNIQUE (org_id, seq),
  CONSTRAINT lab_case_sent CHECK (status IN ('DRAFT', 'CANCELLED') OR (authorized_by IS NOT NULL AND sent_on IS NOT NULL AND due_date IS NOT NULL)),
  CONSTRAINT lab_case_received CHECK (status NOT IN ('RECEIVED', 'SEATED') OR received_on IS NOT NULL),
  CONSTRAINT lab_case_seated CHECK (status <> 'SEATED' OR seated_on IS NOT NULL),
  CONSTRAINT lab_case_cancelled CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, lab_id) REFERENCES dental_lab(org_id, id),
  FOREIGN KEY (org_id, appointment_id) REFERENCES appointment(org_id, id),
  FOREIGN KEY (org_id, seated_procedure_id) REFERENCES procedure_occurrence(org_id, id)
);
SELECT enable_tenant_rls('lab_case');
CREATE INDEX lab_case_patient ON lab_case (org_id, patient_id);
CREATE INDEX lab_case_open ON lab_case (org_id, location_id, status, due_date);

CREATE TABLE lab_case_item (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                  uuid NOT NULL,
  lab_case_id             uuid NOT NULL,
  position                smallint NOT NULL,
  restoration             text NOT NULL CHECK (restoration IN ('crown', 'bridge_retainer', 'pontic', 'inlay_onlay', 'veneer', 'implant_crown',
                                                               'complete_denture', 'partial_denture', 'night_guard', 'other')),
  tooth_instance_id       uuid,
  tooth_universal         text,
  arch                    text CHECK (arch IN ('upper', 'lower')),
  material                text CHECK (material IN ('zirconia', 'lithium_disilicate', 'pfm', 'full_cast_gold', 'composite', 'acrylic', 'cast_metal_framework', 'other')),
  shade                   text,
  planned_procedure_id    uuid,
  note                    text,
  UNIQUE (lab_case_id, position),
  CONSTRAINT lab_case_item_site CHECK ((tooth_instance_id IS NOT NULL) <> (arch IS NOT NULL)),
  CONSTRAINT lab_case_item_tooth CHECK ((tooth_instance_id IS NULL) = (tooth_universal IS NULL)),
  FOREIGN KEY (org_id, lab_case_id) REFERENCES lab_case(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id)
);
SELECT enable_tenant_rls('lab_case_item');
CREATE INDEX lab_case_item_case ON lab_case_item (lab_case_id);

CREATE TABLE lab_case_event (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id        uuid NOT NULL,
  lab_case_id   uuid NOT NULL,
  from_status   text,
  to_status     text NOT NULL,
  round         integer NOT NULL,
  reason        text,
  note          text,
  due_date      date,
  rx_snapshot   jsonb,
  rx_sha256     text,
  actor_id      uuid NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lab_case_event_rx CHECK ((rx_snapshot IS NULL) = (rx_sha256 IS NULL)),
  FOREIGN KEY (org_id, lab_case_id) REFERENCES lab_case(org_id, id)
);
SELECT enable_tenant_rls('lab_case_event');
CREATE INDEX lab_case_event_case ON lab_case_event (lab_case_id, at);

-- The prescription can only change while the case is a draft, and a case never moves to
-- another patient. Items follow their case.
CREATE OR REPLACE FUNCTION lab_case_rx_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lab cases are never deleted; cancel them' USING ERRCODE = '42501';
  END IF;
  IF NEW.patient_id <> OLD.patient_id OR NEW.seq <> OLD.seq OR NEW.org_id <> OLD.org_id THEN
    RAISE EXCEPTION 'a lab case keeps its patient and number' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       NEW.lab_id <> OLD.lab_id OR NEW.prescribing_dentist_id <> OLD.prescribing_dentist_id
    OR NEW.impression_type <> OLD.impression_type OR NEW.scan_reference IS DISTINCT FROM OLD.scan_reference
    OR NEW.enclosures <> OLD.enclosures OR NEW.instructions IS DISTINCT FROM OLD.instructions
    OR (OLD.authorized_by IS NOT NULL AND (NEW.authorized_by IS DISTINCT FROM OLD.authorized_by
        OR NEW.authorized_at IS DISTINCT FROM OLD.authorized_at OR NEW.authorizing_credential_id IS DISTINCT FROM OLD.authorizing_credential_id))) THEN
    RAISE EXCEPTION 'this prescription was sent and is immutable; send the case back with instructions instead' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('SEATED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a seated or cancelled case is closed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lab_case_rx_guard BEFORE UPDATE OR DELETE ON lab_case FOR EACH ROW EXECUTE FUNCTION lab_case_rx_guard();

CREATE OR REPLACE FUNCTION lab_case_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_case_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.lab_case_id ELSE NEW.lab_case_id END;
  v_case lab_case%ROWTYPE;
  v_site tooth_instance%ROWTYPE;
BEGIN
  SELECT * INTO v_case FROM lab_case WHERE id = v_case_id;
  IF v_case.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'this prescription was sent and is immutable' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.tooth_instance_id IS NOT NULL THEN
    SELECT * INTO v_site FROM tooth_instance WHERE id = NEW.tooth_instance_id;
    IF v_site.patient_id IS DISTINCT FROM v_case.patient_id THEN
      RAISE EXCEPTION 'a lab unit sits on one of the case patient''s teeth' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.planned_procedure_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM planned_procedure WHERE id = NEW.planned_procedure_id AND patient_id = v_case.patient_id) THEN
    RAISE EXCEPTION 'a lab unit fulfils one of the case patient''s plan items' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lab_case_item_guard BEFORE INSERT OR UPDATE OR DELETE ON lab_case_item FOR EACH ROW EXECUTE FUNCTION lab_case_item_guard();

-- History is append-only.
CREATE OR REPLACE FUNCTION lab_case_event_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lab case history is append-only' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER lab_case_event_append_only BEFORE UPDATE OR DELETE ON lab_case_event FOR EACH ROW EXECUTE FUNCTION lab_case_event_append_only();

GRANT SELECT, INSERT, UPDATE ON dental_lab, lab_case TO teeth_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON lab_case_item TO teeth_app;
GRANT SELECT, INSERT ON lab_case_event TO teeth_app;
