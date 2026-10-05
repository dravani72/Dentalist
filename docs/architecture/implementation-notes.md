# Implementation notes

How the Architecture Plan maps onto this code, where the build deliberately differs, and what is not built yet.

## Plan → code

| Plan area | Where it lives |
| --- | --- |
| Modular monolith, TypeScript end to end | `apps/api` (NestJS 11), `apps/web` (React), `packages/shared` |
| One validation definition for client and server | `packages/shared/src/schemas.ts` (Zod) |
| Tenancy | `db/migrations/0001_foundation.sql` `enable_tenant_rls()`; `apps/api/src/db/db.service.ts` sets `app.org_id` per transaction |
| Identity, MFA, sessions, step-up | `apps/api/src/auth/*`, `src/crypto/totp.ts`, `src/crypto/password.ts` |
| Privileges, credentials, location scope, break-glass | `packages/shared/src/privileges.ts`, `apps/api/src/auth/access.service.ts` |
| Audit | `audit_event` + `audit_append`/`audit_verify_chain` in 0001; `apps/api/src/audit/*` |
| Patient record and versioned medical history | 0001 tables; `apps/api/src/patients/*` |
| Resource-aware scheduling | 0002 (`no_double_booking` exclusion constraint); `apps/api/src/scheduling/*` |
| Encounter, chart entries, plan vs performed | 0003; `apps/api/src/charting/chart.service.ts`, `entry-kinds.ts` |
| Verify, sign, lock, amend, integrity | 0003 triggers; `apps/api/src/charting/signing.service.ts`; `npm run verify:integrity` |
| Media | `apps/api/src/media/*` (encrypted at rest, checksummed, 60 s signed URLs) |
| eRx | 0004; `apps/api/src/prescribing/*` (`ErxPartner` interface, `FakeErxPartner` sandbox) |
| Async work | `outbox` table; `apps/api/src/outbox/outbox.worker.ts` |
| PHI-safe logging | `apps/api/src/common/phi-scrub.ts`, `logger.ts` |
| Patient portal, delegated access, secure messaging, consents | 0006; `apps/api/src/portal/*`; `apps/web/src/pages/portal/*`, `PortalAccessTab.tsx`, `PortalInbox.tsx`; details in `patient-portal.md` |
| Revenue cycle: fees, ledger, insurance, estimates, claims, remittance | 0007; `apps/api/src/billing/*` (`ClearinghousePartner`, `FakeClearinghouse`); `packages/shared/src/billing.ts`; `apps/web/src/pages/billing/*`, portal `billing.tsx`; details in `revenue-cycle.md` |
| Odontogram and visit layers | `apps/web/src/components/Odontogram.tsx`, `lib/chart-model.ts`, `pages/ChartTab.tsx` |

## Deliberate deviations

- **Plain SQL migrations and `pg` instead of Drizzle.** Row-level security, exclusion constraints, immutability
  triggers and SECURITY DEFINER functions are the core of the design, and they read more clearly as SQL than as ORM
  escape hatches. Swapping in Drizzle later only touches the data-access layer.
- **Custom schedule grid instead of FullCalendar Premium.** Avoids a commercial license for the prototype. The grid
  is operatory-column based; drag-to-reschedule is not built (the API supports reschedule).
- **Local adapters stand in for AWS.** `LocalRecordSigner` (Ed25519 keys on disk) for KMS signing,
  `LocalFieldCipher` (AES-256-GCM) for KMS envelope encryption, encrypted local files for S3, the in-process outbox
  worker for SQS, password + TOTP for Cognito. Each sits behind an interface so the production adapter is a drop-in.
- **`FakeErxPartner` instead of DoseSpot.** Implements search, screening (allergy cross-reactivity, interactions),
  idempotent transmit and an asynchronous status callback over the real signed webhook path. Controlled substances
  are refused until the certified EPCS phase.
- **Token in sessionStorage.** The web client keeps the opaque session token in memory/sessionStorage. Production
  should move it to an httpOnly, SameSite=strict cookie at the gateway.

## Fixed while building

- The signed-row guard trigger let any column change on tables with no post-signing mutable columns (PL/pgSQL
  `TG_ARGV` is NULL when no arguments are passed). The guard now defaults to "everything frozen"; a test proves a
  direct UPDATE on a signed finding fails.
- A plan item fulfilled by a procedure now records which procedure fulfilled it.
- DATE columns are returned as `YYYY-MM-DD` strings, so a date of birth can never shift by a day across time zones.

## Not built yet

- Portal pieces still missing: online payment (needs a payment processor choice), referral and document downloads,
  SMS sign-in codes. Provider schedule templates (online booking uses fixed weekday hours for now).
  Intake questionnaires beyond the health-history update request. Spanish translations of portal text.
- Revenue cycle gaps: a real clearinghouse adapter (needs a contract and BAA), claim attachments (x-rays,
  narratives), predeterminations, coordination of benefits on secondary claims (secondary estimates ignore the
  primary payment), claim status inquiry (276/277), statements by mail, payment plans, collections.
- Perio charting, endo detail, oral surgery, lab cases, DICOM/CBCT viewing (Phase 6).
- EPCS (Phase 7) and AI assistance (Phase 8).
- Production adapters: Cognito, KMS, S3, SQS, DoseSpot. Terraform is a skeleton and has never been applied.
- Backup/restore drills and monitoring (MVP item 12 covers tenant isolation, access control and PHI-safe logging
  in tests; backup/restore needs the AWS environment).
- Staff and user administration screens (accounts are created by the seed script).
- TOTP replay prevention (Cognito covers it in production).
- Primary teeth on the odontogram (the anatomy model and API support them; the drawing shows permanent teeth).

## Known quirks of the seed

- Seeded historical visits show today's date as their signing time, because signing always stamps the real clock.
  Their visit dates (2019, 2021, 2023) are correct.
- X-rays are generated SVGs labelled SIMULATED · NOT DIAGNOSTIC.
