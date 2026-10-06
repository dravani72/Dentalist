# Telehealth Development Handoff — Version 1.1.0

Integrated extension to the dental practice platform. The complete ZIP also contains revised baseline documents, schema/API contracts, state registry, backlog, diagrams and executable policy tests.


---

# Integrated dental telehealth triage — normative module specification

Version 1.1.0 • Added 2026-10-06 • Requirement IDs TH-001–TH-016.

## Product boundary and required outcome

TH-001: Deliver a separate **Telehealth** portal feature for the provider at `/provider/telehealth`, inside the existing platform and identity boundary. A dedicated queue, schedule, consultation workspace and follow-up worklist make this operationally usable. A video widget embedded in an ordinary chart does not satisfy this requirement.

TH-002: Telehealth reuses the platform's organization, patient UUID, provider credentials, allergy/medication list, appointment service, anatomical targets, encounter, consent, media, prescription adapters, signature, audit and revenue-cycle objects. No parallel patient registry, shadow prescription database or second clinical source of truth. Cross-tenant DSO referrals require explicit authorized sharing; a shared group ID alone grants no access.

TH-003: Scope includes scheduled and on-demand synchronous audiovisual dental triage, patient pre-screen and photo/document uploads, post-operative checks, referral coordination, non-controlled prescribing where permitted, and conversion into in-person treatment. Async intake is supported; independent asynchronous clinical review and audio-only clinical care are separately gated modalities. No automatic full dental examination or definitive diagnosis from insufficient remote evidence.

Telorovia continuity: LiveKit-compatible room-scoped backend tokens; confirmed patient location and state licensing; pre-screen before call; patient/provider/coordinator roles; selected PNG snapshots; consented retained session audio and live transcript; no permanent video. The earlier Telorovia $10/encounter rate is historical, not a required price for this integrated platform. Define optional per-completed-encounter metering without hard-coding commercial terms.

## End-to-end functional vertical slice

1. Existing or new patient requests a virtual visit from the patient portal or receives a practice invitation. Resolve duplicate identity before attaching sensitive records. New intake may be registered before provider eligibility; individual clinical advice may not.
2. Collect current physical location/address/state, callback number, guardian/representative identity, symptom intake and pharmacy preference. Confirm whether the patient is stationary; do not deliver clinical care while jurisdiction is changing.
3. Screen for emergency symptoms immediately, before queue, payment or sign-in delays. Present approved local emergency instructions and route to staff/provider escalation. This is a deterministic safety prompt, not automated diagnosis.
4. Evaluate eligible providers using current jurisdiction-specific authority and modality. Show factual credential disclosures; preserve evaluation evidence. No eligible provider means offer permitted in-person/referral options, not a bypass button.
5. Obtain versioned telehealth consent; obtain separate recording/transcription consent as applicable to participant jurisdictions. Recording refusal must not prevent otherwise lawful unrecorded care. Show costs before service.
6. Reserve a virtual scheduling resource and provider time; attach appointment when scheduled. Telehealth does not reserve an operatory by default. Shared conflict checking prevents an in-office and virtual appointment occupying the same clinician time.
7. Complete camera/mic/connectivity checks. Patient waits in a restricted lobby; they cannot receive provider chart data or enter another patient's room. Provider reviews intake, history, alerts and credential badge.
8. At clinical start, provider confirms patient identity, exact current location, callback, other participants, consent, and adequacy of modality. Server re-evaluates license authority and grants just this session's permissions.
9. Live video consultation opens alongside the shared chart. Provider documents remote findings, uncertainty, evidence quality, assessed urgency, diagnoses only where justified, and recommendations. Staff may draft; provider verifies. Remote findings never mark proposed in-person work as performed.
10. Capture selected PNG frames and anatomic links. Start audio/transcription only under valid consent. An optional bounded memory-only video replay buffer is purged when provider leaves, encounter ends, permissions change or the application tears down. Disable it where memory-only behavior cannot be guaranteed.
11. Provider chooses a disposition, safety instructions, follow-up window and appropriate destination. Any prescription uses the shared eRx subsystem and a fresh prescribing eligibility evaluation; confirm patient-selected pharmacy before signing/transmission.
12. End room/media separately from documentation. Provider verifies/signs the clinical encounter, including remote examination limitations. Create an appointment/referral task and patient summary. Signed record is immutable; later transcript/media reconciliation is an amendment or separately attributed late evidence.
13. Verify task completion: booking, referral acceptance, failed eRx resolution and patient receipt. Emergency disposition is closed only with documented handoff/follow-up status, including unable-to-contact outcomes.

## Intake and anatomical detail

TH-004: Use structured, versioned `TriageIntake` data with source, recorder, timestamp, patient-confirmed status and encounter linkage. Minimum fields:

