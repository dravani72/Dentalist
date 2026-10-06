import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session, World, setupWorld, slot } from './helpers';

/*
 * Patients tab filters: recall (the active cycle of care), next appointment, open treatment,
 * provider, age group and balance; plus the hygiene recall that signing a cleaning or periodic
 * exam restarts.
 */

let w: World;
let amy: Session; // dentist: billing.read
let jane: Session; // assistant: no billing access
let frank: Session; // front desk
let omar: Session; // dentist at the other practice
let today = '';
const ids: Record<string, string> = {};

const FAMILY = 'Filtertest';

async function newPatient(given: string, dob = '1980-06-15') {
  const r = await frank.post('/api/patients', { legalGivenName: given, legalFamilyName: FAMILY, dateOfBirth: dob, homeLocationId: w.maple.locationId });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Given names of this suite's patients matching the filters, sorted. */
async function names(s: Session, filters: Record<string, string>) {
  const r = await s.get(`/api/patients?${new URLSearchParams({ q: FAMILY, ...filters })}`);
  expect(r.status).toBe(200);
  return (r.body as { legal_given_name: string }[]).map((p) => p.legal_given_name).sort();
}

const COMPOSITE = {
  tooth: '30', surfaces: ['M', 'O', 'D'], procedureConcept: 'direct_restoration_composite',
  details: { shade: 'A2', isolation: 'rubber dam', matrix_system: 'sectional', contact_verified: true, occlusion_verified: true },
};

/** Charts the given procedures (a concept name means a mouth-level procedure), verifies and signs the visit. */
async function signedVisit(patientId: string, procedures: (string | object)[]) {
  const e = await jane.post('/api/encounters', { patientId, locationId: w.maple.locationId, chiefComplaint: 'Synthetic recall visit' });
  expect(e.status).toBe(201);
  const procIds: string[] = [];
  for (const proc of procedures) {
    const body = typeof proc === 'string' ? { procedureConcept: proc } : proc;
    const p = await jane.post(`/api/encounters/${e.body.id}/procedures`, { ...body, performedBy: [w.maple.staff.amy!.staffId] });
    expect(p.status).toBe(201);
    expect((await jane.post(`/api/procedures/${p.body.id}/status`, { to: 'PERFORMED' })).status).toBe(201);
    procIds.push(p.body.id);
  }
  expect((await jane.post(`/api/encounters/${e.body.id}/transition`, { to: 'READY_FOR_REVIEW' })).status).toBe(201);
  expect((await amy.post(`/api/encounters/${e.body.id}/verify`, { procedureIds: procIds })).status).toBe(201);
  await amy.stepUp();
  expect((await amy.post(`/api/encounters/${e.body.id}/sign`, { attestation: true })).status).toBe(201);
  return e.body.id as string;
}

async function recalls(patientId: string) {
  const r = await w.owner.query('SELECT recall_type, interval_months, last_visit_date::text, due_date::text, status FROM recall WHERE patient_id = $1 ORDER BY created_at', [patientId]);
  return r.rows as { recall_type: string; interval_months: number; last_visit_date: string; due_date: string; status: string }[];
}

beforeAll(async () => {
  w = await setupWorld();
  [amy, jane, frank, omar] = await Promise.all([w.login(w.maple, 'amy'), w.login(w.maple, 'jane'), w.login(w.maple, 'frank'), w.login(w.river, 'omar')]);
  const tz = await w.owner.query('SELECT (now() AT TIME ZONE time_zone)::date::text AS d FROM location WHERE id = $1', [w.maple.locationId]);
  today = tz.rows[0].d;

  // Overdue: last cleaning two years ago on a 6-month recall.
  ids.Olive = await newPatient('Olive');
  expect((await frank.post('/api/recalls', { patientId: ids.Olive, recallType: 'hygiene', intervalMonths: 6, lastVisitDate: addDays(today, -730) })).status).toBe(201);
  // Due within 30 days, and already booked with Dr. Lee.
  ids.Dana = await newPatient('Dana');
  expect((await frank.post('/api/recalls', { patientId: ids.Dana, recallType: 'hygiene', intervalMonths: 1, lastVisitDate: addDays(today, -15) })).status).toBe(201);
  const appt = await frank.post('/api/appointments', {
    patientId: ids.Dana, locationId: w.maple.locationId, appointmentTypeId: w.maple.appointmentTypes.exam, providerIds: [w.maple.staff.lee!.staffId],
    operatoryId: w.maple.operatoryIds[0], plannedProcedureIds: [], start: slot('2031-02-03', '09:00'), end: slot('2031-02-03', '10:00'),
  });
  expect(appt.status).toBe(201);
  // No recall, but accepted treatment that is not booked yet.
  ids.Theo = await newPatient('Theo');
  const e = await jane.post('/api/encounters', { patientId: ids.Theo, locationId: w.maple.locationId, chiefComplaint: 'Synthetic exam' });
  const plan = await amy.post(`/api/encounters/${e.body.id}/planned-procedures`, { tooth: '30', surfaces: ['O'], procedureConcept: 'direct_restoration_composite', status: 'PATIENT_ACCEPTED' });
  expect(plan.status).toBe(201);
  // Nothing in progress: not in recall.
  ids.Nell = await newPatient('Nell');
  // A child, no recall.
  ids.Kit = await newPatient('Kit', addDays(today, -365 * 9));
  // Over 65.
  ids.Ruth = await newPatient('Ruth', '1950-01-01');
});

afterAll(async () => {
  await w?.close();
});

describe('patient filters', () => {
  it('recall lists current patients in an active cycle of care: open recall or unfinished treatment', async () => {
    expect(await names(frank, { recall: 'active' })).toEqual(['Dana', 'Olive', 'Theo']);
    expect(await names(frank, { recall: 'overdue' })).toEqual(['Olive']);
    expect(await names(frank, { recall: 'due_30' })).toEqual(['Dana']);
  });

  it('returns the recall due date, next appointment and open treatment for each row', async () => {
    const r = await frank.get(`/api/patients?q=${FAMILY}&recall=active`);
    // Recall lists sort by due date, soonest (most overdue) first; treatment-only patients last.
    expect(r.body.map((p: { legal_given_name: string }) => p.legal_given_name)).toEqual(['Olive', 'Dana', 'Theo']);
    const [olive, dana, theo] = r.body;
    expect(olive.recall_due < today).toBe(true);
    expect(olive.next_appointment_at).toBeNull();
    expect(dana.next_appointment_at).toBe(slot('2031-02-03', '09:00'));
    expect(theo.recall_due).toBeNull();
    expect(theo.open_treatment).toBe(1);
    expect(theo.unscheduled_treatment).toBe(1);
  });

  it('combines filters: in recall with nothing booked', async () => {
    expect(await names(frank, { recall: 'active', appointment: 'none' })).toEqual(['Olive', 'Theo']);
    expect(await names(frank, { appointment: 'booked' })).toEqual(['Dana']);
    expect(await names(frank, { treatment: 'unscheduled' })).toEqual(['Theo']);
  });

  it('filters by provider and by age group', async () => {
    expect(await names(frank, { providerId: w.maple.staff.lee!.staffId })).toEqual(['Dana']);
    expect(await names(frank, { age: 'child' })).toEqual(['Kit']);
    expect(await names(frank, { age: 'senior' })).toEqual(['Ruth']);
    expect(await names(frank, { age: 'adult' })).toEqual(['Dana', 'Nell', 'Olive', 'Theo']);
  });

  it('works without a search term, and treats empty values as "any"', async () => {
    const r = await frank.get('/api/patients?recall=overdue&appointment=&age=');
    expect(r.status).toBe(200);
    expect(r.body.map((p: { id: string }) => p.id)).toEqual([ids.Olive]);
  });

  it('rejects unknown filter values', async () => {
    expect((await frank.get('/api/patients?recall=sometime')).status).toBe(422);
    expect((await frank.get('/api/patients?providerId=not-a-uuid')).status).toBe(422);
  });

  it('keeps each practice to its own patients', async () => {
    const r = await omar.get('/api/patients?recall=active');
    expect(r.status).toBe(200);
    expect(r.body.some((p: { id: string }) => Object.values(ids).includes(p.id))).toBe(false);
    expect(await names(omar, {})).toEqual([]);
  });

  it('audits the search with its filters but never the search text', async () => {
    await frank.get(`/api/patients?q=${FAMILY}&recall=overdue`);
    const a = await w.owner.query("SELECT details FROM audit_event WHERE action = 'patient.search' ORDER BY seq DESC LIMIT 1");
    expect(a.rows[0].details.filters).toEqual({ recall: 'overdue' });
    expect(JSON.stringify(a.rows[0].details)).not.toContain(FAMILY);
  });
});

describe('balance filter', () => {
  it('needs billing access to filter by balance, and hides the amount from staff without it', async () => {
    const denied = await jane.get('/api/patients?balance=owes');
    expect(denied.status).toBe(403);
    const plain = await jane.get(`/api/patients?q=${FAMILY}`);
    expect(plain.status).toBe(200);
    expect(plain.body[0]).not.toHaveProperty('patient_due_cents');
    const withBilling = await amy.get(`/api/patients?q=${FAMILY}`);
    expect(withBilling.body[0]).toHaveProperty('patient_due_cents');
  });

  it('finds patients who owe a balance', async () => {
    expect(await names(amy, { balance: 'owes' })).toEqual([]);
    await signedVisit(ids.Nell!, ['periodic_exam']);
    const bea = await w.login(w.maple, 'bea');
    expect((await bea.post(`/api/patients/${ids.Nell}/charges`, {})).status).toBe(201);
    expect(await names(amy, { balance: 'owes' })).toEqual(['Nell']);
  });
});

describe('hygiene recall from signed visits', () => {
  it('starts a six-month recall when a cleaning is signed', async () => {
    await signedVisit(ids.Ruth!, ['prophylaxis']);
    const r = await recalls(ids.Ruth!);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ recall_type: 'hygiene', interval_months: 6, last_visit_date: today, status: 'due' });
    expect(await names(frank, { recall: 'active', age: 'senior' })).toEqual(['Ruth']);
    const a = await w.owner.query("SELECT details FROM audit_event WHERE action = 'recall.create' AND patient_id = $1", [ids.Ruth]);
    expect(a.rows[0].details.source).toBe('encounter.sign');
  });

  it('completes the open recall and keeps the patient\'s own interval', async () => {
    await signedVisit(ids.Olive!, ['prophylaxis', 'periodic_exam']);
    const r = await recalls(ids.Olive!);
    expect(r.map((x) => x.status)).toEqual(['completed', 'due']);
    expect(r[1]).toMatchObject({ interval_months: 6, last_visit_date: today });
    expect(await names(frank, { recall: 'overdue' })).toEqual([]);
  });

  it('leaves recall alone for visits without a cleaning or exam', async () => {
    await signedVisit(ids.Kit!, [COMPOSITE]);
    expect(await recalls(ids.Kit!)).toEqual([]);
  });
});
