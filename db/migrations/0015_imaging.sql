-- 0015 diagnostic imaging (MASTER_SPEC §18, Phase 6): DICOM studies and their reads.
--
-- Two chart-entry tables, each recorded in a visit, locked when it is signed and changed
-- afterwards only by an amendment that supersedes the row:
--   imaging_study  one DICOM series (a CBCT volume, or a 2D DICOM radiograph): the header facts
--                  the chart needs, the original files (kept unaltered, encrypted, each with its
--                  SHA-256) and a derived viewing volume (also with its SHA-256), the region and
--                  teeth it covers, who took it, and how the patient identity in the files
--                  compared with the chart
--   imaging_read   the dentist's interpretation of a study: findings, impression, incidental
--                  findings and their follow-up, measurements, and (for a CBCT) the attestation
--                  that the whole volume was reviewed
--
-- study_id is a study's lasting identity: the id of its first record, carried by every amended
-- version and by its read. Patient names and other header identity stay in the original files
-- only; the table keeps the result of the comparison.

CREATE TABLE imaging_study (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                  uuid NOT NULL,
  patient_id              uuid NOT NULL,
  encounter_id            uuid NOT NULL,
  study_id                uuid NOT NULL,
  modality                text NOT NULL CHECK (modality IN ('cbct', 'panoramic', 'cephalometric', 'intraoral')),
  region                  text NOT NULL CHECK (region IN ('full_arch_both', 'maxilla', 'mandible', 'localized', 'tmj', 'sinus', 'other')),
  tooth_instance_ids      uuid[] NOT NULL DEFAULT '{}',
  description             text,
  dicom_modality          text NOT NULL,
  study_uid               text NOT NULL,
  series_uid              text NOT NULL,
  device_manufacturer     text,
  device_model            text,
  operator_id             uuid NOT NULL,
  acquired_at             timestamptz NOT NULL,
  kvp                     numeric(6,1),
  tube_current_ma         numeric(7,2),
  exposure_ms             numeric(9,1),
  rows                    integer NOT NULL CHECK (rows > 0),
  columns                 integer NOT NULL CHECK (columns > 0),
  slices                  integer NOT NULL CHECK (slices > 0),
  voxel_x_mm              numeric(8,4) NOT NULL CHECK (voxel_x_mm > 0),
  voxel_y_mm              numeric(8,4) NOT NULL CHECK (voxel_y_mm > 0),
  voxel_z_mm              numeric(8,4) NOT NULL CHECK (voxel_z_mm > 0),
  window_center           integer NOT NULL,
  window_width            integer NOT NULL CHECK (window_width > 0),
  patient_match           text NOT NULL CHECK (patient_match IN ('matched', 'confirmed_mismatch', 'confirmed_unidentified')),
  identity_confirmation   text,
  original_keys           text[] NOT NULL,
  original_sha256s        text[] NOT NULL,
  original_bytes          bigint NOT NULL,
  volume_key              text NOT NULL,
  volume_sha256           text NOT NULL,
  volume_bytes            bigint NOT NULL,
  note                    text,
  recorded_by             uuid NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  updated_at              timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  supersedes_id           uuid REFERENCES imaging_study(id),
  amendment_id            uuid,
  locked_at               timestamptz,
  entered_in_error        boolean NOT NULL DEFAULT false,
  void_reason             text,
  CONSTRAINT imaging_study_originals CHECK (cardinality(original_keys) = cardinality(original_sha256s) AND cardinality(original_keys) >= 1),
  -- A CBCT is a volume; a 2D radiograph is one image.
  CONSTRAINT imaging_study_shape CHECK ((modality = 'cbct') = (slices > 1)),
  -- Anything but a matching identity needs the uploader's reason it is still this patient.
  CONSTRAINT imaging_study_identity CHECK (patient_match = 'matched' OR identity_confirmation IS NOT NULL),
  CONSTRAINT imaging_study_localized CHECK (region <> 'localized' OR cardinality(tooth_instance_ids) > 0),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT protect_chart_table('imaging_study', '{}');
CREATE INDEX imaging_study_patient ON imaging_study (org_id, patient_id);
CREATE INDEX imaging_study_study ON imaging_study (study_id);

CREATE TABLE imaging_read (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                  uuid NOT NULL,
  patient_id              uuid NOT NULL,
  encounter_id            uuid NOT NULL,
  study_id                uuid NOT NULL,
  entire_volume_reviewed  boolean NOT NULL,
  findings                text NOT NULL,
  impression              text NOT NULL,
  incidental_findings     boolean NOT NULL DEFAULT false,
  referral                text,
  -- Straight-line measurements: label, plane, slice, two voxel points and the millimetres the
  -- server worked out from the study's voxel size. Checked by the API and bounded here.
  measurements            jsonb NOT NULL DEFAULT '[]'::jsonb
                          CHECK (jsonb_typeof(measurements) = 'array' AND jsonb_array_length(measurements) <= 20),
  note                    text,
  recorded_by             uuid NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  updated_at              timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  supersedes_id           uuid REFERENCES imaging_read(id),
  amendment_id            uuid,
  locked_at               timestamptz,
  entered_in_error        boolean NOT NULL DEFAULT false,
  void_reason             text,
  CONSTRAINT imaging_read_incidental CHECK (NOT incidental_findings OR referral IS NOT NULL),
  FOREIGN KEY (org_id, encounter_id) REFERENCES encounter(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT protect_chart_table('imaging_read', '{}');
CREATE INDEX imaging_read_patient ON imaging_read (org_id, patient_id);
CREATE INDEX imaging_read_study ON imaging_read (study_id);

-- A new study record starts its own study unless it is an amended version of one, and its
-- files never change. A read belongs to one of the patient's studies; a CBCT read attests the
-- whole volume was reviewed.
CREATE OR REPLACE FUNCTION imaging_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_study imaging_study%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.locked_at IS NOT NULL OR NEW.locked_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'imaging_study' THEN
    IF TG_OP = 'INSERT' AND NEW.supersedes_id IS NULL THEN
      NEW.study_id := NEW.id;
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.study_id <> OLD.study_id OR NEW.original_sha256s <> OLD.original_sha256s OR NEW.original_keys <> OLD.original_keys
                             OR NEW.volume_sha256 <> OLD.volume_sha256 OR NEW.volume_key <> OLD.volume_key) THEN
      RAISE EXCEPTION 'a study''s files never change; void it and upload again' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.supersedes_id IS NOT NULL THEN
      SELECT * INTO v_study FROM imaging_study WHERE id = NEW.supersedes_id;
      IF v_study.study_id <> NEW.study_id OR v_study.original_sha256s <> NEW.original_sha256s OR v_study.volume_sha256 <> NEW.volume_sha256 THEN
        RAISE EXCEPTION 'an amended study keeps its files and identity' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.study_id <> OLD.study_id THEN
      RAISE EXCEPTION 'a read cannot move to another study' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_study FROM imaging_study WHERE study_id = NEW.study_id ORDER BY version LIMIT 1;
    IF v_study.id IS NULL OR v_study.patient_id <> NEW.patient_id THEN
      RAISE EXCEPTION 'a read belongs to one of the patient''s imaging studies' USING ERRCODE = '23514';
    END IF;
    IF v_study.modality = 'cbct' AND NOT NEW.entire_volume_reviewed THEN
      RAISE EXCEPTION 'a CBCT read attests the whole volume was reviewed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER imaging_study_guard BEFORE INSERT OR UPDATE ON imaging_study FOR EACH ROW EXECUTE FUNCTION imaging_guard();
CREATE TRIGGER imaging_read_guard BEFORE INSERT OR UPDATE ON imaging_read FOR EACH ROW EXECUTE FUNCTION imaging_guard();

GRANT SELECT, INSERT, UPDATE ON imaging_study, imaging_read TO teeth_app;