| Domain | Required capture |
|---|---|
| Concern | Chief complaint in patient's own words; onset; duration; progression; prior episodes; triggering events |
| Pain | Patient rating; location; spontaneous/provoked; hot/cold/sweet/bite triggers; sleep/function impact; relief attempts |
| Location | Patient-indicated tooth/side/region; numbering ambiguity retained; provider-confirmed target stored separately |
| Swelling/infection concern | Location; progression; reported temperature or fever; swallowing/breathing difficulty; systemic symptoms |
| Trauma | Time; mechanism; knocked-out/broken/displaced tooth report; bleeding; head injury concern |
| Post-op | Procedure/date/provider; current symptoms; instructions followed; medications taken |
| Safety history | Allergies/reactions; active medicines; relevant conditions; pregnancy where relevant; pediatric weight/date/source if needed |
| Evidence | Uploaded photo/radiograph/document; source; acquisition date; body site; quality; patient authorization |
| Operational | Current address/state; callback; language/interpreter; accessibility; guardian; pharmacy choice |

Do not copy all medical-history answers as new immutable facts on every visit. Record reviewed version references plus patient updates. `unknown` is distinct from `no`. A patient selecting tooth #19 does not establish clinician-confirmed tooth #19.

TH-005: Findings use existing tooth/surface/region object IDs. Add `assessment_modality`, `source_media_id`, `remote_exam_limitations`, `evidence_quality`, and `certainty`. No probing depths, mobility grades or radiographic interpretations are inferred from live video. Separately attribute prior external measurements and their dates. Images do not become findings automatically.

## Urgency and safe escalation

TH-006: Licensed dental clinical leadership approves and versions a triage protocol before patient use. Prototype examples must not be published as validated clinical thresholds. Airway/swallowing compromise, severe uncontrolled bleeding, rapidly progressive swelling with systemic concern, and serious trauma concerns require immediate emergency routing according to the approved protocol; never merely advance these patients into an ordinary virtual waiting list. Severe pain, pediatric cases, fever and recent dental trauma require clinician prioritization and may require urgent in-person evaluation. Earlier Telorovia numeric thresholds are context, not validated clinical rules.

Disposition catalog: `emergency_transfer`, `urgent_in_person`, `scheduled_in_person`, `specialist_referral`, `remote_follow_up`, `self_care_with_safety_net`, `insufficient_information`. Store urgency, provider rationale, assessment limitations, recommended timing, destination/contact, instructions, patient understanding, return precautions, and assigned follow-up owner. Clinical protocol determines time targets; no universal hour cutoffs are invented here.

Emergency transport does not depend on platform payment, telehealth eligibility or normal appointment availability. License blocks do not prevent generic emergency safety directions or administrative routing. They do prevent restricted clinical assessment/prescribing. Provider records local emergency contacts and disconnect plan; the patient-side emergency action uses the patient's location. Do not assume dialing 911 from the provider's location dispatches help to the patient.

## Clinical and media lifecycle

TH-007: Keep three independent axes, not one overloaded status:

- Triage case: `requested → intake_pending → eligibility_pending → ready → waiting → assigned → assessment_active → disposition_pending → closed`; branches `cancelled`, `no_show`, `escalated`, `blocked`.
- RTC session: `created → lobby → active ↔ reconnecting → ended`; branches `failed`, `revoked`. Ending a session does not sign the encounter.
- Clinical encounter: existing `draft → in_progress → ready_for_review → verified → signed`, followed only by attributed amendments.

Provider reassignment invalidates prior provider-bound eligibility and session grants. Patient moves state or withdraws consent: suspend clinical actions, stop affected recording immediately, invalidate relevant grants, re-evaluate and obtain necessary consent before resuming. Revoked provider credentials trigger server removal, not just a disabled UI button. A documented emergency handoff remains available while clinical permissions are revoked.

TH-008: `TriageClosed` requires verified disposition and signed encounter for completed clinical care; a cancelled/abandoned/blocked case can close with an administrative reason, no fabricated signature or performed procedure. An incomplete consultation can still need an accurate signed clinical note if care occurred. Reconnects to the same encounter are not new clinical events or duplicate billable encounters.

## Shared-system integrations

| Capability | Integration contract |
|---|---|
| Scheduling | Shared provider conflicts; virtual resource capacity; optional appointment ID; urgent booking preserves triage linkage |
| Clinical chart | Shared encounter; provenance; tooth links; remote findings; structured recommendation distinct from completed procedure |
| Provider sign-off | Existing verification and signed version hash includes disposition, consent/location/evaluation references and selected evidence |
| eRx | Shared draft/reconciliation/pharmacy directory; fresh state/federal eligibility; vendor signing; status/error/CancelRx follow-up |
| In-person conversion | New appointment and distinct in-person encounter; parent triage relationship; never mutate original modality or signed note |
| Referral | Shared referral record with authorized disclosure, destination, status and owner; no uncontrolled emailed chart attachment |
| Billing | Verified modality and service-date terminology/payer rules produce candidates; no automatic D9995/D9996 or payment guarantee |
| Analytics | Queue/connect/complete times and dispositions with authorized aggregate access; minimize PHI |
| FHIR | Profile-specific mapping for Encounter modality extension, Observation, Condition, ServiceRequest, Appointment, DocumentReference, Consent and Provenance; verify partner profiles; no invented universal telehealth field |

TH-009: Capture requested, matched, joined, clinical-start, clinical-end and signing times separately. Use overlap of authorized human patient/provider participation for consult duration; bots/coordinators alone do not count. Emit one completion metering event per tenant+encounter+meter version; reconnects/replayed webhooks are deduplicated. Platform usage charges and insurance claim coding remain separate.

