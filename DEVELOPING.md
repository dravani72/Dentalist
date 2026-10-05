# Developing Teeth

Synthetic data only. Never load real patient information into any environment built from this repository.

## Prerequisites

- Node 22.9+
- PostgreSQL 16 with the `pgcrypto` and `btree_gist` extensions (both ship with standard Postgres)

## First-time setup

```sh
npm install
cp .env.example .env                      # local-only values (DEV_TOOLS=1 shows sign-in codes for demo accounts)
psql -U postgres -f db/bootstrap.sql      # creates roles teeth_owner / teeth_app and databases teeth / teeth_test
npm run build -w @teeth/shared
npm run db:migrate                        # applies db/migrations as teeth_owner
npm run db:seed                           # two synthetic practices, one patient with four signed visits
```

`npm run db:reset` drops everything owned by `teeth_owner` and reseeds.

The API and the `db:*`, `worker`, `verify:integrity` and `codes:load` scripts read `.env` from the repository root
when it exists. Variables already set in your shell win over the file. Tests and `npm start` never read it.

## Running

```sh
npm run dev:api     # http://localhost:3000/api   (also runs the outbox worker; RUN_WORKER=0 to disable)
npm run dev:web     # http://localhost:5173       (proxies /api to :3000)
```

### Synthetic logins

Password for every account: `synthetic-dev-only`. With `DEV_TOOLS=1` the login screen shows the current authenticator
code for `.test` accounts (the dev endpoint refuses anything else and is off in production).

| Account | Role | Notes |
| --- | --- | --- |
| amy.jones@maple.example.test | Dentist | IL license, can verify, sign, prescribe |
| marcus.lee@maple.example.test | Dentist | IL license |
| jane.smith@maple.example.test | Dental assistant | charts, cannot verify or sign |
| rosa.diaz@maple.example.test | Hygienist | |
| frank.ito@maple.example.test | Front desk | schedule, demographics, insurance, takes payments; no clinical actions |
| bea.carter@maple.example.test | Billing | charges, adjustments, claims, fee schedules (fee_schedule.manage granted in the fixture) |
| cora.webb@maple.example.test | Compliance officer | audit log, access reports, break-glass |
| pat.morgan@maple.example.test | Practice manager | Staff tab: add staff, privileges, licenses, working hours, time off, sign-in resets |
| omar.khan@riverbend.example.test | Dentist, second practice | used to prove tenant isolation |

### Patient portal

Open `http://localhost:5173/#/portal`. Same password; the sign-in code is "emailed", and with `DEV_TOOLS=1` the code
screen shows it for `.test` addresses.

| Account | Access |
| --- | --- |
| jordan.rivera@patients.example.test | Jordan's own record (all areas) |
| kasia.kowalski@patients.example.test | Parent of Lena Kowalski (12); access ends on Lena's 18th birthday |

Grace Okafor has an unused caregiver invitation for Samuel Okafor. Staff manage access on the patient's
**Portal & forms** tab and work patient messages and requests in **Portal inbox**. See
`docs/architecture/patient-portal.md`.

### Billing

Codes and fees are an invented **SYNTHETIC** set (`SYN-…`, `apps/api/src/billing/synthetic-codes.ts`); the seed loads
it with demo fee schedules and two payers. A licensed deployment loads CDT from the practice's ADA files, which are
never committed:

```sh
npm run codes:load -w @teeth/api -- --cdt "CDT 2027" --codes cdt-2027.csv --rules cdt-2027-rules.csv
```

Claims go to a synthetic clearinghouse (member ids starting `SYN` are covered, `SYNX` inactive, anything else
rejected). Remittances are looked for `CLAIM_POLL_SECONDS` after a claim is accepted (default 1800) or at once with
**Billing → Check for insurance payments**. See `docs/architecture/revenue-cycle.md`.

The seeded patient is **Jordan Rivera** (penicillin allergy): visits in 2019, 2021 (x2), 2023 signed, and today's
restorative visit waiting for the dentist's review.

## Tests

```sh
npm test                          # shared + API (API tests need Postgres; they reset the teeth_test database)
npm run verify:integrity          # re-hashes and re-verifies every signed visit and the audit chain
npm run typecheck
```

The API suites (73 tests) cover tenant isolation through row-level security, privilege and license checks,
double-booking, sign/lock/amend, database-level immutability, integrity verification, eRx screening and idempotent
transmission, webhook signature/replay checks, break-glass, the audit hash chain, and the patient portal
(`test/portal.test.ts`: per-patient database wall, scopes, age rules, revocation, sign-in codes and lockout,
consent hashing and immutability, PHI-free notifications, online booking) and the revenue cycle
(`test/billing.test.ts`: charges from signed work only, append-only ledger, estimates, claims, remittance posted once).

## Layout

```
packages/shared   Zod schemas, privileges, anatomy, surfaces, state machines, clinical catalog (no licensed codes)
apps/api          NestJS modular monolith: auth, audit, patients, scheduling, charting, signing, media, prescribing, outbox, portal
apps/web          React + Vite + TanStack Query client
db/               bootstrap.sql and ordered SQL migrations (RLS, triggers, grants)
docs/architecture implementation notes (how the plan maps to the code, and what is not built)
infra/terraform   skeleton only; nothing has been applied
```

## Rules that the code enforces (see AGENTS.md)

- Signed rows are frozen by Postgres triggers; corrections are amendments that supersede, never edits in place.
- Tenant isolation is row-level security on every PHI table, using the request's transaction-local `app.org_id`.
- Portal requests also set `app.portal_patients`; a restrictive policy then hides every other patient's rows.
- The runtime role `teeth_app` has no DELETE and no BYPASSRLS; the audit table is append-only for everyone.
- Logs pass through a PHI scrubber; routes are logged by pattern, never with ids or bodies.
- Tooth numbers are display labels; tooth instances are keyed by UUID.
- Chart states never rely on color alone (pattern + E/F/P/C letter + text).
- CDT/SNODENT tables ship empty; licensed content is loaded per deployment, never committed.
