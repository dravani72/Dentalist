-- 0013 oral surgery records (MASTER_SPEC §10.8, Phase 6).
--
-- Three chart-entry tables, each recorded in a visit, locked when it is signed and changed
-- afterwards only by an amendment that supersedes the row:
--   surgical_detail   the structured record of an extraction: approach, impaction, flap, bone
--                     removal, sectioning, socket graft and membrane, sinus communication,
--                     hemostasis, sutures, complications, post-op instructions
--   biopsy_specimen   each specimen taken in a biopsy procedure: site, technique, size,
--                     clinical impression, fixative, pathology lab
--   biopsy_result     the pathology result for a specimen, recorded in the visit where the
--                     dentist reviews it (often a later one)
--
-- specimen_id is a specimen's lasting identity: the id of its first record, carried by every
-- amended version and by its result, so a result stays attached through amendments.

CREATE TABLE surgical_detail (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                  uuid NOT NULL,
  patient_id              uuid NOT NULL,
  encounter_id            uuid NOT NULL,
  tooth_instance_id       uuid NOT NULL,
  procedure_occurrence_id uuid NOT NULL,
  approach                text NOT NULL CHECK (approach IN ('simple', 'surgical')),
  impaction               text NOT NULL DEFAULT 'none' CHECK (impaction IN ('none', 'soft_tissue', 'partial_bony', 'full_bony')),
  angulation              text CHECK (angulation IN ('vertical', 'mesioangular', 'distoangular', 'horizontal', 'buccolingual', 'inverted')),
  pell_gregory_class      text CHECK (pell_gregory_class IN ('I', 'II', 'III')),
  pell_gregory_depth      text CHECK (pell_gregory_depth IN ('A', 'B', 'C')),
  flap                    text NOT NULL DEFAULT 'none' CHECK (flap IN ('none', 'envelope', 'triangular', 'trapezoidal')),
  bone_removal            boolean NOT NULL DEFAULT false,
  sectioned               boolean NOT NULL DEFAULT false,
  root_outcome            text NOT NULL DEFAULT 'complete' CHECK (root_outcome IN ('complete', 'root_tip_retained')),
  socket_graft_material   text,
  socket_graft_product    text,
  socket_graft_lot        text,
  membrane_product        text,
  membrane_lot            text,
  sinus_communication     text NOT NULL DEFAULT 'none' CHECK (sinus_communication IN ('none', 'suspected', 'confirmed')),
  sinus_closure           text CHECK (sinus_closure IN ('primary_closure', 'buccal_advancement_flap', 'collagen_plug', 'referred')),
  hemostasis_achieved     boolean NOT NULL,
  hemostasis_methods      text[] NOT NULL DEFAULT '{}'
                          CHECK (hemostasis_methods <@ ARRAY['pressure', 'collagen_sponge', 'oxidized_cellulose', 'sutures', 'tranexamic_acid', 'electrocautery', 'bone_wax']),
  suture_material         text CHECK (suture_material IN ('chromic_gut', 'plain_gut', 'polyglactin', 'polyglycolic_acid', 'ptfe', 'silk', 'nylon', 'polypropylene')),
  suture_size             text CHECK (suture_size IN ('3-0', '4-0', '5-0', '6-0')),
  suture_count            smallint CHECK (suture_count BETWEEN 1 AND 40),
  complications           text[] NOT NULL DEFAULT '{}'
                          CHECK (complications <@ ARRAY['root_fracture', 'crown_fracture', 'alveolar_bone_fracture', 'tuberosity_fracture', 'adjacent_tooth_damage',
                                                        'soft_tissue_injury', 'excess_bleeding', 'displaced_root', 'nerve_exposure', 'other']),
  postop_verbal           boolean NOT NULL DEFAULT false,
  postop_written          boolean NOT NULL DEFAULT false,
  note                    text,
  recorded_by             uuid NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  updated_at              timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  supersedes_id           uuid REFERENCES surgical_detail(id),
  amendment_id            uuid,
  locked_at               timestamptz,
  entered_in_error        boolean NOT NULL DEFAULT false,
  void_reason             text,
  -- A surgical extraction needed a flap, bone removal or sectioning; a simple one needed none.
  CONSTRAINT surgical_detail_approach CHECK ((approach = 'surgical') = (flap <> 'none' OR bone_removal OR sectioned)),
  CONSTRAINT surgical_detail_bony CHECK (impaction NOT IN ('partial_bony', 'full_bony') OR approach = 'surgical'),
  CONSTRAINT surgical_detail_impaction CHECK (impaction <> 'none' OR (angulation IS NULL AND pell_gregory_class IS NULL AND pell_gregory_depth IS NULL)),
  CONSTRAINT surgical_detail_root_tip CHECK (root_outcome = 'complete' OR note IS NOT NULL),
  CONSTRAINT surgical_detail_graft CHECK ((socket_graft_lot IS NULL OR socket_graft_product IS NOT NULL) AND (socket_graft_product IS NULL OR socket_graft_material IS NOT NULL)),
  CONSTRAINT surgical_detail_membrane CHECK (membrane_lot IS NULL OR membrane_product IS NOT NULL),
  CONSTRAINT surgical_detail_sinus CHECK (
    (sinus_communication = 'none' AND sinus_closure IS NULL)
    OR sinus_communication = 'suspected'
    OR (sinus_communication = 'confirmed' AND sinus_closure IS NOT NULL)),
  CONSTRAINT surgical_detail_sutures CHECK (
    (suture_material IS NULL AND suture_size IS NULL AND suture_count IS NULL)
    OR (suture_material IS NOT NULL AND suture_count IS NOT NULL)),
  CONSTRAINT surgical_detail_other CHECK (NOT ('other' = ANY (complications)) OR note IS NOT NULL),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, tooth_instance_id) REFERENCES tooth_instance(org_id, id),
  FOREIGN KEY (org_id, procedure_occurrence_id) REFERENCES procedure_occurrence(org_id, id)
);
SELECT protect_chart_table('surgical_detail', '{}');
CREATE INDEX surgical_detail_patient ON surgical_detail (org_id, patient_id);
CREATE INDEX surgical_detail_procedure ON surgical_detail (procedure_occurrence_id);

