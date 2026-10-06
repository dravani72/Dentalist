/**
 * Synthetic tenant bootstrap shared by the seed script and the test suite. Creates an
 * organization, location, operatories, appointment types, staff with explicit privileges and
 * credentials. Everything here is fictional; never load real people or patients this way.
 */
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { Privilege, ROLE_TEMPLATES, RoleTemplate } from '@teeth/shared';
import { LocalFieldCipher } from '../crypto/keys';
import { hashPassword } from '../crypto/password';
import { generateTotpSecret } from '../crypto/totp';
import type { Actor } from '../auth/actor';
import { seedDemoBilling } from '../billing/code-loader';

export const SYNTHETIC_PASSWORD = 'synthetic-dev-only';

export interface StaffSpec {
  key: string;
  name: string;
  email: string;
  role: RoleTemplate;
  title?: string;
  license?: { state: string; expiresOn?: string; status?: string };
  npi?: string;
  /** Verified licenses in the synthetic test jurisdictions (ZZ, ZY) for telehealth development. */
  telehealthLicenses?: string[];
  extraPrivileges?: Privilege[];
  withoutPrivileges?: Privilege[];
}

export interface TenantSpec {
  orgName: string;
  location: { name: string; address: string; city: string; state: string; zip: string; tz: string };
  operatories: string[];
  staff: StaffSpec[];
}

export interface Tenant {
  orgId: string;
  locationId: string;
  operatoryIds: string[];
  appointmentTypes: Record<string, string>;
  virtualRoomIds: string[];
  billing: Awaited<ReturnType<typeof seedDemoBilling>>;
  staff: Record<string, { staffId: string; userId: string; totpSecret: string; email: string; privileges: Privilege[]; name: string; role: string }>;
}

/** key, name, chair minutes, provider minutes, provider kind, bookable online by patients */
export const APPOINTMENT_TYPES: [string, string, number, number, string, boolean][] = [
  ['exam', 'Comprehensive exam', 60, 20, 'dentist', true],
  ['hygiene', 'Hygiene visit', 60, 10, 'hygienist', true],
  ['restorative', 'Restorative', 90, 75, 'dentist', false],
  ['crown', 'Crown preparation', 120, 90, 'dentist', false],
  ['emergency', 'Emergency', 30, 20, 'dentist', false],
];

