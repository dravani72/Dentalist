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
| amy.jones@maple.example.test | Dentist | IL license, can verify, sign, prescribe; ZZ license for telehealth; DEA registrant with approved EPCS access (C-II to C-V) and an EPCS access manager |
| marcus.lee@maple.example.test | Dentist | IL license; ZZ license for telehealth; DEA registrant whose EPCS access waits for a second approver |
| jane.smith@maple.example.test | Dental assistant | charts, cannot verify or sign |
| rosa.diaz@maple.example.test | Hygienist | |
| frank.ito@maple.example.test | Front desk | schedule, demographics, insurance, takes payments; no clinical actions |
| bea.carter@maple.example.test | Billing | charges, adjustments, claims, fee schedules (fee_schedule.manage granted in the fixture) |
| cora.webb@maple.example.test | Compliance officer | audit log, access reports, break-glass |
| pat.morgan@maple.example.test | Practice manager | Staff tab: add staff, privileges, licenses, working hours, time off, sign-in resets; EPCS tab: DEA registrations and approving controlled-signing access |
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

### Controlled-substance prescribing (EPCS)

The e-prescribing partner is a sandbox inside the API (`FakeErxPartner`); it keeps enrollments and access in
`apps/api/var/erx-sandbox.json` so the seed and the dev server share them. Its certified signing window is shown as a
dialog marked SANDBOX: the partner PIN is **1311**, and the "show sandbox token" link reads the person's sandbox
token (separate from the authenticator used to sign in).

1. As pat.morgan: **EPCS** → Marcus Lee's access waits for a second approver. **Approve in partner window**, enter
   your authenticator code, then the PIN and your sandbox token code. His access turns Approved.
2. As amy.jones: open Priya Natarajan → **Prescriptions**. Her triazolam (C-IV) draft lists only pharmacies that
   accept electronic controlled prescriptions. Tick the PDMP check and the attestation, **Sign in EPCS window**, and
   finish with the PIN and Amy's sandbox token. It is sent and then accepted by the pharmacy.
3. Mei Tanaka already has a hydrocodone (C-II) prescription Amy signed this way.

### Telehealth

Only the synthetic jurisdictions **ZZ** (consults and non-controlled prescriptions) and **ZY** (consults only, and no
seeded dentist is licensed there) are enabled; the 50 states and D.C. are listed but disabled. Media runs through a
sandbox server in the API, so there is no real audio or video.

1. Portal as Jordan: **Video visit** → request a visit, answer the questions, sign the telehealth consent, give
   location **ZZ** and confirm you are not moving, then check in. Jordan waits in the lobby.
2. Staff as frank.ito: **Telehealth** → assign the case to Dr. Jones.
3. Staff as amy.jones: **Telehealth** → confirm your own location (ZZ), open the case and start. The patient is
   admitted, the visit opens, and you can take snapshots, document the assessment, sign, prescribe or book an
   in-person visit.

#### Real video with LiveKit

By default media runs through the sandbox. For real camera and microphone, use LiveKit, the same media server the
Telorovia application uses:

```sh
livekit-server --config config/livekit.dev.yaml     # install: https://docs.livekit.io/home/self-hosting/local/
RTC_PROVIDER=livekit npm run dev:api
```

Open the dentist and the patient in two browser windows (or two devices on the same machine) and allow camera and
microphone. The patient waits in the lobby with camera and microphone off until the dentist starts the visit.
Audio recording needs LiveKit's separate egress service and `LIVEKIT_EGRESS_FILEPATH`; without them the
**Start audio recording** button says recording is not set up, and the visit continues unrecorded.

Giving location **ZY** shows the "no licensed dentist" path. Recording is refused until everyone signs the separate
recording consent. See `docs/architecture/telehealth.md`.

### Perio charting

As rosa.diaz (hygienist), open **Jordan Rivera → Perio**. The signed 2023 comprehensive exam is shown. Today's visit is
open, so **Start perio exam**, click the first cell (tooth 2, distobuccal depth) and type depths: each digit enters and
moves to the next site. The 2023 exam is picked for comparison automatically. As amy.jones, the exam appears in
**Review and sign** with the rest of the visit.

### Endo charting

As amy.jones, open **Jordan Rivera → Endo**. Tooth #19 shows the signed 2021 workup: tests with #20 as the control
(abnormal results marked ⚠), the diagnosis, and three obturated canals with a working-length diagram. Choose another
tooth (say #3), add tests and a diagnosis, **Start root canal**, then add canals. **Mark root canal performed** is refused
until every canal is obturated, calcified or not located.

### Implant records

As amy.jones, open **Hector Alvarez → Implants**. The #30 implant from 2024 shows its device details (catalog, lot,
graft and membrane lots), its stability readings and its history through to a screw-retained crown and a 2025
follow-up. Start today's visit to record a step on it, or start an implant placement at another site and record the
device; a lot or serial number is required.

