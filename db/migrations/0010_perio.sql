-- 0010 periodontal charting (MASTER_SPEC §10.5, Phase 6).
--
-- A perio exam is a chart entry of its visit, like a finding: drafts are edited in place while
-- the visit is open, signing locks the exam and every measurement in it, and an amendment
-- supersedes the whole exam with a copy (the signed one stays readable forever).
--
-- Measurements are typed rows, not a JSON blob:
--   perio_tooth  one row per tooth per exam: mobility, keratinized gingiva, mucogingival defect
--   perio_site   one row per site (MB B DB DL L ML) per tooth per exam: probing depth, recession,
--                bleeding, suppuration, plaque, calculus, furcation; CAL is computed by Postgres.

CREATE TABLE perio_exam (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  patient_id        uuid NOT NULL,
  encounter_id      uuid NOT NULL,
  exam_type         text NOT NULL CHECK (exam_type IN ('comprehensive', 'reevaluation', 'maintenance')),
  note              text,
  recorded_by       uuid NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  updated_at        timestamptz,
  version           integer NOT NULL DEFAULT 1,
  supersedes_id     uuid REFERENCES perio_exam(id),
  amendment_id      uuid,
  locked_at         timestamptz,
  entered_in_error  boolean NOT NULL DEFAULT false,
  void_reason       text,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT protect_chart_table('perio_exam', '{}');
CREATE INDEX perio_exam_patient ON perio_exam (org_id, patient_id);

CREATE TABLE perio_tooth (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                 uuid NOT NULL,
  patient_id             uuid NOT NULL,
  encounter_id           uuid NOT NULL,
  perio_exam_id          uuid NOT NULL,
  tooth_instance_id      uuid NOT NULL,
  mobility               smallint CHECK (mobility BETWEEN 0 AND 3),
  keratinized_gingiva_mm smallint CHECK (keratinized_gingiva_mm BETWEEN 0 AND 15),
  mucogingival_defect    boolean NOT NULL DEFAULT false,
  note                   text,
  recorded_by            uuid NOT NULL,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  updated_at             timestamptz,
  version                integer NOT NULL DEFAULT 1,
  locked_at              timestamptz,
  UNIQUE (perio_exam_id, tooth_instance_id),
  FOREIGN KEY (org_id, perio_exam_id) REFERENCES perio_exam(org_id, id),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id)
);
SELECT protect_chart_table('perio_tooth', '{}');

CREATE TABLE perio_site (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  patient_id        uuid NOT NULL,
  encounter_id      uuid NOT NULL,
  perio_exam_id     uuid NOT NULL,
  tooth_instance_id uuid NOT NULL,
  site              text NOT NULL CHECK (site IN ('MB', 'B', 'DB', 'DL', 'L', 'ML')),
  probing_depth     smallint CHECK (probing_depth BETWEEN 0 AND 20),
  -- CEJ to gingival margin; negative when the margin is coronal to the CEJ (enlargement).
  recession         smallint CHECK (recession BETWEEN -10 AND 20),
  cal               smallint GENERATED ALWAYS AS (probing_depth + recession) STORED,
  bleeding          boolean NOT NULL DEFAULT false,
  suppuration       boolean NOT NULL DEFAULT false,
  plaque            boolean NOT NULL DEFAULT false,
  calculus          boolean NOT NULL DEFAULT false,
  -- Furcation grade (Glickman I-IV) at the entrance probed from this site.
  furcation         smallint CHECK (furcation BETWEEN 1 AND 4),
  recorded_by       uuid NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  updated_at        timestamptz,
  version           integer NOT NULL DEFAULT 1,
  locked_at         timestamptz,
  UNIQUE (perio_exam_id, tooth_instance_id, site),
  FOREIGN KEY (org_id, perio_exam_id) REFERENCES perio_exam(org_id, id),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id)
);
SELECT protect_chart_table('perio_site', '{}');

-- A measurement row must belong to an exam of the same visit and patient, on one of that
-- patient's teeth, and can only be written while its exam is an editable draft. The API checks
-- all of this too; the database makes it impossible to get wrong.
CREATE OR REPLACE FUNCTION perio_measurement_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_exam perio_exam%ROWTYPE;
  v_tooth_patient uuid;
BEGIN
  -- Signing stamps locked_at on unlocked rows; that is the one write a locked exam allows.
  IF TG_OP = 'UPDATE' AND OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_exam FROM perio_exam WHERE id = NEW.perio_exam_id;
  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'perio exam % not found', NEW.perio_exam_id USING ERRCODE = '23503';
  END IF;
  IF v_exam.encounter_id <> NEW.encounter_id OR v_exam.patient_id <> NEW.patient_id THEN
    RAISE EXCEPTION 'perio measurement must match its exam''s visit and patient' USING ERRCODE = '23514';
  END IF;
  SELECT patient_id INTO v_tooth_patient FROM tooth_instance WHERE id = NEW.tooth_instance_id;
  IF v_tooth_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'perio measurement is on another patient''s tooth' USING ERRCODE = '23514';
  END IF;
  IF v_exam.locked_at IS NOT NULL OR v_exam.entered_in_error THEN
    RAISE EXCEPTION 'perio exam is signed or voided; create an amendment' USING ERRCODE = '42501';
  END IF;
  IF NEW.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'perio measurements are locked by signing their visit' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER perio_tooth_guard BEFORE INSERT OR UPDATE ON perio_tooth FOR EACH ROW EXECUTE FUNCTION perio_measurement_guard();
CREATE TRIGGER perio_site_guard BEFORE INSERT OR UPDATE ON perio_site FOR EACH ROW EXECUTE FUNCTION perio_measurement_guard();

GRANT SELECT, INSERT, UPDATE ON perio_exam, perio_tooth, perio_site TO teeth_app;