## Prescribing during remote care

TH-010: Remote clinical assessment must be documented before signing a medication order. Prescription references shared encounter, indication, patient-location confirmation and prescribing evaluation. Pharmacy address does not determine care jurisdiction. Patient home address is not a substitute for current location.

Non-controlled eRx checks provider authority, scope, current jurisdiction rules, adequate relationship/evaluation, medication safety review and pharmacy confirmation. For controlled medications, EPCS authentication and telemedicine legal authority are separate gates. An audited EPCS vendor alone does not establish legal authority for remote controlled prescribing. Default controlled telehealth prescribing is disabled until the full federal/state/provider rule path is approved and activated. Time-limited federal flexibilities must have explicit effective/expiry dates; no assumed permanent exception.

## Acceptance and implementation links

TH-011: All PHI and clinical mutations authorize tenant, actor, patient, relation, session and purpose server-side; token endpoints never trust a requested `role`.

TH-012: Consent and participant disclosure changes are auditable; no silent staff recording or hidden observers.

TH-013: Low bandwidth, reconnect, interpreter access, no-show, recording refusal, ineligible provider, media failure and urgent escalation have actionable UI paths.

TH-014: No permanent video containers, HLS segments, auto video egress, screen recordings or browser persisted buffers. Consent permits selected snapshots and audio; it does not authorize routine video retention.

TH-015: State evaluation covers 50 states plus D.C. and supports provider physical-location obligations, legal exceptions with reviewed evidence, modality, guardianship, recording and prescribing rules. See `20_state_license_evaluation.md`.

TH-016: Release requires a demonstrated authorized intake→video→chart→sign→Rx/booking→follow-up slice in staging using synthetic patients, plus negative authorization and jurisdiction tests. See `23_telehealth_acceptance_backlog.md`; UI in `21_provider_telehealth_portal.md`; media/security in `22_telehealth_rtc_security.md`.


---

# State-by-state dental authority evaluation

Normative requirements LIC-001–LIC-012. This is an engineering specification and governed jurisdiction registry, not a completed 51-jurisdiction legal opinion. The prototype evaluates reviewed input; it does not query dental boards or prove a license is genuine.

## Separate facts and policy

LIC-001: Model many provider credentials per dentist. Do not use a single `license_state` column. Store jurisdiction, profession, license/authorization number, registration, status, restrictions, validity, primary-source evidence, source checked time, verification expiry, verifier and relevant privileges. NPI, DEA registration, uploaded diploma and a self-entered license number are not substitutes for dental board authority verification.

LIC-002: Every clinical visit captures patient **physical** location and provider physical location. Obtain patient address/state/callback and an explicit confirmation at clinical start; reconfirm on reconnect, material change and before prescribing. IP/GPS may help detect inconsistency with consent; never silently determine jurisdiction from IP or mailing address. Unknown, outside supported jurisdictions, conflicting or moving locations block normal clinical actions and route to human resolution.

LIC-003: Evaluate `synchronous_consult`, `asynchronous_review`, `audio_only_consult`, `prescribe_noncontrolled`, and `prescribe_controlled` independently. Entering intake/booking, administrative support and emergency routing are distinct permissions. A consult ALLOW never becomes a blanket authorization for Rx.

## Inputs, immutable decision and outcomes

| Input | Required evidence |
|---|---|
| Identity/scope | Authenticated tenant and actor; patient relation; assigned provider; enabled privilege; session; requested purpose |
| Patient jurisdiction | Confirmation ID/version; current address/state; confirmed time; confirmer; conflicting evidence status |
| Provider jurisdiction | Current physical location; confirmed time; provider-region policy where applicable |
| Authority | Every relevant license/registration/permit; credential restrictions; verification validity; profession and identity match |
| State rule | Jurisdiction; effective range; review/activation status; version; sources; reviewers; allowed modality/purpose; conditions |
| Context | Age/guardian; consents; appropriate provider-patient relationship; clinical evaluation adequacy; scope; requested medication class |
| Rx gate | Independent eRx policy; state authority; PDMP conditions; applicable DEA/EPCS/federal remote authority and effective ranges |

Persist `EligibilityEvaluation`: decision ID; tenant/patient/provider/encounter; purpose; outcome `ALLOW | DENY | REVIEW_REQUIRED`; stable reason codes; evaluated time/expiry; input digest; location IDs; rule IDs/digests; credential evidence IDs and expiries; unmet conditions; human resolver if reviewed. Evaluation values are append-only; resolution creates a fresh evaluation.

`REVIEW_REQUIRED` blocks clinical execution just as `DENY` does, but shows missing evidence rather than asserting a legal prohibition. Front desk cannot override it. Compliance staff resolve source data/rule evidence and request reevaluation. Emergency access does not confer licensing or prescribing authority.

## Evaluation algorithm