### Oral surgery

As amy.jones, the **Patients** page lists biopsies whose results are not back (Mei Tanaka's is overdue, Priya
Natarajan's is recent). Open **Mei Tanaka → Surgery** for the 2025 removal of an impacted #1 (flap, bone removal,
sectioning, a suspected sinus opening closed with a collagen plug) and **Samuel Okafor → Surgery** for a leukoplakia
biopsy that came back as mild dysplasia, with its follow-up plan. Start today's visit to start an extraction or a
soft-tissue biopsy and record its surgical detail or specimen; a dentist records pathology results.

### Lab cases

As frank.ito or amy.jones, the **Lab cases** page lists open cases: Samuel Okafor's bridge is overdue from the lab,
Hector Alvarez's crown #14 is back for today's crown appointment, and Priya Natarajan's night guard is a draft. Open
**Priya Natarajan → Lab cases** as amy.jones to authorize and send it (asks for an authenticator code); as frank.ito
the same case shows it waiting for Dr. Jones. **Jordan Rivera → Lab cases** has the 2021 crown #19 from prescription
to seat, with the #19 x-ray that went with it; a new case lets you pick x-rays and photos from the chart to attach. The labs themselves are kept at the bottom of the Lab cases page.

### Imaging

As amy.jones, the **Patients** page lists scans not read yet: Samuel Okafor's CBCT is overdue. **Hector Alvarez →
Imaging** has a read CBCT of his #30 implant: open it for the axial, coronal and sagittal views, window presets and
the two measurements in the read. Open **Samuel Okafor → Imaging**, start today's visit, open the scan, use Measure
and record a read (a CBCT read asks you to confirm you reviewed the whole volume). Assistants can upload a DICOM
series; a series whose patient doesn't match the chart asks the uploader why it is still this patient. The demo
CBCTs are synthetic drawings (`apps/api/src/imaging/phantom.ts`), not scans.

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

The API suites cover tenant isolation through row-level security, privilege and license checks,
double-booking, sign/lock/amend, database-level immutability, integrity verification, eRx screening and idempotent
transmission, webhook signature/replay checks, break-glass, the audit hash chain, and the patient portal
(`test/portal.test.ts`: per-patient database wall, scopes, age rules, revocation, sign-in codes and lockout,
consent hashing and immutability, PHI-free notifications, online booking) and the revenue cycle
(`test/billing.test.ts`: charges from signed work only, append-only ledger, estimates, claims, remittance posted once)
and telehealth (`test/telehealth.test.ts` and `test/telehealth-policy.test.ts`: jurisdiction eligibility, lobby and
room-scoped tokens, consent-gated audio-only recording, holds on location, consent or license change, signed evidence,
no-show closure, webhook replay, telehealth prescribing) and perio charting (`test/perio.test.ts`: per-tooth saves
and version locks, furcation and range checks, front desk and other-practice refusals, database guards, signing,
amendment by superseding the exam, integrity) and endo charting (`test/endo.test.ts`: test and result rules,
dentist-only diagnosis, canals tied to a root canal in the same visit, the completion rule, front desk and
other-practice refusals, database guards, signing, amendment, integrity) and implant records
(`test/implant.test.ts`: device tied to a placement procedure, implant sites, one device per site until removal,
step rules, front desk and other-practice refusals, database guards, signing, amendment keeping the device identity)
and oral surgery (`test/surgery.test.ts`: surgical record tied to an extraction, approach and sinus rules, the
completion rules, biopsy specimens and the waiting list, dentist-only results, front desk and other-practice refusals,
telehealth refusal, database guards, signing, amendment keeping the specimen identity) and lab cases
(`test/lab.test.ts`: the lab list, Rx rules, prescriber by privilege, the version check, sending by the prescribing
dentist only with step-up and a license, the frozen Rx and its digest, attached chart images, the round trip, flags and the overdue list,
appointment linking, other-practice refusals and row-level security) and imaging (`test/imaging.test.ts`: originals
kept with digests, refusing non-DICOM, compressed and wrong-kind files, the identity check, 2D studies, front desk,
assistant and other-practice refusals, the signed volume link, the whole-volume rule, server-side measurements,
signing, amendment keeping the study's files, row-level security).

## Layout

```
packages/shared   Zod schemas, privileges, anatomy, surfaces, state machines, clinical catalog (no licensed codes)
apps/api          NestJS modular monolith: auth, audit, patients, scheduling, charting, signing, media, prescribing, outbox, portal, billing, admin, telehealth
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
