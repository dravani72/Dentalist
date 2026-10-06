# Telehealth triage

Synchronous dental triage by video (MASTER_SPEC §16a). The normative design is
[`telehealth/handoff-v1.1.0.md`](telehealth/handoff-v1.1.0.md) (requirements TH-001 to TH-016, licensing rules
LIC-*, acceptance tests AT01 to AT22). This page says where each part lives, where the build differs, and what is
not built.

Migration `0009_telehealth.sql`; pure policy in `packages/shared/src/telehealth.ts`; API in
`apps/api/src/telehealth/*`; provider workspace **Telehealth** (`#/telehealth`); patient portal section
**Video visit**.

## Safety and legal status

- **No real state is enabled.** `config/jurisdiction_registry.json` lists the 50 states and D.C., all disabled and
  unreviewed. Only two synthetic jurisdictions are published by the seed: **ZZ** (consults and non-controlled
  prescribing) and **ZY** (consults only; no seeded dentist is licensed there). Synthetic rules are refused when
  `NODE_ENV=production`. Enabling a real state needs a reviewed rule, a second approver and a review expiry
  (`jurisdiction_rule` CHECKs).
- **No clinical thresholds or legal rules were invented.** The emergency screen asks four yes/no/unknown questions
  and escalates on any "yes"; "unknown" is never treated as "no". It is a placeholder for a protocol that licensed
  clinical leadership must approve (TH-006).
- **Consent wording is a placeholder.** The `telehealth_care` and `telehealth_recording` templates say
  "SYNTHETIC PLACEHOLDER: needs legal review".
- **Controlled prescribing by telehealth is always denied** (`controlled_telehealth_prescribing_disabled`).

## Design → code

| Design | Where it lives |
| --- | --- |
| Separate provider portal (TH-001) | `apps/web/src/pages/telehealth/*`: Today queue, Schedule, Follow-up, State eligibility, case workspace with live room |
| Reuse of platform objects (TH-002) | Cases point at the existing patient, appointment, encounter, chart entries, media, consent, prescription and audit tables; no parallel registry |
| Structured, versioned intake (TH-004) | `triage_intake` (append-only versions, source `patient_portal` or `staff`, patient-indicated tooth kept apart from any confirmed tooth) |
| Remote findings (TH-005) | `chart_entry` columns `assessment_modality`, `source_media_id`, `remote_exam_limitations`, `evidence_quality`; radiograph-only finding types need a cited radiograph |
| Three status axes (TH-007) | `telehealth_case.status`, `telehealth_session.status`, the existing encounter status; transitions in `caseTransitionAllowed` |
| Closure (TH-008) | Close needs a signed encounter and a disposition; cancel and no-show close without an encounter, procedure or claim |
| Timing and metering (TH-009) | `telehealth_session_event` (requested/joined/clinical start/end), `overlapSeconds`, one `telehealth_meter_event` per encounter and meter version |
| Rx after a documented assessment (TH-010) | `prescribing.service.ts`: telehealth encounters need a current `prescribe_noncontrolled` ALLOW, a documented assessment, no clinical hold and `pharmacyConfirmedWithPatient` |
| Server-side authorization (TH-011) | Privileges `telehealth.coordinate` and `telehealth.consult`; RLS on every table; portal scope `telehealth`; join tokens scoped to one room, identity and grant |
| Visible participants and consent (TH-012) | `telehealth_participant`; recording needs separate signed recording consent from every human participant |
| No permanent video (TH-014) | Recording egress is audio-only; snapshots are deliberate PNG frames stored as clinical media; `replay_buffer` is CHECK-constrained to `disabled` |
| 50 states + D.C. registry (TH-015) | `jurisdiction`, `jurisdiction_rule` (versioned, digest, two-person review); `apps/api/src/telehealth/registry.ts` |
| Eligibility (LIC-*) | `evaluateEligibility` is pure; `eligibility.service.ts` gathers facts, stores `eligibility_evaluation` with an input digest, and `assertCurrent` re-gathers and compares before every clinical action |
| Continuation | Changes to location, consent, credential or assignment set `clinical_hold` on the case; clinical actions refuse until a new evaluation passes |
| Signing | Telehealth signing authority is the start evaluation's credential (the patient's state). The signed payload gains a `telehealth` block (assessment, disposition, location, evaluation, consent, participant and snapshot ids); `verify:integrity` rebuilds it |
| Media server | `RtcAdapter` interface; `FakeRtcAdapter` sandbox; signed webhook `POST /api/webhooks/rtc` (timestamp + HMAC, duplicates and stale events ignored) |
| Async work | Outbox topics `telehealth.revoke_live_access` and `telehealth.stop_egress` (idempotency keys per staff/session) |
| In-person conversion (AT18) | Booking with `telehealthCaseId` stores the lineage on the appointment and completes the open `book_in_person` task |

## Who can do what

| Action | Requirement |
| --- | --- |
| See the queue, assign, schedule, manage tasks | `telehealth.coordinate` |
| Start a visit, document, sign, prescribe | `telehealth.consult` **and** a passing evaluation for that purpose, provider location confirmed within 15 minutes, patient location within 15 minutes, evaluation within 5 minutes |
| Request a visit, answer intake, give location, check in, upload photos, withdraw consent | Portal user with the `telehealth` scope on that patient's grant |

Audit actions start with `telehealth.` (staff) and `portal.telehealth.` (portal); denials are audited as `denied`.

## Deliberate deviations

- **Route.** The handoff names `/provider/telehealth`; the web app uses hash routes, so it is `#/telehealth`.
- **Evidence references live in the signed payload.** The handoff suggests reference columns on the assessment.
  Signed chart rows are frozen by `protect_chart_table` at verification, so the ids are written into the signed
  payload instead, where the signature covers them.
- **Sandbox media server.** No vendor is contracted, so no PHI leaves the system. `FakeRtcAdapter` issues tokens,
  admits from the lobby, records "audio" and sends signed webhooks; `/api/rtc-sim/*` lets the browser "join". It is
  registered only with the fake adapter outside production.

## Not built yet

- A real SFU adapter (LiveKit or similar; needs a vendor trust-boundary and BAA review), camera and microphone
  checks, real video.
- Speech-to-text transcription and the memory-only replay buffer.
- A structured referral record, FHIR exchange, cross-tenant DSO referrals.
- Telehealth billing codes (for example D9995/D9996) and patient cost display.
- Asynchronous clinical review and audio-only care (separately gated modalities in TH-003).
- Real state rules: every state needs legal review before it can be enabled.
- Interpreter scheduling (the intake records a language; the participant role exists).
- AT19 to AT22 (low-bandwidth paths, observability review, staging two-browser drill, vendor outage drill).

## Tests

`apps/api/test/telehealth.test.ts` (24, against Postgres) and `apps/api/test/telehealth-policy.test.ts` (13, pure)
cover AT01, AT03 to AT18 and TH-005/007/008/009/014. The policy tests are early evidence only, as the handoff says.