1. Authorize tenant+patient+actor+purpose and assigned provider using shared permission service. Failure stops before clinical information is returned.
2. Validate confirmed stationary patient/provider locations and identity; reject stale/unknown/mismatched evidence. Location-confirmation freshness is a configurable product control, not a statutory time period.
3. Load applicable dental rules for **both** physical jurisdictions as of server time. Rules must be reviewed, activated, not superseded, within effective dates and review expiry. Generic physician telemedicine exemptions must not be applied to dentists automatically.
4. Evaluate patient-jurisdiction dental authority, active registration where required, verified source freshness, restrictions, applicable full license or a specifically reviewed alternate authorization. Multiple credentials require selecting a valid one for the requested purpose; one expired license must not invalidate a separate valid authority.
5. Evaluate provider-location obligations under its reviewed dental policy, including any locally required authority. Do not assume an out-of-state patient license resolves provider-location law.
6. Validate permitted modality, role/supervision, patient relationship/evaluation, guardian and consent conditions. Record unknown as unknown, not consented or compliant.
7. For prescribing, evaluate additional patient-state/provider-state rules and federal conditions, medication class/scope, DEA authority, PDMP and compliant signing integration. Evaluate at sign and immediately before transmit; source changes invalidate prior authorization. The external vendor remains final authority on its actual signing/transmission boundary.
8. Persist a time-limited evidence-bound evaluation. Atomic action commit checks that provider assignment, credential/rule versions, consent and location digests remain current. Issue only room-bound/role-derived join tokens or action-specific authorization, never a reusable general license pass.

Recommended prototype TTLs: location confirmation 15 minutes, evaluation maximum 5 minutes, bounded further by all credential/rule expirations. These are initial implementation controls requiring operational tuning. Room continuation uses monitoring/event-driven revocation, not reliance on token TTL alone. Rule/status changes invalidate related grants, running sessions and background queued actions.

## Registry coverage and governance

LIC-004: `config/jurisdiction_registry.json` contains all 50 states and D.C., each with its own disabled, unreviewed policy slot. No state is implicitly permissive. NY includes a retrieved official guidance link and partial factual notes but remains disabled until complete local legal/clinical review; the remaining entries deliberately have no invented laws/source URLs.

For every state, complete the worksheet in `planning/state_rule_review.csv`: dental board authority and primary-source license lookup; full/alternate authority and registration; provider-location obligations; modalities; professional relationship/evaluation; consent/minors/recording; non-controlled prescribing; controlled/PDMP; records/retention; citation sections and effective dates; reviewer and revalidation schedule. Availability and payer coverage are separate from legal clinical eligibility.

LIC-005: Two-person publication of production rules: credential/regulatory reviewer proposes; authorized approver activates version with sources, tests and dates. Providers cannot edit their own verified credential or activate exceptions. Clinical staff may report discrepancy. Change notification records source and operational effect. Revocations/known restrictions apply immediately, even inside an otherwise fresh cache.

LIC-006: Dental-board adapters may be API, licensed verification service or documented manual primary-source workflow. Do not scrape restricted portals or assume every board exposes an API. Retry transient lookup failures without treating errors as active credentials. Still-valid documented verification may be used only within approved freshness policy and with no adverse signal; otherwise block and resolve.

LIC-007: Compacts, temporary permits, consultation exceptions and telehealth registrations are typed, state-specific authorities with effective dates, evidence and purpose limits. No generic interstate compact flag grants nationwide dental practice authority.

LIC-008: Pilot rollout enables only fully reviewed jurisdictions and verified individual providers; unsupported patient states display a clear booking/referral explanation. The registry's presence does not mean nationwide availability.

## Worked product scenarios

| Scenario | Required behavior |
|---|---|
| NY patient, verified active/currently registered NY dentist, all rules/consent/context valid | Consult can ALLOW; Rx gets an independent evaluation |
| Same patient travels to NJ for this call | Evaluate NJ current location; original NY permission is invalid |
| NY dentist licensed only in NY sees a California patient | DENY missing required authority unless a reviewed, evidenced applicable CA alternate path exists |
| Uploaded license exists but primary-source verification expired | REVIEW_REQUIRED; no join for clinical care |
| One of dentist's three licenses expires | Re-evaluate affected jurisdictions; choose separate valid authority where applicable |
| Rules service missing, unreviewed, expired or conflicting | REVIEW_REQUIRED; no permissive fallback |
| Patient picks a pharmacy in another state | Confirm pharmacy; do not replace patient jurisdiction with pharmacy state |
| Authorized consult, controlled Rx requested | Independent remote controlled authority + DEA/PDMP/EPCS gates; otherwise blocked |
| Staff invokes break-glass | May enable audited emergency record access; cannot fabricate license authority |
| Provider license suspended mid-call | Revoke clinical grants and stop privileged actions; preserve documentation and emergency handoff |

LIC-009–LIC-012: API denials return non-PHI reason codes and actionable resolution; record historic rule/evidence snapshots for signed care; validate state/version race conditions server-side; independently test any real board and prescribing adapters. See executable policy prototype and tests in `starter/` for a deliberately limited, dependency-free reference.


---

# Separate provider Telehealth portal — screen and behavior contract

