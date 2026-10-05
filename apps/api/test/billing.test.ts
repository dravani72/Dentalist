import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { OutboxWorker } from '../src/outbox/outbox.worker';
import { SYNTHETIC_PASSWORD } from '../src/scripts/fixtures';
import { Session, TEST_DB, World, setupWorld } from './helpers';

/*
 * Revenue cycle: charges from signed work only, an append-only ledger, insurance estimates,
 * claims through the synthetic clearinghouse, and remittance posting (once).
 * Fees and codes are the invented SYNTHETIC set (see src/billing/synthetic-codes.ts).
 */

let w: World;
let amy: Session; // dentist: billing.read only
let jane: Session; // assistant: no billing access
let frank: Session; // front desk: billing.read, payment.post, insurance.manage
let bea: Session; // billing: charges, adjustments, claims (+ fee_schedule.manage in the fixture)
let worker: OutboxWorker;

const COMPOSITE_MOLAR_3 = 28000; // SYN-213
const EXAM = 6500; // SYN-101

async function drain() {
  for (let i = 0; i < 10 && (await worker.runOnce()) > 0; i++);
}

async function newPatient(given: string) {
  const r = await frank.post('/api/patients', { legalGivenName: given, legalFamilyName: 'Billingtest', dateOfBirth: '1975-03-03', homeLocationId: w.maple.locationId });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

/** Charts an exam and a 3-surface composite on #30, verifies and signs the visit. */
async function signedVisit(patientId: string) {
  const e = await jane.post('/api/encounters', { patientId, locationId: w.maple.locationId, chiefComplaint: 'Synthetic billing visit' });
  expect(e.status).toBe(201);
  const id = e.body.id as string;
  const exam = await jane.post(`/api/encounters/${id}/procedures`, { procedureConcept: 'periodic_exam', performedBy: [w.maple.staff.amy!.staffId] });
  expect(exam.status).toBe(201);
  const fill = await jane.post(`/api/encounters/${id}/procedures`, {
    tooth: '30', surfaces: ['M', 'O', 'D'], procedureConcept: 'direct_restoration_composite', performedBy: [w.maple.staff.amy!.staffId],
    details: { shade: 'A2', isolation: 'rubber dam', matrix_system: 'sectional', contact_verified: true, occlusion_verified: true },
  });
  expect(fill.status).toBe(201);
  for (const p of [exam.body.id, fill.body.id]) {
    const r = await jane.post(`/api/procedures/${p}/status`, { to: 'PERFORMED' });
    expect(r.status).toBe(201);
  }
  expect((await jane.post(`/api/encounters/${id}/transition`, { to: 'READY_FOR_REVIEW' })).status).toBe(201);
  expect((await amy.post(`/api/encounters/${id}/verify`, { procedureIds: [exam.body.id, fill.body.id] })).status).toBe(201);
  await amy.stepUp();
  expect((await amy.post(`/api/encounters/${id}/sign`, { attestation: true })).status).toBe(201);
  return { encounterId: id, examId: exam.body.id as string, fillId: fill.body.id as string };
}

const coverage = { diagnostic: 100, preventive: 100, basic: 80, endodontic: 80, periodontic: 80, oral_surgery: 80, major: 50, implant: 50 };
function policy(memberId: string, payerId = w.maple.billing.inNetworkPayerId) {
  return { rank: 1, payerId, memberId, subscriberRelationship: 'self', annualMaxCents: 150000, deductibleCents: 5000, coverage, planName: 'Synthetic PPO' };
}

const auditCount = async (action: string, outcome = 'success') =>
  (await w.owner.query('SELECT count(*)::int AS n FROM audit_event WHERE action = $1 AND outcome = $2', [action, outcome])).rows[0].n as number;

let pid = '';
let visit: Awaited<ReturnType<typeof signedVisit>>;
let policyId = '';
let claimId = '';

beforeAll(async () => {
  w = await setupWorld();
  worker = w.app.get(OutboxWorker);
  [amy, jane, frank, bea] = (await Promise.all(['amy', 'jane', 'frank', 'bea'].map((k) => w.login(w.maple, k)))) as [Session, Session, Session, Session];
  pid = await newPatient('Bill');
  visit = await signedVisit(pid);
});

afterAll(async () => {
  await w.close();
});

describe('charges', () => {
  it('suggests the code when work is performed and posts charges only once the visit is signed', async () => {
    const before = await bea.get(`/api/patients/${pid}/billing`);
    expect(before.status).toBe(200);
    expect(before.body.ledger).toEqual([]);
    expect(before.body.unbilled.map((u: { billing_code: string }) => u.billing_code).sort()).toEqual(['SYN-101', 'SYN-213']);
    await drain();
    const after = await bea.get(`/api/patients/${pid}/billing`);
    const charges = after.body.ledger.filter((e: { kind: string }) => e.kind === 'charge');
    expect(charges.map((c: { amount_cents: number }) => c.amount_cents).sort()).toEqual([EXAM, COMPOSITE_MOLAR_3].sort());
    expect(after.body.unbilled).toEqual([]);
    expect(after.body.summary.balanceCents).toBe(EXAM + COMPOSITE_MOLAR_3);
  });

  it('never charges unsigned work', async () => {
    const other = await newPatient('Unsigned');
    const e = await jane.post('/api/encounters', { patientId: other, locationId: w.maple.locationId });
    await jane.post(`/api/encounters/${e.body.id}/procedures`, { procedureConcept: 'periodic_exam', performedBy: [w.maple.staff.amy!.staffId] });
    const r = await bea.post(`/api/patients/${other}/charges`, {});
    expect(r.status).toBe(201);
    expect(r.body.posted).toEqual([]);
  });

  it('keeps privileges explicit: an assistant sees no billing, front desk cannot post charges', async () => {
    expect((await jane.get(`/api/patients/${pid}/billing`)).status).toBe(403);
    expect((await frank.post(`/api/patients/${pid}/charges`, {})).status).toBe(403);
    expect((await amy.get(`/api/patients/${pid}/billing`)).status).toBe(200);
    expect((await amy.post('/api/adjustments', { patientId: pid, amountCents: -100, reason: 'courtesy', note: 'Synthetic' })).status).toBe(403);
    expect(await auditCount('charge.post', 'denied')).toBeGreaterThan(0);
  });

  it('keeps tenants apart', async () => {
    const omar = await w.login(w.river, 'omar');
    const r = await omar.get(`/api/patients/${pid}/billing`);
    expect([403, 404]).toContain(r.status);
  });
});

describe('insurance and estimates', () => {
  it('stores the member id encrypted and shows it masked', async () => {
    const r = await frank.post(`/api/patients/${pid}/insurance`, policy('SYN0012345'));
    expect(r.status).toBe(201);
    policyId = r.body.id;
    const raw = await w.owner.query('SELECT member_id_enc FROM insurance_policy WHERE id = $1', [policyId]);
    expect(raw.rows[0].member_id_enc).not.toContain('SYN0012345');
    const acct = await frank.get(`/api/patients/${pid}/billing`);
    expect(acct.body.policies[0].member_id_masked).toBe('••••2345');
    expect(acct.body.policies[0].payer_name).toBe('Synthetic Mutual Dental');
  });

  it('runs an eligibility check through the clearinghouse and keeps the answer', async () => {
    const r = await frank.post(`/api/insurance-policies/${policyId}/eligibility`);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('active');
    expect(r.body.remainingMaxCents).toBe(150000);
    const n = await w.owner.query('SELECT count(*)::int AS n FROM eligibility_check WHERE insurance_policy_id = $1', [policyId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('estimates plan items with the network fee, deductible and coverage percent', async () => {
    const e = await jane.post('/api/encounters', { patientId: pid, locationId: w.maple.locationId });
    const plan = await amy.post(`/api/encounters/${e.body.id}/planned-procedures`, { tooth: '19', procedureConcept: 'crown_ceramic', status: 'PROPOSED' });
    expect(plan.status).toBe(201);
    const est = await frank.get(`/api/patients/${pid}/estimate`);
    expect(est.status).toBe(200);
    const crown = est.body.lines.find((l: { plannedProcedureId: string }) => l.plannedProcedureId === plan.body.id);
    // Office 1,250.00; contract allows 1,000.00; 5,000 cents deductible; then 50%.
    expect(crown).toMatchObject({ code: 'SYN-301', feeCents: 125000, writeOffCents: 25000, coveragePercent: 50, insuranceCents: 47500, patientCents: 52500 });
    expect(est.body.insurance).toMatchObject({ inNetwork: true, source: 'eligibility' });
  });
});

describe('claims and remittance', () => {
  it('builds a claim from charges with an insurance estimate, and only claim.submit can send it', async () => {
    const acct = await bea.get(`/api/patients/${pid}/billing`);
    const chargeIds = acct.body.ledger.filter((e: { kind: string }) => e.kind === 'charge').map((e: { id: string }) => e.id);
    expect((await frank.post('/api/claims', { patientId: pid, insurancePolicyId: policyId, chargeIds })).status).toBe(403);
    const c = await bea.post('/api/claims', { patientId: pid, insurancePolicyId: policyId, chargeIds });
    expect(c.status).toBe(201);
    claimId = c.body.id;
    // Exam: 52.00 allowed at 100%. Filling: 224.00 allowed, 50.00 deductible, then 80%.
    expect(c.body.estInsuranceCents).toBe(5200 + 13920);
    const dup = await bea.post('/api/claims', { patientId: pid, insurancePolicyId: policyId, chargeIds });
    expect(dup.status).toBe(409);
    expect((await frank.post(`/api/claims/${claimId}/submit`)).status).toBe(403);
    const s = await bea.post(`/api/claims/${claimId}/submit`);
    expect(s.status).toBe(201);
    const procs = await w.owner.query('SELECT status FROM procedure_occurrence WHERE id = ANY($1)', [[visit.examId, visit.fillId]]);
    expect(procs.rows.map((r) => r.status)).toEqual(['CLAIMED', 'CLAIMED']);
  });

  it('freezes a sent claim', async () => {
    await expect(w.owner.query('UPDATE claim_line SET fee_cents = 1 WHERE claim_id = $1', [claimId])).rejects.toThrow(/frozen/);
  });

  it('sends from the outbox, then posts the payer’s remittance: payments and contract write-offs on each charge', async () => {
    await drain();
    const acct = await bea.get(`/api/patients/${pid}/billing`);
    const claim = acct.body.claims.find((c: { id: string }) => c.id === claimId);
    expect(claim.status).toBe('paid');
    expect(claim.events.map((e: { status: string }) => e.status)).toEqual(['draft', 'queued', 'accepted', 'paid']);
    const ins = acct.body.ledger.filter((e: { kind: string }) => e.kind === 'insurance_payment');
    expect(ins.reduce((a: number, e: { amount_cents: number }) => a + e.amount_cents, 0)).toBe(-(5200 + 13920));
    const wo = acct.body.ledger.filter((e: { adjustment_reason: string }) => e.adjustment_reason === 'contractual');
    expect(wo.reduce((a: number, e: { amount_cents: number }) => a + e.amount_cents, 0)).toBe(-((EXAM - 5200) + (COMPOSITE_MOLAR_3 - 22400)));
    // What is left is the patient's: the deductible and 20% of the rest of the filling.
    expect(acct.body.summary.balanceCents).toBe(5000 + 3480);
    expect(acct.body.summary.insurancePendingCents).toBe(0);
    const rem = await bea.get('/api/remittances');
    expect(rem.body).toHaveLength(1);
    expect(rem.body[0].total_paid_cents).toBe(19120);
  });

  it('posts a remittance only once', async () => {
    const n = (await w.owner.query("SELECT count(*)::int AS n FROM ledger_entry WHERE kind = 'insurance_payment'")).rows[0].n;
    const again = await bea.post('/api/remittances/fetch');
    expect(again.status).toBe(201);
    expect(again.body.posted).toBe(0);
    expect((await w.owner.query("SELECT count(*)::int AS n FROM ledger_entry WHERE kind = 'insurance_payment'")).rows[0].n).toBe(n);
    await expect(w.owner.query("INSERT INTO remittance (org_id, payer_id, clearinghouse_ref, trace_number, total_paid_cents, paid_on, claim_count) SELECT org_id, payer_id, clearinghouse_ref, 'x', 0, now(), 0 FROM remittance LIMIT 1")).rejects.toThrow(/duplicate/);
  });

  it('a rejected claim releases its procedures for a corrected claim', async () => {
    const p2 = await newPatient('Rejected');
    const v2 = await signedVisit(p2);
    await drain();
    const pol = await frank.post(`/api/patients/${p2}/insurance`, policy('WRONG-ID'));
    const acct = await bea.get(`/api/patients/${p2}/billing`);
    const chargeIds = acct.body.ledger.filter((e: { kind: string }) => e.kind === 'charge').map((e: { id: string }) => e.id);
    const c = await bea.post('/api/claims', { patientId: p2, insurancePolicyId: pol.body.id, chargeIds });
    await bea.post(`/api/claims/${c.body.id}/submit`);
    await drain();
    const after = await bea.get(`/api/patients/${p2}/billing`);
    expect(after.body.claims[0]).toMatchObject({ status: 'rejected', status_detail: 'Subscriber not found' });
    const procs = await w.owner.query('SELECT status FROM procedure_occurrence WHERE id = ANY($1)', [[v2.examId, v2.fillId]]);
    expect(procs.rows.map((r) => r.status)).toEqual(['SIGNED', 'SIGNED']);
    expect((await bea.post(`/api/claims/${c.body.id}/void`, { reason: 'Wrong member id' })).status).toBe(201);
    const fixed = await bea.post('/api/claims', { patientId: p2, insurancePolicyId: pol.body.id, chargeIds });
    expect(fixed.status).toBe(201);
  });
});

describe('payments and corrections', () => {
  it('applies a payment to the oldest charges and keeps the rest as credit; refunds never exceed the credit', async () => {
    expect((await frank.post('/api/payments', { patientId: pid, method: 'card_terminal', amountCents: 1000, receivedOn: '2026-01-01', reference: '4111 1111 1111 1111' })).status).toBe(422);
    const pay = await frank.post('/api/payments', { patientId: pid, method: 'cash', amountCents: 10000, receivedOn: new Date().toISOString().slice(0, 10) });
    expect(pay.status).toBe(201);
    expect(pay.body.creditCents).toBe(10000 - 8480);
    expect((await bea.post('/api/refunds', { patientId: pid, amountCents: 5000, method: 'check', note: 'Overpayment' })).status).toBe(409);
    expect((await bea.post('/api/refunds', { patientId: pid, amountCents: 1520, method: 'check', reference: 'CHK 1001', note: 'Overpayment' })).status).toBe(201);
    expect((await bea.get(`/api/patients/${pid}/billing`)).body.summary.balanceCents).toBe(0);
  });

  it('corrects by reversal, never by editing', async () => {
    const acct = await bea.get(`/api/patients/${pid}/billing`);
    const charge = acct.body.ledger.find((e: { kind: string }) => e.kind === 'charge');
    expect((await bea.post(`/api/ledger-entries/${charge.id}/reverse`, { note: 'Try' })).status).toBe(409);
    const payment = acct.body.ledger.find((e: { kind: string }) => e.kind === 'patient_payment');
    const r = await bea.post(`/api/ledger-entries/${payment.id}/reverse`, { note: 'Returned check (synthetic)' });
    expect(r.status).toBe(201);
    expect(r.body.reversed).toBeGreaterThan(1);
    expect((await bea.post(`/api/ledger-entries/${payment.id}/reverse`, { note: 'Twice' })).status).toBe(409);
    await expect(w.owner.query('UPDATE ledger_entry SET amount_cents = 0 WHERE id = $1', [charge.id])).rejects.toThrow(/append-only/);
    await expect(w.owner.query('DELETE FROM ledger_entry WHERE id = $1', [charge.id])).rejects.toThrow(/append-only/);
    const app = new Client({ connectionString: TEST_DB });
    await app.connect();
    try {
      await expect(app.query('UPDATE ledger_entry SET amount_cents = 0')).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
});

describe('fee schedules', () => {
  it('changes a fee from a date forward; earlier dates of service keep the old fee', async () => {
    const office = w.maple.billing.officeScheduleId;
    expect((await amy.post(`/api/fee-schedules/${office}/fees`, { code: 'SYN-101', amountCents: 7000, effectiveFrom: '2030-01-01' })).status).toBe(403);
    expect((await bea.post(`/api/fee-schedules/${office}/fees`, { code: 'SYN-101', amountCents: 7000, effectiveFrom: '2030-01-01' })).status).toBe(201);
    const now = await bea.get(`/api/fee-schedules/${office}`);
    expect(now.body.fees.find((f: { code: string }) => f.code === 'SYN-101')).toMatchObject({ amount_cents: EXAM, upcoming: { amount_cents: 7000 } });
    const later = await bea.get(`/api/fee-schedules/${office}?on=2030-06-01`);
    expect(later.body.fees.find((f: { code: string }) => f.code === 'SYN-101').amount_cents).toBe(7000);
  });
});

describe('portal billing', () => {
  async function portal(patientId: string, email: string, relationship: string, scopes: string[]) {
    const inv = await frank.post(`/api/patients/${patientId}/portal/invitations`, {
      email, inviteeName: 'Synthetic Person', relationship, scopes, ...(relationship === 'self' ? {} : { verificationNote: 'Synthetic test' }),
    });
    expect(inv.status).toBe(201);
    await w.http.post('/api/portal/auth/accept-invitation').send({ code: inv.body.code, email, displayName: 'Synthetic Person', password: SYNTHETIC_PASSWORD });
    const s = await w.http.post('/api/portal/auth/start').send({ email, password: SYNTHETIC_PASSWORD });
    const text = w.sender.sent.filter((m) => m.channel === 'email').at(-1)!.text;
    const v = await w.http.post('/api/portal/auth/verify').send({ challengeId: s.body.challengeId, code: /sign-in code is (\d{6})/.exec(text)![1] });
    return (path: string) => w.http.get(path).set('Authorization', `Bearer ${v.body.token}`);
  }

  it('shows the patient their balance, activity and an estimate for signed plan items only', async () => {
    const get = await portal(pid, 'bill.self@portal.example.test', 'self', ['appointments', 'billing']);
    const r = await get(`/api/portal/patients/${pid}/billing`);
    expect(r.status).toBe(200);
    // 84.80 owed, paid 100.00, refunded 15.20, then the payment bounced: 100.00 owed.
    expect(r.body.summary.balanceCents).toBe(10000);
    expect(r.body.activity.some((a: { kind: string }) => a.kind === 'insurance_payment')).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('Returned check');
    // The crown was planned in an unsigned visit, so the portal does not show it yet.
    expect(r.body.estimate.lines).toEqual([]);
    const me = await get('/api/portal/me');
    expect(me.body.patients[0].amountDueCents).toBe(10000);
  });

  it('needs the billing scope', async () => {
    const get = await portal(pid, 'bill.carer@portal.example.test', 'caregiver', ['appointments']);
    expect((await get(`/api/portal/patients/${pid}/billing`)).status).toBe(403);
  });
});
