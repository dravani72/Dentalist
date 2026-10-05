-- 0002 scheduling: resource-aware appointments (§7). The database itself refuses a double
-- booking of any provider, operatory or piece of equipment.

CREATE TABLE appointment_type (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id             uuid NOT NULL REFERENCES organization(id),
  name               text NOT NULL,
  chair_minutes      integer NOT NULL CHECK (chair_minutes > 0),
  provider_minutes   integer NOT NULL CHECK (provider_minutes >= 0),
  provider_kind      text NOT NULL DEFAULT 'dentist' CHECK (provider_kind IN ('dentist', 'hygienist', 'either')),
  online_bookable    boolean NOT NULL DEFAULT false,
  active             boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, id)
);
SELECT enable_tenant_rls('appointment_type');

CREATE TABLE appointment (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id                  uuid NOT NULL,
  location_id             uuid NOT NULL,
  patient_id              uuid NOT NULL,
  appointment_type_id     uuid NOT NULL,
  start_at                timestamptz NOT NULL,
  end_at                  timestamptz NOT NULL,
  status                  text NOT NULL DEFAULT 'scheduled'
                          CHECK (status IN ('scheduled', 'confirmed', 'checked_in', 'in_chair', 'completed', 'cancelled', 'no_show')),
  confirmation_state      text NOT NULL DEFAULT 'unconfirmed' CHECK (confirmation_state IN ('unconfirmed', 'reminder_sent', 'confirmed')),
  provider_active_minutes integer,
  chair_minutes           integer GENERATED ALWAYS AS ((extract(epoch FROM (end_at - start_at)) / 60)::integer) STORED,
  note                    text,
  status_reason           text,
  encounter_id            uuid,
  created_by              uuid NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  updated_at              timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  CHECK (end_at > start_at),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, location_id) REFERENCES location(org_id, id),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id),
  FOREIGN KEY (org_id, appointment_type_id) REFERENCES appointment_type(org_id, id)
);
SELECT enable_tenant_rls('appointment');
CREATE INDEX appointment_day ON appointment (org_id, location_id, start_at);
CREATE INDEX appointment_patient ON appointment (org_id, patient_id, start_at);

-- Every resource an appointment occupies. `during` and `active` are copied from the
-- appointment so the exclusion constraint can see them.
CREATE TABLE appointment_resource (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id         uuid NOT NULL,
  appointment_id uuid NOT NULL,
  resource_kind  text NOT NULL CHECK (resource_kind IN ('provider', 'operatory', 'equipment', 'patient')),
  resource_id    uuid NOT NULL,
  during         tstzrange NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  FOREIGN KEY (org_id, appointment_id) REFERENCES appointment(org_id, id),
  CONSTRAINT no_double_booking EXCLUDE USING gist (
    org_id WITH =, resource_id WITH =, during WITH &&
  ) WHERE (active)
);
SELECT enable_tenant_rls('appointment_resource');

CREATE TABLE appointment_procedure (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id               uuid NOT NULL,
  appointment_id       uuid NOT NULL,
  planned_procedure_id uuid NOT NULL,
  FOREIGN KEY (org_id, appointment_id) REFERENCES appointment(org_id, id)
);
SELECT enable_tenant_rls('appointment_procedure');

CREATE TABLE recall (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id          uuid NOT NULL,
  patient_id      uuid NOT NULL,
  recall_type     text NOT NULL CHECK (recall_type IN ('hygiene', 'perio_maintenance', 'exam', 'other')),
  interval_months integer NOT NULL CHECK (interval_months BETWEEN 1 AND 36),
  last_visit_date date NOT NULL,
  due_date        date NOT NULL,
  status          text NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'scheduled', 'completed', 'inactive')),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('recall');

CREATE TABLE waitlist_entry (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id              uuid NOT NULL,
  patient_id          uuid NOT NULL,
  location_id         uuid NOT NULL,
  appointment_type_id uuid NOT NULL,
  minutes_needed      integer NOT NULL,
  note                text,
  status              text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'booked', 'removed')),
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, patient_id) REFERENCES patient(org_id, id)
);
SELECT enable_tenant_rls('waitlist_entry');