The provider's global navigation includes a first-class **Telehealth** destination. It shares platform sign-in/MFA and identity, and has its own routes, layout and worklists. It is not a separate external Telorovia login. A chart shortcut deep-links here while preserving the patient/encounter context. Front desk and coordinator views use scoped permissions; system administrators do not automatically receive live-room or chart access.

## Route map

| Route | Screen | Main actions |
|---|---|---|
| `/provider/telehealth` | Today | Consult queue, urgent flags, readiness, available provider status, unsigned notes, follow-up tasks |
| `/provider/telehealth/schedule` | Virtual schedule | Shared provider calendar, virtual blocks, requests, reschedule, no-show |
| `/provider/telehealth/queue` | Waiting room | Assign/accept, pre-screen preview, eligibility status, interpreter/guardian readiness |
| `/provider/telehealth/cases/:caseId` | Intake review | Symptoms, history changes, patient evidence, location, credential decision, consent, emergency plan |
| `/provider/telehealth/sessions/:sessionId` | Consultation | Live A/V, chart, annotations, selected snapshots, notes, disposition, shared Rx |
| `/provider/telehealth/cases/:caseId/review` | Verify and sign | Structured findings, limitations, disposition, orders, consent/evidence references, signature |
| `/provider/telehealth/follow-up` | Worklist | Appointment/referral ownership, eRx failures, patient contact and completion |
| `/provider/telehealth/credentials` | My state eligibility | Own verified authority/expiry and state availability; request review; no self-verification |

Opaque IDs only in routes; state/case details fetched after authorization. Consult-list search is authenticated, limited and audited; no names or medical complaints in query-string URLs or browser analytics.

## Today and waiting room

Each queue row shows permitted patient identity, scheduled/wait time, symptom summary, patient state, assigned provider, urgency, location/consent/technical readiness, and license-evaluation status with reasons. Text/icon status accompanies color. Filters: my cases, assigned location, modality, urgency, scheduled/on-demand, state and ready/blocked. Only scoped users can see a shared DSO queue. Assigned status and provider membership are server state, not client cache truth.

Buttons: Review intake, Accept assigned case, Open patient chart, Contact patient, Escalate, Start consultation, Record no-show. Start requires current authority, identity/location/consent and camera/mic readiness or a specifically permitted alternate modality. A blocked button gives an accessible reason and resolution path. No generic Override button.

## Consultation workspace

Persistent banner: patient name and DOB, allergies/critical alerts, current patient state/address access, callback, provider identity/credential badge, telehealth consent, recording status, connectivity and draft-save status.

Layout: central live video and explicit audio controls; shared dental chart/intake pane; structured annotation/note inspector; bottom evidence/timeline strip and disposition actions. Responsive tablets can switch panes without losing live video or safety banner. Patient-reported target and clinician-confirmed target are visibly different. All entered clinical facts display remote modality and draft/verified status.

Actions: Capture PNG, review/annotate snapshot, select tooth/surface/region, draft observation, draft note, review suggested transcript extraction, choose disposition, open shared prescribing drawer, reserve in-person appointment, refer, pause for eligibility/consent change, end session. Capturing a snapshot displays success only after authorized storage confirms integrity and linkage. Unsaved-frame errors retain a visible retry path while the frame remains permitted in memory.

The patient always sees participant names/roles and recording/transcription indicator. Staff/guardian/interpreter addition triggers admission/disclosure and affected consent re-evaluation; no hidden support attendee. Coordinator permissions default to waiting-room operations, not seeing every live call.

## Verify/sign and follow-up

Review screen lists history/allergy reconciliation, remote exam adequacy/limitations, findings and uncertainty, disposition/timing/rationale, safety net, pharmacy confirmation, prescription status, evidence, participant list, location/eligibility/consent versions. Warn about late/failed audio/transcript evidence; do not silently hold or mutate a signed note. Provider attests actual assessment and decisions; it does not attest future restorative work as complete. Sign uses existing encounter privileges and immutable canonical payload.

Close consultation is distinct from sign record, transmit Rx and close follow-up. Each has a visible pending/completed/failed status and responsible owner. Instructions and visit summary publish through the existing patient portal. Patient receipt is documented where possible; receipt is not equivalent to clinical improvement.

## Patient-side journey and usability

Patient routes `/patient/telehealth/request`, `/patient/telehealth/cases/:caseId/intake`, `/patient/telehealth/cases/:caseId/waiting`, `/patient/telehealth/sessions/:sessionId` and `/patient/telehealth/cases/:caseId/summary` use existing identity/delegation. Invitations exchange a single-use, short-lived opaque secret through a controlled flow; never put PHI in links or treat possession of a long-lived URL as identity proof. Minor consent and guardian authority are evaluated under actual jurisdiction policy.

Plain-language intake with progress/save, phone camera guidance, clear costs, current-location confirmation, separate recording consent, pharmacy search, pre-call checks, visible wait updates, callback and accessible cancel/reschedule. Device permission denied, no camera, low bandwidth, recording refused, no licensed provider and clinical escalation all have explicit next steps. Do not promise care completion, prescriptions or payer coverage merely because booking succeeded.

