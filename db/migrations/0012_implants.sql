-- 0012 implant records (MASTER_SPEC §10.7, Phase 6).
--
-- An implant is a persistent device. Two chart-entry tables, both recorded in a visit, locked
-- when it is signed and changed afterwards only by an amendment that supersedes the row:
--   implant        the placement record: the device's identity (manufacturer, catalog, lot,
--                  serial), size, site, torque, stability, healing protocol, graft and membrane
--   implant_event  every later step on the device, in the visit where it happened: uncovery,
--                  abutment, restoration, stability checks, follow-ups, complications, removal
--
-- device_id is the device's lasting identity: the id of its first placement record, carried by
-- every amended version and by every event, so a device's history survives amendments.

CREATE TABLE implant (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                  uuid NOT NULL,
  patient_id              uuid NOT NULL,
  encounter_id            uuid NOT NULL,
  device_id               uuid NOT NULL,
  -- The implant site: a tooth instance of kind 'implant' at the dental position.
  tooth_instance_id       uuid NOT NULL,
  procedure_occurrence_id uuid NOT NULL,
  manufacturer            text NOT NULL,
  product_family          text,
  catalog_number          text,
  lot_number              text,
  serial_number           text,
  diameter_mm             numeric(3,1) NOT NULL CHECK (diameter_mm BETWEEN 2.5 AND 7),
  length_mm               numeric(3,1) NOT NULL CHECK (length_mm BETWEEN 5 AND 20 AND length_mm * 2 = trunc(length_mm * 2)),
  surface                 text,
  platform                text,
  insertion_torque_ncm    smallint CHECK (insertion_torque_ncm BETWEEN 0 AND 100),
  isq                     smallint CHECK (isq BETWEEN 1 AND 100),
  bone_quality            text CHECK (bone_quality IN ('D1', 'D2', 'D3', 'D4')),
  timing                  text CHECK (timing IN ('immediate', 'early', 'delayed')),
  healing                 text NOT NULL CHECK (healing IN ('submerged', 'non_submerged', 'immediate_provisional', 'immediate_load')),
  graft_material          text,
  graft_product           text,
  graft_lot               text,
  membrane_product        text,
  membrane_lot            text,
  note                    text,
  recorded_by             uuid NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  updated_at              timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  supersedes_id           uuid REFERENCES implant(id),
  amendment_id            uuid,
  locked_at               timestamptz,
  entered_in_error        boolean NOT NULL DEFAULT false,
  void_reason             text,
  CONSTRAINT implant_traceable CHECK (lot_number IS NOT NULL OR serial_number IS NOT NULL),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id),
  FOREIGN KEY (org_id, procedure_occurrence_id) REFERENCES procedure_occurrence(org_id, id)
);
SELECT protect_chart_table('implant', '{}');
CREATE INDEX implant_patient ON implant (org_id, patient_id);
CREATE INDEX implant_device ON implant (device_id);

