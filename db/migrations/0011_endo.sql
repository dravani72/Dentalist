-- 0011 endodontic charting (MASTER_SPEC §10.6, Phase 6).
--
-- Three chart-entry tables, each recorded in a visit, locked when the visit is signed, and
-- changed afterwards only by an amendment that supersedes the row:
--   endo_diagnosis  pulpal + apical diagnosis of one tooth, with the presenting symptoms
--   endo_test       one pulp or periapical test on one tooth (the tooth in question or a control)
--   endo_canal      one canal of a root canal procedure: working length, preparation, obturation
--
-- Value lists are our own keys (AAE terminology in the labels), checked here so a bad value
-- can't reach the chart by any route.

CREATE TABLE endo_diagnosis (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  patient_id        uuid NOT NULL,
  encounter_id      uuid NOT NULL,
  tooth_instance_id uuid NOT NULL,
  pulpal_diagnosis  text NOT NULL CHECK (pulpal_diagnosis IN ('normal_pulp', 'reversible_pulpitis', 'symptomatic_irreversible_pulpitis',
                                                              'asymptomatic_irreversible_pulpitis', 'pulp_necrosis', 'previously_treated',
                                                              'previously_initiated_therapy')),
  apical_diagnosis  text NOT NULL CHECK (apical_diagnosis IN ('normal_apical_tissues', 'symptomatic_apical_periodontitis',
                                                              'asymptomatic_apical_periodontitis', 'chronic_apical_abscess',
                                                              'acute_apical_abscess', 'condensing_osteitis')),
  symptoms          text[] NOT NULL DEFAULT '{}'
                    CHECK (symptoms <@ ARRAY['spontaneous_pain', 'lingering_cold_pain', 'heat_pain', 'pain_on_biting', 'swelling',
                                             'sinus_tract', 'night_pain', 'none']::text[]),
  note              text,
  recorded_by       uuid NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  updated_at        timestamptz,
  version           integer NOT NULL DEFAULT 1,
  supersedes_id     uuid REFERENCES endo_diagnosis(id),
  amendment_id      uuid,
  locked_at         timestamptz,
  entered_in_error  boolean NOT NULL DEFAULT false,
  void_reason       text,
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id)
);
SELECT protect_chart_table('endo_diagnosis', '{}');
CREATE INDEX endo_diagnosis_patient ON endo_diagnosis (org_id, patient_id);

CREATE TABLE endo_test (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id            uuid NOT NULL,
  patient_id        uuid NOT NULL,
  encounter_id      uuid NOT NULL,
  tooth_instance_id uuid NOT NULL,
  test              text NOT NULL CHECK (test IN ('cold', 'heat', 'ept', 'percussion', 'palpation', 'bite')),
  result            text NOT NULL,
  ept_reading       smallint CHECK (ept_reading BETWEEN 0 AND 80),
  lingering_seconds smallint CHECK (lingering_seconds BETWEEN 0 AND 600),
  is_control        boolean NOT NULL DEFAULT false,
  note              text,
  recorded_by       uuid NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  updated_at        timestamptz,
  version           integer NOT NULL DEFAULT 1,
  supersedes_id     uuid REFERENCES endo_test(id),
  amendment_id      uuid,
  locked_at         timestamptz,
  entered_in_error  boolean NOT NULL DEFAULT false,
  void_reason       text,
  CONSTRAINT endo_test_result CHECK (CASE
    WHEN test IN ('cold', 'heat') THEN result IN ('no_response', 'normal', 'exaggerated_non_lingering', 'exaggerated_lingering')
    WHEN test = 'ept' THEN result IN ('responsive', 'no_response')
    ELSE result IN ('not_tender', 'tender', 'very_tender') END),
  CONSTRAINT endo_test_ept_reading CHECK (ept_reading IS NULL OR (test = 'ept' AND result = 'responsive')),
  CONSTRAINT endo_test_lingering CHECK (lingering_seconds IS NULL OR test IN ('cold', 'heat')),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id)
);
SELECT protect_chart_table('endo_test', '{}');
CREATE INDEX endo_test_patient ON endo_test (org_id, patient_id);