export async function createTenant(owner: Client, cipher: LocalFieldCipher, spec: TenantSpec): Promise<Tenant> {
  const org = await owner.query<{ id: string }>('INSERT INTO organization (name) VALUES ($1) RETURNING id', [spec.orgName]);
  const orgId = org.rows[0]!.id;
  const loc = await owner.query<{ id: string }>(
    'INSERT INTO location (org_id, name, address_line, city, state, zip, time_zone, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [orgId, spec.location.name, spec.location.address, spec.location.city, spec.location.state, spec.location.zip, spec.location.tz, '555-0100'],
  );
  const locationId = loc.rows[0]!.id;
  const operatoryIds: string[] = [];
  for (const name of spec.operatories) {
    const r = await owner.query<{ id: string }>('INSERT INTO operatory (org_id, location_id, name) VALUES ($1,$2,$3) RETURNING id', [orgId, locationId, name]);
    operatoryIds.push(r.rows[0]!.id);
  }
  const appointmentTypes: Record<string, string> = {};
  for (const [key, name, chair, provider, kind, online] of APPOINTMENT_TYPES) {
    const r = await owner.query<{ id: string }>(
      'INSERT INTO appointment_type (org_id, name, chair_minutes, provider_minutes, provider_kind, online_bookable) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [orgId, name, chair, provider, kind, online],
    );
    appointmentTypes[key] = r.rows[0]!.id;
  }
  const staff: Tenant['staff'] = {};
  const passwordHash = await hashPassword(SYNTHETIC_PASSWORD);
  for (const s of spec.staff) {
    const totpSecret = generateTotpSecret();
    const existing = await owner.query<{ id: string }>('SELECT id FROM user_account WHERE lower(email) = lower($1)', [s.email]);
    let userId = existing.rows[0]?.id;
    if (!userId) {
      userId = randomUUID();
      await owner.query(
        'INSERT INTO user_account (id, email, display_name, password_hash, totp_secret_enc) VALUES ($1,$2,$3,$4,$5)',
        [userId, s.email, s.name, passwordHash, cipher.encrypt(totpSecret, `totp:${userId}`)],
      );
    }
    const privileges = [...new Set([...ROLE_TEMPLATES[s.role], ...(s.extraPrivileges ?? [])])].filter((p) => !(s.withoutPrivileges ?? []).includes(p));
    // Who can be booked is an explicit setting; the fixtures simply make dentists and hygienists bookable.
    const providerKind = s.role === 'dentist' || s.role === 'hygienist' ? s.role : null;
    const sm = await owner.query<{ id: string }>(
      'INSERT INTO staff_member (org_id, user_id, display_name, role_template, privileges, location_ids, provider_kind) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [orgId, userId, s.name, s.role, privileges, [locationId], providerKind],
    );
    const staffId = sm.rows[0]!.id;
    if (providerKind) {
      // Monday to Friday, 08:00 to 17:00, from well in the past so fixed-date tests fall inside.
      await owner.query(
        `INSERT INTO provider_hours (org_id, staff_member_id, location_id, weekday, start_minute, end_minute, effective_from, created_by)
         SELECT $1, $2, $3, d, 480, 1020, '2020-01-01', $2 FROM generate_series(1, 5) AS d`,
        [orgId, staffId, locationId],
      );
    }
    if (s.license) {
      await owner.query(
        "INSERT INTO credential (org_id, staff_member_id, kind, title, identifier, state, status, expires_on, verified_at) VALUES ($1,$2,'dental_license',$3,$4,$5,$6,$7, now())",
        [orgId, staffId, s.title ?? null, `SYN-${Math.floor(Math.random() * 1e6)}`, s.license.state, s.license.status ?? 'active', s.license.expiresOn ?? '2030-12-31'],
      );
    }
    for (const state of s.telehealthLicenses ?? []) {
      await owner.query(
        `INSERT INTO credential (org_id, staff_member_id, kind, title, identifier, state, status, expires_on, verified_at, verification_source, verification_expires_on, authority_type)
         VALUES ($1,$2,'dental_license',$3,$4,$5,'active','2030-12-31', now(), 'Synthetic fixture (not a real board lookup)', '2099-12-31', 'full_license')`,
        [orgId, staffId, s.title ?? null, `SYN-${state}-${Math.floor(Math.random() * 1e6)}`, state],
      );
    }
    if (s.npi) {
      await owner.query("INSERT INTO credential (org_id, staff_member_id, kind, identifier, status) VALUES ($1,$2,'npi',$3,'active')", [orgId, staffId, s.npi]);
    }
    staff[s.key] = { staffId, userId, totpSecret, email: s.email, privileges, name: s.name, role: s.role };
  }
  const billing = await seedDemoBilling(owner, orgId, Object.values(staff)[0]!.staffId);
  const virtualRoomIds = await seedTelehealth(owner, orgId, locationId, Object.values(staff)[0]!.staffId, appointmentTypes);
  return { orgId, locationId, operatoryIds, appointmentTypes, virtualRoomIds, billing, staff };
}

/**
 * Telehealth setup for a synthetic practice: a virtual appointment type, two virtual rooms and the
 * telehealth and recording consent forms. The consent wording is placeholder text written for
 * development; a practice must replace it with wording its counsel approved.
 */
async function seedTelehealth(owner: Client, orgId: string, locationId: string, createdBy: string, appointmentTypes: Record<string, string>) {
  const t = await owner.query<{ id: string }>(
    "INSERT INTO appointment_type (org_id, name, chair_minutes, provider_minutes, provider_kind, online_bookable, is_virtual) VALUES ($1,'Telehealth triage (video)',20,20,'dentist',false,true) RETURNING id",
    [orgId],
  );
  appointmentTypes.virtual = t.rows[0]!.id;
  const rooms: string[] = [];
  for (const name of ['Virtual room 1', 'Virtual room 2']) {
    const r = await owner.query<{ id: string }>("INSERT INTO resource (org_id, location_id, kind, name) VALUES ($1,$2,'virtual_room',$3) RETURNING id", [orgId, locationId, name]);
    rooms.push(r.rows[0]!.id);
  }
  for (const [key, title, body] of TELEHEALTH_CONSENTS) {
    await owner.query('INSERT INTO consent_template (org_id, template_key, version, title, body, created_by) VALUES ($1,$2,1,$3,$4,$5)', [orgId, key, title, body, createdBy]);
  }
  return rooms;
}

