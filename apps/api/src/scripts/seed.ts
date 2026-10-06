/* Loads synthetic demo data: two practices, staff with TOTP, patients, a day of appointments
 * and a multi-visit chart history for one patient. Clinical records are created through the
 * same services the API uses, so every rule (privileges, signing, audit) applies to the seed.
 *   npm run db:seed
 * All people and records are fictional.
 */
import 'reflect-metadata';
import { Client } from 'pg';
import { loadConfig } from '../config';
import { LocalFieldCipher } from '../crypto/keys';
import { createApp } from '../main';
import type { Actor } from '../auth/actor';
import { PatientsService } from '../patients/patients.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { ChartService } from '../charting/chart.service';
import { SigningService } from '../charting/signing.service';
import { MediaService } from '../media/media.service';
import { PrescribingService } from '../prescribing/prescribing.service';
import { PortalStaffService } from '../portal/portal-staff.service';
import { PortalAuthService } from '../portal/portal-auth.service';
import { BillingService } from '../billing/billing.service';
import { ClaimsService } from '../billing/claims.service';
import { DEFAULT_SCOPES, PORTAL_SCOPES } from '@teeth/shared';
import { MAPLE, RIVERBEND, SYNTHETIC_PASSWORD, createTenant, scriptedActor } from './fixtures';
import { XrayTooth, syntheticXraySvg } from './synthetic-xray';
import { publishSyntheticJurisdictions } from '../telehealth/registry';