CREATE TABLE endo_canal (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                 uuid NOT NULL,
  patient_id             uuid NOT NULL,
  encounter_id           uuid NOT NULL,
  tooth_instance_id      uuid NOT NULL,
  procedure_occurrence_id uuid NOT NULL,
  canal                  text NOT NULL CHECK (canal IN ('single', 'B', 'L', 'P', 'M', 'D', 'MB', 'MB2', 'DB', 'ML', 'DL', 'MB3', 'C_shaped')),
  status                 text NOT NULL DEFAULT 'located'
                         CHECK (status IN ('located', 'negotiated', 'instrumented', 'obturated', 'calcified', 'not_located')),
  reference_point        text,
  working_length_mm      numeric(3,1) CHECK (working_length_mm BETWEEN 5 AND 35 AND working_length_mm * 2 = trunc(working_length_mm * 2)),
  apex_locator_reading   text,
  master_apical_size     smallint CHECK (master_apical_size IN (6, 8, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100, 110, 120, 130, 140)),
  taper                  numeric(3,2) CHECK (taper BETWEEN 0.02 AND 0.12),
  instrumentation_system text,
  obturation_technique   text,
  obturation_material    text,
  sealer                 text,
  note                   text,
  recorded_by            uuid NOT NULL,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  updated_at             timestamptz,
  version                integer NOT NULL DEFAULT 1,
  supersedes_id          uuid REFERENCES endo_canal(id),
  amendment_id           uuid,
  locked_at              timestamptz,
  entered_in_error       boolean NOT NULL DEFAULT false,
  void_reason            text,
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id),
  FOREIGN KEY (org_id, procedure_occurrence_id) REFERENCES procedure_occurrence(org_id, id)
);
SELECT protect_chart_table('endo_canal', '{}');
CREATE INDEX endo_canal_procedure ON endo_canal (procedure_occurrence_id);
CREATE INDEX endo_canal_patient ON endo_canal (org_id, patient_id);

-- Each endo row's tooth must be the patient's own; a canal must belong to a root canal
-- procedure of the same visit, patient and tooth. The API checks this too.
CREATE OR REPLACE FUNCTION endo_entry_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tooth_patient uuid;
  v_proc procedure_occurrence%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.locked_at IS NOT NULL OR NEW.locked_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  SELECT patient_id INTO v_tooth_patient FROM tooth_instance WHERE id = NEW.tooth_instance_id;
  IF v_tooth_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'endodontic entry is on another patient''s tooth' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'endo_canal' THEN
    SELECT * INTO v_proc FROM procedure_occurrence WHERE id = NEW.procedure_occurrence_id;
    IF v_proc.id IS NULL OR v_proc.procedure_concept <> 'root_canal_therapy' OR v_proc.encounter_id <> NEW.encounter_id
       OR v_proc.patient_id <> NEW.patient_id OR v_proc.tooth_instance_id IS DISTINCT FROM NEW.tooth_instance_id THEN
      RAISE EXCEPTION 'a canal belongs to a root canal procedure on the same tooth in the same visit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER endo_diagnosis_guard BEFORE INSERT OR UPDATE ON endo_diagnosis FOR EACH ROW EXECUTE FUNCTION endo_entry_guard();
CREATE TRIGGER endo_test_guard BEFORE INSERT OR UPDATE ON endo_test FOR EACH ROW EXECUTE FUNCTION endo_entry_guard();
CREATE TRIGGER endo_canal_guard BEFORE INSERT OR UPDATE ON endo_canal FOR EACH ROW EXECUTE FUNCTION endo_entry_guard();

GRANT SELECT, INSERT, UPDATE ON endo_diagnosis, endo_test, endo_canal TO teeth_app;