CREATE TABLE biopsy_specimen (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                  uuid NOT NULL,
  patient_id              uuid NOT NULL,
  encounter_id            uuid NOT NULL,
  specimen_id             uuid NOT NULL,
  procedure_occurrence_id uuid NOT NULL,
  site                    text NOT NULL,
  technique               text NOT NULL CHECK (technique IN ('incisional', 'excisional', 'punch', 'brush')),
  lesion_size_mm          numeric(4,1) CHECK (lesion_size_mm > 0 AND lesion_size_mm <= 100),
  appearance              text,
  clinical_impression     text NOT NULL,
  fixative                text NOT NULL CHECK (fixative IN ('formalin', 'fresh', 'other')),
  lab_name                text NOT NULL,
  container_label         text,
  note                    text,
  recorded_by             uuid NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  updated_at              timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  supersedes_id           uuid REFERENCES biopsy_specimen(id),
  amendment_id            uuid,
  locked_at               timestamptz,
  entered_in_error        boolean NOT NULL DEFAULT false,
  void_reason             text,
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, procedure_occurrence_id) REFERENCES procedure_occurrence(org_id, id)
);
SELECT protect_chart_table('biopsy_specimen', '{}');
CREATE INDEX biopsy_specimen_patient ON biopsy_specimen (org_id, patient_id);
CREATE INDEX biopsy_specimen_specimen ON biopsy_specimen (specimen_id);