Keyboard and screen-reader equivalents, live captions under lawful transcription consent, interpreter workflows, zoomable text and touch targets. Do not expose raw transcripts where authorized users have not been granted access. No browser offline PHI caching in the initial release. On disconnect, persist drafts server-side, show reconnection/phone plan, re-evaluate required location and permissions, and preserve the same encounter.

Usability acceptance: five representative dentist/coordinator/patient walkthroughs using synthetic data; start a ready visit without visiting Administration; blocked eligibility has a specific fix; review prior chart without duplicate entry; order Rx and book follow-up inside this workspace; all actions available by keyboard. Quantitative click/time targets are established during pilot observation.


---

# RTC, consent, media and operational security

## Components and trust boundaries

Provider Telehealth portal + patient portal → existing authenticated API → Telehealth orchestration module → shared record/scheduling/eRx/signature services. Media plane: scoped LiveKit-compatible SFU/TURN; approved audio egress; approved transcription service. Clinical API remains authoritative for chart updates; realtime data messages may carry temporary UI coordination only, not unsigned durable clinical writes or secrets.

Before PHI flows, document executed BAAs and contract/service coverage for RTC, TURN, media processing, transcription, object storage and relevant subprocessors. Vendor marketing compliance labels do not establish coverage for every plan or feature. LiveKit's retrieved security page advertises BAAs for Scale/Enterprise; verify actual account and scope. Pin and test SDK/server versions behind `RtcAdapter`; do not copy deprecated sample APIs uncritically.

## Session grants and enforcement

Backend creates a room using opaque session identity without names/complaints. It derives tenant, participant, assignment and role from authentication/database. A supplied role/provider ID cannot elevate grants. Join request evaluates purpose, current location/consent and credentials and persists its decision. Signed short-lived tokens are room scoped, identity scoped and grants scoped; no browser room admin/list/create/record grants. Tokens are never stored in database logs, URLs, analytics, support exports or localStorage.

Provider/patient can publish/subscribe only in the authorized active room. A waiting patient uses a restricted lobby until authorized admission. Coordinator/interpreter/guardian use their own identities and narrow session membership; admin viewing requires explicit permitted access and disclosure. Server retains ability to remove participants and terminate rooms; JWT expiration alone must not be treated as disconnection or revocation of an already joined client.

Use HTTPS/WSS and WebRTC transport security, private credentials, quota/rate limits, per-tenant membership, step-up workforce authentication, session/device controls and PHI-safe health metrics. E2EE versus server audio recording/transcription is an explicit architecture decision: processors cannot operate on opaque encrypted media without appropriate keys. Do not promise server-blind E2EE while granting server processors decryption access. Document the actual trust boundary and key lifecycle.

Webhooks verify authenticity according to pinned SDK, deduplicate vendor event IDs, validate room/session ownership, handle replay/out-of-order events and never allow a stale participant-left event to overwrite a later reconnect. Room availability/webhook disconnect is distinct from clinician-completed care. Reconcile authoritative session state after missed webhooks. Failed handoff/transmission events create owned worklist tasks.

## Retained media policy inherited from Telorovia

| Data | Retention behavior |
|---|---|
| Live video | No permanent recording; transient transport only |
| Optional replay buffer | Bounded duration and memory, no persistent storage; purge on provider departure/end/revocation/teardown |
| Selected PNG frames | Intentional dentist capture, authorized consent where required; shared clinical-media record, encrypted object, digest, source/frame time and anatomy linkage |
| Session audio | Retain only with valid separate recording permission under reviewed participant-jurisdiction rules; segmented for withdrawal/disconnect boundaries |
| Transcript | Authorized transcription only; draft evidence with source time/speaker/confidence; never silently becomes verified findings |
| Signed note | Immutable attested clinical record; audio/transcript linkage and limitations included when available |

Disable auto egress and prohibit video selectors/outputs, MP4 video/HLS video, screen-share recording and disk-backed replay. Audio containers may vary; acceptance inspects actual tracks to verify zero video tracks. Retrieved LiveKit docs currently support audio-only sources; an SDK adapter must configure and test that exact option. Exclude egress/service participants from generic subscription widening; source documentation warns subscription updates can change what egress captures.

Memory-only replay is a custom capability, not promised by stock LiveKit egress. Test bounded memory, browser implementations, crash behavior and non-persistence. Disable buffers if the deployed environment cannot satisfy the policy. Purging transient replay does not delete legally retained signed records/audio/selected evidence.

Recording/transcription state has independent lifecycle `not_requested | awaiting_consent | permitted | active | stopped | failed`. Store participant consents with template/version/jurisdiction/purpose and revocation time. Revocation stops future capture/transcription immediately and records an event; lawful retention of earlier evidence follows approved policy. Refusal follows unrecorded visit pathway; cannot silently substitute transcription or record another participant's track. New participants and changed locations re-evaluate requirements. Never infer recording permission from accepting general portal terms.

## Persistence and signed evidence

Media upload uses authorized pending media record and short-lived scoped upload destination; validate type/size, malware-check imported attachments, validate patient/encounter and digest, then finalize record and audit. Viewing/downloading requires scoped permission with short-lived access. Rendered originals, annotated derivatives and source time are separately attributed. Clinician snapshots of a low-quality video frame show quality limitation.