CREATE TABLE implant_event (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                  uuid NOT NULL,
  patient_id              uuid NOT NULL,
  encounter_id            uuid NOT NULL,
  device_id               uuid NOT NULL,
  tooth_instance_id       uuid NOT NULL,
  event_type              text NOT NULL CHECK (event_type IN ('second_stage', 'healing_abutment', 'abutment', 'restoration', 'stability_check',
                                                              'follow_up', 'complication', 'removal')),
  isq                     smallint CHECK (isq BETWEEN 1 AND 100),
  abutment_manufacturer   text,
  abutment_catalog_number text,
  abutment_lot            text,
  abutment_torque_ncm     smallint CHECK (abutment_torque_ncm BETWEEN 0 AND 100),
  restoration_type        text CHECK (restoration_type IN ('single_crown', 'bridge_abutment', 'overdenture_attachment', 'full_arch_fixed')),
  retention               text CHECK (retention IN ('screw', 'cement')),
  complication            text CHECK (complication IN ('peri_implant_mucositis', 'peri_implantitis', 'screw_loosening', 'abutment_fracture',
                                                       'implant_fracture', 'failed_osseointegration', 'soft_tissue_recession',
                                                       'nerve_disturbance', 'other')),
  bone_loss_mm            numeric(3,1) CHECK (bone_loss_mm BETWEEN 0 AND 15),
  note                    text,
  recorded_by             uuid NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  updated_at              timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  supersedes_id           uuid REFERENCES implant_event(id),
  amendment_id            uuid,
  locked_at               timestamptz,
  entered_in_error        boolean NOT NULL DEFAULT false,
  void_reason             text,
  CONSTRAINT implant_event_restoration CHECK (
    (event_type = 'restoration' AND restoration_type IS NOT NULL AND retention IS NOT NULL)
    OR (event_type <> 'restoration' AND restoration_type IS NULL AND retention IS NULL)),
  CONSTRAINT implant_event_complication CHECK (complication IS NULL OR event_type IN ('complication', 'removal')),
  CONSTRAINT implant_event_complication_named CHECK (event_type <> 'complication' OR complication IS NOT NULL),
  CONSTRAINT implant_event_isq CHECK (event_type <> 'stability_check' OR isq IS NOT NULL),
  CONSTRAINT implant_event_abutment CHECK (
    event_type IN ('healing_abutment', 'abutment', 'restoration')
    OR (abutment_manufacturer IS NULL AND abutment_catalog_number IS NULL AND abutment_lot IS NULL AND abutment_torque_ncm IS NULL)),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id)
);
SELECT protect_chart_table('implant_event', '{}');
CREATE INDEX implant_event_device ON implant_event (device_id);
CREATE INDEX implant_event_patient ON implant_event (org_id, patient_id);

-- A new placement record starts its own device unless it is an amended version of one.
-- The site must be one of the patient's implant tooth instances, and the placement procedure
-- an implant placement in the same visit at the same position. An event must point at a device
-- of the same patient, at that device's site.
CREATE OR REPLACE FUNCTION implant_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_site tooth_instance%ROWTYPE;
  v_proc procedure_occurrence%ROWTYPE;
  v_proc_position text;
  v_device implant%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.locked_at IS NOT NULL OR NEW.locked_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.device_id <> OLD.device_id THEN
    RAISE EXCEPTION 'an implant record cannot move to another device' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_site FROM tooth_instance WHERE id = NEW.tooth_instance_id;
  IF v_site.patient_id IS DISTINCT FROM NEW.patient_id OR v_site.kind <> 'implant' THEN
    RAISE EXCEPTION 'an implant record sits on one of the patient''s implant sites' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'implant' THEN
    IF TG_OP = 'INSERT' AND NEW.supersedes_id IS NULL THEN
      NEW.device_id := NEW.id;
    END IF;
    SELECT * INTO v_proc FROM procedure_occurrence WHERE id = NEW.procedure_occurrence_id;
    SELECT dental_position_id INTO v_proc_position FROM tooth_instance WHERE id = v_proc.tooth_instance_id;
    IF v_proc.id IS NULL OR v_proc.procedure_concept <> 'implant_placement' OR v_proc.encounter_id <> NEW.encounter_id
       OR v_proc.patient_id <> NEW.patient_id OR v_proc_position IS DISTINCT FROM v_site.dental_position_id THEN
      RAISE EXCEPTION 'an implant belongs to an implant placement procedure at the same site in the same visit' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO v_device FROM implant WHERE device_id = NEW.device_id ORDER BY version LIMIT 1;
    IF v_device.id IS NULL OR v_device.patient_id <> NEW.patient_id OR v_device.tooth_instance_id <> NEW.tooth_instance_id THEN
      RAISE EXCEPTION 'an implant event belongs to one of the patient''s implants, at its site' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER implant_guard BEFORE INSERT OR UPDATE ON implant FOR EACH ROW EXECUTE FUNCTION implant_guard();
CREATE TRIGGER implant_event_guard BEFORE INSERT OR UPDATE ON implant_event FOR EACH ROW EXECUTE FUNCTION implant_guard();

GRANT SELECT, INSERT, UPDATE ON implant, implant_event TO teeth_app;