CREATE TABLE biopsy_result (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                  uuid NOT NULL,
  patient_id              uuid NOT NULL,
  encounter_id            uuid NOT NULL,
  specimen_id             uuid NOT NULL,
  received_on             date NOT NULL,
  lab_accession           text,
  category                text NOT NULL CHECK (category IN ('benign', 'premalignant', 'malignant', 'non_diagnostic')),
  diagnosis               text NOT NULL,
  follow_up               text,
  patient_informed        boolean NOT NULL DEFAULT false,
  note                    text,
  recorded_by             uuid NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  updated_at              timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  supersedes_id           uuid REFERENCES biopsy_result(id),
  amendment_id            uuid,
  locked_at               timestamptz,
  entered_in_error        boolean NOT NULL DEFAULT false,
  void_reason             text,
  -- Anything but a benign result needs a recorded plan.
  CONSTRAINT biopsy_result_follow_up CHECK (category = 'benign' OR follow_up IS NOT NULL),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT protect_chart_table('biopsy_result', '{}');
CREATE INDEX biopsy_result_patient ON biopsy_result (org_id, patient_id);
CREATE INDEX biopsy_result_specimen ON biopsy_result (specimen_id);

-- A surgical record belongs to an extraction in the same visit, on that extraction's tooth; a
-- sinus communication can only happen on an upper tooth. A new specimen record starts its own
-- specimen unless it is an amended version of one, and belongs to a biopsy in the same visit.
-- A result points at a specimen of the same patient.
CREATE OR REPLACE FUNCTION oral_surgery_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_proc procedure_occurrence%ROWTYPE;
  v_arch text;
  v_specimen biopsy_specimen%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.locked_at IS NOT NULL OR NEW.locked_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'surgical_detail' THEN
    SELECT * INTO v_proc FROM procedure_occurrence WHERE id = NEW.procedure_occurrence_id;
    IF v_proc.id IS NULL OR v_proc.procedure_concept <> 'extraction' OR v_proc.encounter_id <> NEW.encounter_id
       OR v_proc.patient_id <> NEW.patient_id OR v_proc.tooth_instance_id IS DISTINCT FROM NEW.tooth_instance_id THEN
      RAISE EXCEPTION 'a surgical record belongs to an extraction on the same tooth in the same visit' USING ERRCODE = '23514';
    END IF;
    IF NEW.sinus_communication <> 'none' THEN
      SELECT dp.arch INTO v_arch FROM tooth_instance ti JOIN dental_position dp ON dp.id = ti.dental_position_id WHERE ti.id = NEW.tooth_instance_id;
      IF v_arch IS DISTINCT FROM 'maxillary' THEN
        RAISE EXCEPTION 'a sinus communication can only follow an upper extraction' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'biopsy_specimen' THEN
    IF TG_OP = 'INSERT' AND NEW.supersedes_id IS NULL THEN
      NEW.specimen_id := NEW.id;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.specimen_id <> OLD.specimen_id THEN
      RAISE EXCEPTION 'a specimen record cannot become another specimen' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_proc FROM procedure_occurrence WHERE id = NEW.procedure_occurrence_id;
    IF v_proc.id IS NULL OR v_proc.procedure_concept <> 'biopsy' OR v_proc.encounter_id <> NEW.encounter_id OR v_proc.patient_id <> NEW.patient_id THEN
      RAISE EXCEPTION 'a specimen belongs to a biopsy in the same visit' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.specimen_id <> OLD.specimen_id THEN
      RAISE EXCEPTION 'a result cannot move to another specimen' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_specimen FROM biopsy_specimen WHERE specimen_id = NEW.specimen_id ORDER BY version LIMIT 1;
    IF v_specimen.id IS NULL OR v_specimen.patient_id <> NEW.patient_id THEN
      RAISE EXCEPTION 'a pathology result belongs to one of the patient''s specimens' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER surgical_detail_guard BEFORE INSERT OR UPDATE ON surgical_detail FOR EACH ROW EXECUTE FUNCTION oral_surgery_guard();
CREATE TRIGGER biopsy_specimen_guard BEFORE INSERT OR UPDATE ON biopsy_specimen FOR EACH ROW EXECUTE FUNCTION oral_surgery_guard();
CREATE TRIGGER biopsy_result_guard BEFORE INSERT OR UPDATE ON biopsy_result FOR EACH ROW EXECUTE FUNCTION oral_surgery_guard();

GRANT SELECT, INSERT, UPDATE ON surgical_detail, biopsy_specimen, biopsy_result TO teeth_app;