const TELEHEALTH_CONSENTS: [string, string, string][] = [
  [
    'telehealth_care',
    'Consent to a dental video visit (SYNTHETIC PLACEHOLDER: needs legal review)',
    [
      'I, {{patient_name}}, agree to a dental visit by secure video with {{provider_name}} or another dentist of this practice.',
      'I understand a video visit cannot replace an in-person exam or X-rays. The dentist may not be able to find every problem and may ask me to come in.',
      'I will say where I am at the start of the visit, and again if I move. If the video drops, the practice will call me back at the number I give.',
      'In an emergency I will call 911 or go to the nearest emergency room. I can stop the visit at any time.',
    ].join('\n\n'),
  ],
  [
    'telehealth_recording',
    'Consent to record the audio of video visits (SYNTHETIC PLACEHOLDER: needs legal review)',
    [
      'I, {{patient_name}}, agree that the practice may record the audio of my video visits to help write my dental record.',
      'Video is never recorded. Everyone in the visit will be told before recording starts, and recording stops if anyone present does not agree.',
      'Saying no does not change my care. I can withdraw this consent at any time in the patient portal.',
    ].join('\n\n'),
  ],
];


/**
 * An Actor for scripted work (seed data, tests) backed by a real session row with a fresh
 * step-up, so attestations reference a genuine session.
 */
export async function scriptedActor(owner: Client, tenant: Tenant, key: string): Promise<Actor> {
  const s = tenant.staff[key]!;
  const session = await owner.query<{ id: string }>(
    `INSERT INTO user_session (token_hash, user_id, org_id, staff_member_id, auth_methods, expires_at, step_up_at, step_up_method)
     VALUES ($1,$2,$3,$4,'{pwd,otp}', now() + interval '1 hour', now(), 'otp') RETURNING id`,
    [randomUUID(), s.userId, tenant.orgId, s.staffId],
  );
  return {
    userId: s.userId,
    sessionId: session.rows[0]!.id,
    orgId: tenant.orgId,
    staffId: s.staffId,
    displayName: s.name,
    roleTemplate: s.role,
    privileges: new Set(s.privileges),
    locationIds: [tenant.locationId],
    authMethods: ['pwd', 'otp'],
    stepUpAt: new Date(),
    stepUpMethod: 'otp',
    correlationId: randomUUID(),
  };
}

export const MAPLE: TenantSpec = {
  orgName: 'Maple Street Dental (synthetic)',
  location: { name: 'Main Street office', address: '100 Main St', city: 'Springfield', state: 'IL', zip: '62701', tz: 'America/Chicago' },
  operatories: ['Op 1', 'Op 2', 'Op 3 (hygiene)'],
  staff: [
    { key: 'amy', name: 'Amy Jones, DDS', email: 'amy.jones@maple.example.test', role: 'dentist', title: 'DDS', license: { state: 'IL' }, npi: '0000000001', telehealthLicenses: ['ZZ'] },
    { key: 'lee', name: 'Marcus Lee, DDS', email: 'marcus.lee@maple.example.test', role: 'dentist', title: 'DDS', license: { state: 'IL' }, npi: '0000000002', telehealthLicenses: ['ZZ'] },
    { key: 'jane', name: 'Jane Smith, CDA', email: 'jane.smith@maple.example.test', role: 'dental_assistant', title: 'CDA' },
    { key: 'rosa', name: 'Rosa Diaz, RDH', email: 'rosa.diaz@maple.example.test', role: 'hygienist', title: 'RDH' },
    { key: 'frank', name: 'Frank Ito', email: 'frank.ito@maple.example.test', role: 'front_desk' },
    { key: 'bea', name: 'Bea Carter', email: 'bea.carter@maple.example.test', role: 'billing', extraPrivileges: ['fee_schedule.manage'] },
    { key: 'cora', name: 'Cora Webb', email: 'cora.webb@maple.example.test', role: 'compliance_officer', extraPrivileges: ['patient.read'] },
    { key: 'pat', name: 'Pat Morgan', email: 'pat.morgan@maple.example.test', role: 'practice_manager' },
  ],
};

export const RIVERBEND: TenantSpec = {
  orgName: 'Riverbend Family Dentistry (synthetic)',
  location: { name: 'Riverbend', address: '5 River Rd', city: 'Columbus', state: 'OH', zip: '43004', tz: 'America/New_York' },
  operatories: ['Chair A', 'Chair B'],
  staff: [{ key: 'omar', name: 'Omar Khan, DMD', email: 'omar.khan@riverbend.example.test', role: 'dentist', title: 'DMD', license: { state: 'OH' }, npi: '0000000003', telehealthLicenses: ['ZZ'] }],
};