Encrypt storage and keys; restrict vendor/service identities; redact logs; prohibit browser recordings, analytics session replay and production PHI in fixtures. Use clinical retention/legal hold schedules per jurisdiction; no arbitrary universal audio-retention duration. Deletion policy reconciles retention, patient rights, legal holds and backup lifecycle. Legal hold applies to clinical retained media, not retroactively authorizing routine persistent video.

Signature captures the clinical payload and evidence references/digests that existed at sign time. Transcription arriving afterward is marked late, unattested evidence; any changed signed clinical facts require amendment. Do not rewrite signature payload because an audio pipeline finishes later.

## Reliability and operational targets

Initial product targets, not legal requirements: authorized join-token API p95 ≤1s excluding external review; queue updates ≤5s; successful reconnect should preserve encounter and drafts. Instrument with synthetic tests and minimized metrics. Establish SFU/TURN capacity, device/browser matrix, media-region outage runbook, secure callback fallback, RTO/RPO and live-session downtime policy before pilot. Never route failed video into unapproved audio-only care automatically.

Each room teardown stops egress/STT, clears replay, revokes grants and reconciles uploads. Provider departure always purges replay; staff cannot keep the provider's replay buffer alive. Cleanup jobs catch orphan rooms/egress and pending uploads. Recording failures are visible; document care truthfully without claiming missing evidence exists. No open room remains accessible after signing/ending merely because a token has not expired.


---

# Telehealth implementation backlog, traceability and release gates

This module is part of the platform delivery scope. A functional handoff must lead to a working integrated vertical slice, not a portal mockup or uncontrolled video demo. The package supplies specs/contracts plus a tested policy prototype, not a deployed telehealth product or legally activated national rules.

## Bounded epics

| Epic | Depends on | Reviewable result |
|---|---|---|
| TH01 — Credentials and jurisdiction rules | E01/E04 | Many verified authorities; 51 jurisdiction slots; governed source review; purpose-specific eligibility; immutable decisions |
| TH02 — Intake, consent, emergency routing | E03/E13/TH01 | Structured pre-screen; location/guardian/callback; consent/refusal; approved safety prompts; queue readiness |
| TH03 — Provider portal and virtual schedule | E05/E12/TH02 | Dedicated routes; ready/blocked queues; shared calendar conflicts; assignment and follow-up ownership |
| TH04 — RTC and media | E11/TH01/TH02/TH03 | Real authorized provider/patient room; scoped lobby/tokens; PNGs; audio/STT permission; zero permanent video |
| TH05 — Integrated documentation and sign-off | E06/E07/E10/TH04 | Remote findings/evidence, uncertainty, disposition, immutable signed shared encounter and amendment |
| TH06 — Shared prescribing and conversion | E14/TH05 | Independent Rx gate, selected pharmacy/vendor status, new in-person appointment/encounter and referral |
| TH07 — Hardening and pilot | TH01–TH06 | Negative tests, multi-state scenarios, vendor/BAA coverage, clinician review, operational drill and monitored rollout |

Controlled remote prescribing adds TH08 only after E20 and separately approved federal/state authority. Do not make EPCS the initial telehealth launch dependency. Core triage may run with prescribing disabled while eRx integration is pending; full requested vertical slice includes enabled non-controlled eRx where authorized.

## Acceptance matrix

| Test | Requirement | Required evidence |
|---|---|---|
| AT01 | TH-001/TH-002 | Provider opens dedicated Telehealth portal; intake/call/sign/Rx/booking share same patient UUID and encounter lineage |
| AT02 | TH-004/TH-005 | Patient-indicated tooth is separate from confirmed target; unknown history distinct from no; remote modality/limitations persisted |
| AT03 | LIC-001/LIC-003 | Multiple licenses select applicable authority; a consult pass cannot grant Rx permission |
| AT04 | LIC-002 | Mailing/pharmacy address irrelevant to current location; patient travel from NY to NJ invalidates prior gate |
| AT05 | LIC-004/LIC-008 | Exactly 50 states plus D.C.; every unreviewed/unsupported rule blocks normal care; NY evidence alone does not activate rules |
| AT06 | LIC-005/LIC-006 | Expired/stale/unverified/suspended/restricted authority or missing state source gives blocking result; no staff/admin override |
| AT07 | LIC-007 | Compact/registration/temporary exceptions require typed evidence, dates and explicit dental applicability |
| AT08 | LIC-011/TH-011 | Tenant B cannot list, join, annotate, upload, sign or prescribe against tenant A IDs; server ignores user-supplied elevated role |
| AT09 | LIC-012 | Credential revocation or assignment/location/consent/rule change between evaluation and action prevents commit and removes relevant live access |
| AT10 | TH-012/TH-014 | Recording refusal permits eligible unrecorded visit; audio/STT start only under consent; withdrawal stops capture; video never persists |
| AT11 | TH-014 | Inspect actual retained containers: audio only, selected PNG; replay uses bounded RAM and purges on provider leave/end/revoke/crash cleanup |
| AT12 | TH-006 | Approved emergency scenario skips normal queue/paywall; records current address/local contacts and safe handoff; a license block does not suppress generic emergency instructions |
| AT13 | TH-007/TH-008 | Session end does not sign note; no-show/cancel does not fabricate procedure/claim; reassignment requires new evaluation |
| AT14 | TH-009 | Reconnect and duplicate/out-of-order webhooks cause no duplicated encounter/completion fee or stale status regression |
| AT15 | TH-010 | Non-controlled Rx requires new purpose-specific authority, documented assessment, pharmacy confirmation and vendor acknowledgment; failures become worklist tasks |
| AT16 | TH-010 | Controlled path blocked despite consult authorization and normal MFA until remote authority, DEA/PDMP and vendor EPCS signing gates pass |
| AT17 | TH-005/TH-008 | Signing freezes verified findings/disposition/evidence references; late transcript cannot silently change clinical facts |
| AT18 | TH-002/TH-016 | Convert to in-person appointment/new encounter with lineage; planned restoration remains planned until actually performed |
| AT19 | TH-013 | Low-bandwidth/reconnect/device denial/interpreter/guardian/accessibility paths exercised; audio-only fallback needs distinct permission |
| AT20 | TH-011/TH-012 | Logs, metrics, tokens, invitation URLs, crash reports and support tools do not expose unnecessary PHI or hidden room membership |
| AT21 | TH-016 | Synthetic two-browser patient/provider call with snapshot, consented audio, annotation, sign-off, eRx sandbox and booked follow-up in staging |
| AT22 | TH-016 | Vendor outage/drill, failed egress, unsigned-record worklist, unresolved urgent referral and secure callback are observable and assigned |