async function main() {
  const config = loadConfig();
  const owner = new Client({ connectionString: config.databaseOwnerUrl });
  await owner.connect();
  const existing = await owner.query("SELECT 1 FROM organization WHERE name = $1", [MAPLE.orgName]);
  if (existing.rowCount) {
    console.log('Synthetic data already present. Run npm run db:reset to start over.');
    await owner.end();
    return;
  }
  const cipher = new LocalFieldCipher(config.localKeyDir);
  // Development only: the synthetic test jurisdictions ZZ and ZY (refused in production).
  await publishSyntheticJurisdictions(owner);
  const maple = await createTenant(owner, cipher, MAPLE);
  const river = await createTenant(owner, cipher, RIVERBEND);

  const app = await createApp();
  await app.init();
  const patients = app.get(PatientsService);
  const scheduling = app.get(SchedulingService);
  const chart = app.get(ChartService);
  const signing = app.get(SigningService);
  const media = app.get(MediaService);
  const rx = app.get(PrescribingService);
  const portalStaff = app.get(PortalStaffService);
  const portalAuth = app.get(PortalAuthService);

  const amy = await scriptedActor(owner, maple, 'amy');
  const lee = await scriptedActor(owner, maple, 'lee');
  const jane = await scriptedActor(owner, maple, 'jane');
  const frank = await scriptedActor(owner, maple, 'frank');

  // ---------------------------------------------------------------- patients
  const mk = (given: string, family: string, dob: string, extra: Record<string, unknown> = {}) =>
    patients.create(frank, { legalGivenName: given, legalFamilyName: family, dateOfBirth: dob, sexAtBirth: 'unknown', preferredLanguage: 'en', homeLocationId: maple.locationId, phone: '555-0199', ...extra });
  const jordan = await mk('Jordan', 'Rivera', '1984-03-12', { email: 'jordan.rivera@patients.example.test' });
  const others = [
    await mk('Priya', 'Natarajan', '1991-07-30'),
    await mk('Samuel', 'Okafor', '1958-11-02'),
    await mk('Lena', 'Kowalski', '2014-05-19'),
    await mk('Hector', 'Alvarez', '1976-01-25'),
    await mk('Mei', 'Tanaka', '1989-09-09'),
  ];
  await patients.addHistory(amy, 'allergy', jordan.id, { substance: 'Penicillin', reaction: 'Hives', severity: 'moderate', source: 'patient_reported' });
  await patients.addHistory(amy, 'medication_statement', jordan.id, { medication: 'Lisinopril 10 mg', dose: '10 mg', frequency: 'daily', isAnticoagulant: false, source: 'patient_reported' });
  await patients.addHistory(amy, 'medical_condition', jordan.id, { condition: 'Hypertension, controlled', source: 'patient_reported' });
  await patients.addHistory(amy, 'medication_statement', others[1]!.id, { medication: 'Warfarin 5 mg', dose: '5 mg', frequency: 'daily', isAnticoagulant: true, source: 'external_record' });
  await patients.reviewHistory(amy, jordan.id);
  const pharmacies = await rx.searchPharmacies(frank, { zip: '62701' });
  await rx.setPreference(frank, jordan.id, { partnerPharmacyId: pharmacies[0]!.partnerPharmacyId, rank: 'primary' });
  await rx.setPreference(frank, jordan.id, { partnerPharmacyId: pharmacies.find((p) => p.open24h)!.partnerPharmacyId, rank: '24_hour' });

  // ---------------------------------------------------------------- chart history (signed visits)
  async function visit(by: Actor, date: string, complaint: string, xray: { label: string; modality: 'fmx' | 'bitewing' | 'periapical'; upper: (XrayTooth | null)[]; lower: (XrayTooth | null)[]; teeth: string[] }, record: (encounterId: string) => Promise<void>, sign = true) {
    const { id } = await chart.openEncounter(by, { patientId: jordan.id, locationId: maple.locationId, chiefComplaint: complaint });
    await media.upload(by, id, {
      modality: xray.modality,
      contentType: 'image/svg+xml',
      dataBase64: Buffer.from(syntheticXraySvg(`${xray.label} · ${date}`, xray.upper, xray.lower)).toString('base64'),
      teeth: xray.teeth,
      acquiredAt: `${date}T14:00:00Z`,
    });
    await record(id);
    // Backdate the visit while it is still a draft (synthetic history only).
    for (const t of ['clinical_finding', 'existing_restoration', 'planned_procedure', 'procedure_occurrence', 'anesthetic_event', 'encounter_note', 'media_object']) {
      await owner.query(`UPDATE ${t} SET recorded_at = $2::date + time '14:30' WHERE encounter_id = $1`, [id, date]);
    }
    await owner.query(
      "UPDATE procedure_occurrence SET started_at = $2::date + time '14:30', completed_at = CASE WHEN completed_at IS NULL THEN NULL ELSE $2::date + time '15:30' END WHERE encounter_id = $1",
      [id, date],
    );
    await owner.query("UPDATE encounter SET opened_at = $2::date + time '14:00' WHERE id = $1", [id, date]);
    if (!sign) return id;
    await signing.transition(jane, id, 'READY_FOR_REVIEW');
    const enc = await chart.getEncounter(by, id);
    await signing.verify(by, id, (enc.entries.procedure as { id: string }[]).map((p) => p.id));
    await signing.sign(by, id);
    return id;
  }
  const full = (n: number[]): XrayTooth[] => n.map((u) => ({ universal: u }));
  const fmxUpper = full([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const fmxLower = full([32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17]);
  const mark = (row: XrayTooth[], u: number, m: Partial<XrayTooth>) => row.map((t) => (t.universal === u ? { ...t, ...m } : t));

  // Visit 1: new-patient exam, 2019
  let up = mark(mark(mark(fmxUpper, 1, { missing: true }), 16, { missing: true }), 14, { restoration: 'O' });
  let low = mark(mark(mark(fmxLower, 17, { missing: true }), 32, { missing: true }), 30, { restoration: 'MOD' });
  await visit(lee, '2019-04-10', 'New patient comprehensive exam', { label: 'FMX', modality: 'fmx', upper: up, lower: low, teeth: [] }, async (id) => {
    for (const t of ['1', '16', '17', '32']) await chart.addFinding(lee, id, { tooth: t, category: 'anatomic', findingType: 'missing', surfaces: [], certainty: 'historical' });
    await chart.addExisting(lee, id, { tooth: '14', treatmentType: 'composite', surfaces: ['O'] });
    await chart.addExisting(lee, id, { tooth: '30', treatmentType: 'amalgam', surfaces: ['M', 'O', 'D'], note: 'Large MOD amalgam, margins intact at intake.' });
    await chart.addExisting(lee, id, { tooth: '31', treatmentType: 'sealant', surfaces: ['O'] });
    await chart.addFinding(lee, id, { tooth: '19', category: 'pathology', findingType: 'caries', surfaces: ['O', 'D'], certainty: 'suspected', note: 'Watch. Re-evaluate at recall.' });
  });

  // Visit 2: emergency, root canal #19, crown planned
  let crown19 = '';
  await visit(amy, '2021-02-03', 'Pain lower left', { label: 'PA #19', modality: 'periapical', upper: [], lower: [{ universal: 20 }, { universal: 19, lesion: true }, { universal: 18 }], teeth: ['19'] }, async (id) => {
    await chart.addFinding(amy, id, { tooth: '19', category: 'pathology', findingType: 'periapical_lesion', surfaces: [], certainty: 'confirmed', note: 'Irreversible pulpitis with apical radiolucency, distal root.' });
    const p = await chart.addProcedure(amy, id, {
      tooth: '19', surfaces: [], procedureConcept: 'root_canal_therapy', performedBy: [amy.staffId], assistedBy: [jane.staffId],
      details: { isolation: 'rubber dam', canals: 'MB, ML, D', obturation: 'Gutta-percha, warm vertical' },
      anesthetics: [{ drug: 'Articaine', concentration: '4%', vasoconstrictor: '1:100,000 epinephrine', amountMl: 1.7, route: 'Inferior alveolar nerve block', administeredAt: '2021-02-03T14:20:00Z', administeredBy: amy.staffId }],
    });
    await chart.procedureStatus(amy, p!.id, 'PERFORMED');
    const plan = await chart.addPlanned(amy, id, { tooth: '19', surfaces: [], procedureConcept: 'crown_ceramic', status: 'PATIENT_ACCEPTED', phase: 1, priority: 'high', findingIds: [], diagnosisIds: [] });
    crown19 = plan!.id;
  });

  // Visit 3: crown delivery #19 (fulfils the plan item)
  await visit(amy, '2021-03-17', 'Crown delivery #19', { label: 'PA #19', modality: 'periapical', upper: [], lower: [{ universal: 20 }, { universal: 19, crown: true, rootCanal: true }, { universal: 18 }], teeth: ['19'] }, async (id) => {
    const p = await chart.addProcedure(jane, id, {
      tooth: '19', surfaces: [], procedureConcept: 'crown_ceramic', plannedProcedureId: crown19, performedBy: [amy.staffId], assistedBy: [jane.staffId],
      details: { shade: 'A2', cement: 'RMGI', contact_verified: true, occlusion_verified: true, lab_case_reference: 'LAB-SYN-2207' }, anesthetics: [],
    });
    await chart.procedureStatus(jane, p!.id, 'PERFORMED');
  });

  // Visit 4: recall 2023, crown #3
  await visit(amy, '2023-08-22', 'Recall exam', { label: 'BWX', modality: 'bitewing', upper: full([2, 3, 4, 5, 12, 13, 14, 15]), lower: full([31, 30, 29, 28, 21, 20, 19, 18]).map((t) => (t.universal === 19 ? { ...t, crown: true } : t.universal === 30 ? { ...t, restoration: 'MOD' } : t)), teeth: [] }, async (id) => {
    await chart.addFinding(amy, id, { tooth: '3', category: 'pathology', findingType: 'fracture', surfaces: ['D', 'L'], certainty: 'confirmed', note: 'Fractured DL cusp, symptomatic on biting.' });
    await chart.addFinding(amy, id, { tooth: '29', category: 'pathology', findingType: 'abfraction', surfaces: ['B'], certainty: 'confirmed' });
    await chart.addPlanned(amy, id, { tooth: '29', surfaces: ['B'], procedureConcept: 'direct_restoration_composite', status: 'PROPOSED', phase: 2, priority: 'routine', findingIds: [], diagnosisIds: [], note: 'Restore if sensitivity continues.' });
    const p = await chart.addProcedure(jane, id, {
      tooth: '3', surfaces: [], procedureConcept: 'crown_ceramic', performedBy: [amy.staffId], assistedBy: [jane.staffId],
      details: { shade: 'A2', cement: 'resin', contact_verified: true, occlusion_verified: true }, anesthetics: [],
    });
    await chart.procedureStatus(jane, p!.id, 'PERFORMED');
  });

  // ---------------------------------------------------------------- billing history
  // Charges for the signed visits (invented SYNTHETIC codes and fees). The 2021 work was paid by
  // Jordan before they had dental insurance; the 2023 crown went to Synthetic Mutual and Jordan
  // has paid part of their share, so the portal shows a balance due.
  const bea = await scriptedActor(owner, maple, 'bea');
  const billing = app.get(BillingService);
  const claims = app.get(ClaimsService);
  await billing.postCharges(bea, jordan.id);
  const policy = await billing.savePolicy(frank, jordan.id, {
    rank: 1, payerId: maple.billing.inNetworkPayerId, memberId: 'SYN4417200', groupNumber: 'SYN-GRP-12', subscriberRelationship: 'self',
    planName: 'Synthetic Mutual PPO', annualMaxCents: 150000, deductibleCents: 5000, deductibleWaived: ['diagnostic', 'preventive'],
    coverage: { diagnostic: 100, preventive: 100, basic: 80, endodontic: 80, periodontic: 80, oral_surgery: 80, major: 50, implant: 50 },
    benefitYearStartMonth: 1, effectiveFrom: '2022-01-01',
  });
  await billing.checkEligibility(frank, policy.id);
  const charges = (await billing.account(bea, jordan.id)).ledger.filter((e) => e.kind === 'charge');
  const early = charges.filter((c) => (c.service_date ?? '') < '2022-01-01');
  for (const c of early) {
    await billing.postPayment(frank, { patientId: jordan.id, method: 'check', amountCents: c.amount_cents, receivedOn: c.service_date!, reference: `CHK ${1000 + early.indexOf(c)}` });
  }
  const crown3 = charges.filter((c) => (c.service_date ?? '') >= '2023-01-01').map((c) => c.id);
  const claim = await claims.create(bea, { patientId: jordan.id, insurancePolicyId: policy.id, chargeIds: crown3 });
  await claims.submit(bea, claim.id);
  await claims.transmit(maple.orgId, claim.id, 'seed');
  await claims.postRemittances(maple.orgId, 'seed');
  await billing.postPayment(frank, { patientId: jordan.id, method: 'card_terminal', amountCents: 20000, receivedOn: '2023-09-05', reference: 'Terminal receipt 0457' });

  // ---------------------------------------------------------------- today's schedule
  const today = new Date().toISOString().slice(0, 10);
  const at = (hhmm: string) => {
    // Local clinic time (America/Chicago) expressed with an explicit offset good enough for demo data.
    const d = new Date(`${today}T${hhmm}:00-05:00`);
    return d.toISOString();
  };
  const book = (patientId: string, type: string, start: string, end: string, op: number, provider: string) =>
    scheduling.create(frank, { patientId, locationId: maple.locationId, appointmentTypeId: maple.appointmentTypes[type]!, start: at(start), end: at(end), providerIds: [maple.staff[provider]!.staffId], operatoryId: maple.operatoryIds[op]!, plannedProcedureIds: [] });
  await book(others[0]!.id, 'hygiene', '08:00', '09:00', 2, 'rosa');
  await book(others[1]!.id, 'exam', '09:00', '10:00', 0, 'amy');
  await book(others[2]!.id, 'hygiene', '09:30', '10:30', 2, 'rosa');
  await book(others[3]!.id, 'crown', '10:00', '12:00', 1, 'lee');
  const jordanAppt = await book(jordan.id, 'restorative', '14:00', '15:30', 0, 'amy');
  await book(others[4]!.id, 'emergency', '15:30', '16:00', 1, 'amy');

  // Today's visit for Jordan: charted by the assistant, waiting for Dr. Jones's review.
  const { id: todayId } = await chart.openEncounter(jane, { patientId: jordan.id, locationId: maple.locationId, appointmentId: jordanAppt.id, chiefComplaint: 'Restorative visit' });
  await media.upload(jane, todayId, {
    modality: 'bitewing', contentType: 'image/svg+xml', teeth: [], acquiredAt: new Date().toISOString(),
    dataBase64: Buffer.from(syntheticXraySvg(`BWX · ${today}`, full([2, 3, 4, 5, 12, 13, 14, 15]).map((t) => (t.universal === 3 ? { ...t, crown: true } : t)), full([31, 30, 29, 28, 21, 20, 19, 18]).map((t) => (t.universal === 19 ? { ...t, crown: true, rootCanal: true } : t.universal === 30 ? { ...t, restoration: 'MOD', lesion: false } : t)))).toString('base64'),
  });
  await chart.addFinding(amy, todayId, { tooth: '8', category: 'pathology', findingType: 'fracture', surfaces: ['M', 'I'], certainty: 'confirmed', note: 'Chipped MI corner, asymptomatic.' });
  await chart.addPlanned(amy, todayId, { tooth: '8', surfaces: ['M', 'I'], procedureConcept: 'direct_restoration_composite', status: 'PATIENT_ACCEPTED', phase: 1, priority: 'routine', findingIds: [], diagnosisIds: [] });
  await chart.addFinding(jane, todayId, { tooth: '13', category: 'pathology', findingType: 'caries', surfaces: ['O', 'D'], certainty: 'probable' });
  await chart.addPlanned(amy, todayId, { tooth: '13', surfaces: ['O', 'D'], procedureConcept: 'direct_restoration_composite', status: 'PROPOSED', phase: 1, priority: 'routine', findingIds: [], diagnosisIds: [] });
  await chart.addFinding(amy, todayId, { tooth: '30', category: 'pathology', findingType: 'recurrent_caries', surfaces: ['M', 'O', 'D'], certainty: 'confirmed', note: 'Recurrent decay under distal margin of the 2019 amalgam.' });
  const p30 = await chart.addProcedure(jane, todayId, {
    tooth: '30', surfaces: ['M', 'O', 'D'], procedureConcept: 'direct_restoration_composite', performedBy: [amy.staffId], assistedBy: [jane.staffId],
    details: { materials_removed: 'amalgam', shade: 'A2', isolation: 'rubber dam', matrix_system: 'sectional', contact_verified: true, occlusion_verified: true },
    anesthetics: [{ drug: 'Lidocaine', concentration: '2%', vasoconstrictor: '1:100,000 epinephrine', amountMl: 1.7, route: 'Inferior alveolar nerve block', site: 'Right IANB', administeredAt: new Date().toISOString(), administeredBy: amy.staffId }],
    note: 'Replaced MOD amalgam. Post-op instructions delivered.',
  });
  await chart.procedureStatus(jane, p30!.id, 'PERFORMED');
  await signing.transition(jane, todayId, 'READY_FOR_REVIEW');
  await scheduling.addRecall(frank, { patientId: jordan.id, recallType: 'hygiene', intervalMonths: 6, lastVisitDate: '2023-08-22' });

  // ---------------------------------------------------------------- patient portal
  // Jordan uses the portal for themself; Lena (12) is reached through her parent's account.
  const jordanInvite = await portalStaff.invite(frank, jordan.id, { email: 'jordan.rivera@patients.example.test', inviteeName: 'Jordan Rivera', relationship: 'self', scopes: [...PORTAL_SCOPES] });
  await portalAuth.acceptInvitation({ code: jordanInvite.code, email: 'jordan.rivera@patients.example.test', displayName: 'Jordan Rivera', password: SYNTHETIC_PASSWORD });
  const lena = others[2]!;
  const kasiaInvite = await portalStaff.invite(frank, lena.id, {
    email: 'kasia.kowalski@patients.example.test', inviteeName: 'Kasia Kowalski', relationship: 'parent_guardian', scopes: [...DEFAULT_SCOPES.parent_guardian],
    verificationNote: 'Mother; photo ID checked at front desk, listed as responsible party at intake',
  });
  await portalAuth.acceptInvitation({ code: kasiaInvite.code, email: 'kasia.kowalski@patients.example.test', displayName: 'Kasia Kowalski', password: SYNTHETIC_PASSWORD });
  const restorativeConsent = await portalStaff.saveTemplate(amy, {
    templateKey: 'restorative_treatment',
    title: 'Consent for restorative treatment',
    language: 'en',
    body: [
      'I, {{patient_name}}, agree to the following treatment by {{provider_name}}:',
      '{{procedure_list}}',
      'The dentist has explained what the treatment involves, the expected benefits, other options (including no treatment), and the risks, which can include tooth sensitivity, the need for further treatment such as a root canal, and numbness from anesthetic.',
      'I have had the chance to ask questions and they were answered. I understand I can withdraw this consent at any time before treatment begins.',
    ].join('\n\n'),
  });
  const openPlan = (await chart.getEncounter(amy, todayId)).entries.plan as { id: string; status: string }[];
  await portalStaff.sendConsent(frank, jordan.id, { templateId: restorativeConsent.id, plannedProcedureIds: openPlan.filter((p) => p.status === 'PATIENT_ACCEPTED').map((p) => p.id), providerId: amy.staffId });
  await portalStaff.startThread(frank, jordan.id, { subject: 'Before your next visit', body: 'Hi Jordan, Dr. Jones asked us to send over the consent form for the filling on your front tooth. You can sign it in the Forms section before your visit. Reply here with any questions.' });
  await portalStaff.invite(frank, others[1]!.id, {
    email: 'grace.okafor@patients.example.test', inviteeName: 'Grace Okafor', relationship: 'caregiver', scopes: [...DEFAULT_SCOPES.caregiver],
    verificationNote: 'Daughter; patient signed the caregiver authorization form in the office',
  });

  // Riverbend gets one patient so tenant isolation is visible in the demo.
  const omar = await scriptedActor(owner, river, 'omar');
  await patients.create(omar, { legalGivenName: 'Ada', legalFamilyName: 'Brennan', dateOfBirth: '1970-02-14', sexAtBirth: 'unknown', preferredLanguage: 'en', homeLocationId: river.locationId });

  await app.close();
  await owner.end();
  console.log('\nSynthetic data loaded. Sign in at the web app with any of these (password: ' + SYNTHETIC_PASSWORD + '):');
  for (const t of [maple, river]) for (const s of Object.values(t.staff)) console.log(`  ${s.email.padEnd(40)} ${s.role}`);
  console.log('Authenticator codes: the login screen shows the current code for synthetic users when DEV_TOOLS=1.');
  console.log('\nBilling: bea.carter@maple.example.test posts charges, claims and payments; codes and fees are the invented SYNTHETIC set.');
  console.log('Practice setup: pat.morgan@maple.example.test manages staff, privileges, licenses and working hours (Staff tab).');
  console.log('Patient portal (/#/portal, same password): jordan.rivera@patients.example.test (self), kasia.kowalski@patients.example.test (parent of Lena Kowalski, 12).');
  console.log('Emailed sign-in codes: the portal sign-in screen shows them for synthetic accounts when DEV_TOOLS=1.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