Policy prototype unit tests provide early evidence for AT03–AT07 and expiry behavior only. They do not satisfy actual authorization/RTC integration, medical safety, board verification, vendor EPCS or deployment release gates.

## Threat cases requiring explicit tests

Cross-tenant room IDs; stolen/replayed invitation; forged patient state; guessed role; stale provider assignment; revoked license inside session; consent withdrawal during egress; observer admitted without disclosure; queued prescription sent after state rule expires; provider switching patient while recording still active; snapshot linked to wrong mouth; async assessment from a stale upload location; replay persisted through browser disk cache; AI transcript converting uncertain speech into diagnosis; abandoned room billed as completed; break-glass used as license override.

## Release evidence and responsible reviewer

| Gate | Owner | Concrete artifact |
|---|---|---|
| Clinical safety | Licensed dental lead | Approved protocol/version; remote assessment/limitations templates; emergency and referral walkthroughs |
| Jurisdiction | Regulatory/credential leads | Reviewed primary sources and credential evidence for each enabled state/provider; effective/expiry dates and policy fixtures |
| Privacy/vendor | Privacy/security leads | PHI-flow inventory, executed BAAs/service scope, recording/transcription policy and consent review |
| Security | Security engineering | Negative authorization/tenant tests, revocation race tests, token/webhook audit and penetration findings resolved |
| Product | Product/UX | Dedicated portal walkthrough with dentist/coordinator/patient and keyboard accessibility |
| Integration | Engineering/QA | Live two-browser staging call; retained-track inspection; record/Rx/booking consistency and idempotency |
| Operations | Practice/operations | Emergency disconnect, credential failure and vendor-outage runbooks; assigned follow-up queues and support boundaries |

Start with a small number of fully reviewed states and providers. Add states by rule-version release with source review and fixtures, not by disabling the default block. National coverage is a rollout outcome, not a property of the seed registry.


---

# Handoff validation — 2026-10-06

Completed checks on version 1.1.0:

- **32 executable policy tests passed** using Node 24.19.0. Synthetic tests cover missing/stale/expired/suspended credentials, source review, separate consult/Rx authority, patient travel, provider jurisdiction, consent/guardian/clinical adequacy, lifetime binding and changed assignment/status.
- Registry has exactly **50 states plus D.C.**, with unique codes and every entry disabled/unreviewed. The registry-coverage test confirms no seed entry returns ALLOW.
- JSON files parsed; CSV column counts checked; both OpenAPI YAML files parsed. Main API has 24 paths, including 16 telehealth paths. All local OpenAPI references resolve and every path parameter has a required definition.
- Original 32 package files are retained; added module contracts, integration amendments, policy prototype, acceptance backlog and diagrams are included. ZIP integrity and entry inventory checked during packaging.

Checks not performed and required before production:

- PostgreSQL migration execution, database authorization/tenant tests and deployment migration review. No PostgreSQL runtime was available for this handoff validation.
- Full OpenAPI/JSON Schema semantic validation using an external validator, generated client compilation and real API integration. The checks above are structural parse/reference checks.
- Dental board verification service integration or completed 51-jurisdiction legal review. NY has partial primary-source notes, not active production policy.
- Actual two-browser RTC call, audio/no-video track inspection, consent withdrawal/revocation races, browser replay-memory testing, transcription, signing/eRx/booking integration or clinical emergency-protocol validation.
- Vendor-specific BAA/service coverage, penetration testing, HIPAA operating controls and audited/certified EPCS path.

This is an integrated development-team handoff with a tested policy reference, not a deployed portal, production-complete schema, clinical safety certification or national license-clearance service. Release criteria and reviewers are in document 23.
