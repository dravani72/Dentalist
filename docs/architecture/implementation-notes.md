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
| Practice setup: staff, privileges, licenses, provider hours, first sign-in | 0008; `apps/api/src/admin/*`, `src/scheduling/availability.ts`; `packages/shared/src/staff.ts`; `apps/web/src/pages/admin/*`, `AccountSetup.tsx`; details in `practice-setup.md` |
| Patients tab filters and recall | `apps/api/src/patients/patients.service.ts` `search()`, `src/scheduling/recall.ts`; `PatientListQuery` in `packages/shared/src/schemas.ts`; `apps/web/src/pages/Patients.tsx`. See "Patient filters and recall" below |
| Telehealth triage: cases, intake, jurisdiction eligibility, sessions, remote findings, signing evidence | 0009; `apps/api/src/telehealth/*` (`RtcAdapter`, `FakeRtcAdapter`); `packages/shared/src/telehealth.ts`; `config/jurisdiction_registry.json`; `apps/web/src/pages/telehealth/*`, portal `telehealth.tsx`; details in `telehealth.md` |
| Periodontal charting (Phase 6): six-site probing, recession, CAL, BOP, suppuration, plaque, calculus, furcation, mobility, keratinized gingiva | 0010; `apps/api/src/charting/perio.service.ts`, `perio-rows.ts`, `entry-kinds.ts` (`perio`); `packages/shared/src/perio.ts`; `apps/web/src/pages/PerioTab.tsx`. See "Periodontal charting" below |
| Endodontic charting (Phase 6): AAE-style pulpal and apical diagnosis, pulp and periapical tests with control teeth, canals of a root canal (working length, preparation, obturation) | 0011; `apps/api/src/charting/endo.service.ts`, `endo-rows.ts`, `entry-kinds.ts` (`endo_dx`, `endo_test`, `endo_canal`); `packages/shared/src/endo.ts`; `apps/web/src/pages/EndoTab.tsx`. See "Endodontic charting" below |
| Oral surgery (Phase 6): structured extraction record (approach, impaction, flap, bone removal, sectioning, socket graft, sinus, hemostasis, sutures, complications, post-op), biopsy specimens, pathology results and the waiting list | 0013; `apps/api/src/charting/surgery.service.ts`, `surgery-rows.ts`, `entry-kinds.ts` (`surgery`, `specimen`, `specimen_result`); `packages/shared/src/surgery.ts`; `apps/web/src/pages/SurgeryTab.tsx`, `Patients.tsx` (worklist). See "Oral surgery" below |
| Implant records (Phase 6): implant as a persistent device (manufacturer, catalog, lot/serial, size, torque, ISQ, grafts) and its later steps (uncovery, abutment, restoration, checks, complications, removal) | 0012; `apps/api/src/charting/implant.service.ts`, `implant-rows.ts`, `entry-kinds.ts` (`implant`, `implant_event`); `packages/shared/src/implant.ts`; `apps/web/src/pages/ImplantsTab.tsx`. See "Implant records" below |
| Lab cases (Phase 6): dental labs, lab prescriptions (units by tooth or arch, material, shade, impression, enclosures), dentist authorization, the round trip back and forth, seating, and the practice-wide tracking list | 0014; `apps/api/src/lab/*`; `packages/shared/src/lab.ts`; `apps/web/src/pages/LabCases.tsx`, `LabCasesTab.tsx`. See "Lab cases" below |
| Diagnostic imaging (Phase 6): DICOM studies (CBCT volumes and 2D DICOM radiographs) kept as original files plus a viewing volume, patient identity check, the in-browser viewer with measurements, the dentist's read, and the unread worklist | 0015; `apps/api/src/imaging/*`; `packages/shared/src/dicom.ts`, `imaging.ts`; `apps/web/src/pages/ImagingTab.tsx`, `components/VolumeViewer.tsx`, `Patients.tsx` (worklist). See "Diagnostic imaging" below |
| Controlled-substance prescribing (Phase 7): DEA registrations, enrollment with the partner, two-person EPCS access, signing in the partner's certified window | 0016; `apps/api/src/prescribing/epcs.service.ts`, `epcs.controller.ts`, `erx-partner.ts`, `fake-erx-partner.ts`; `packages/shared/src/epcs.ts`; `apps/web/src/pages/admin/EpcsAdmin.tsx`, `PrescriptionsTab.tsx`, `components/PartnerWindow.tsx`. See "Controlled-substance prescribing (EPCS)" below |
| Odontogram and visit layers | `apps/web/src/components/Odontogram.tsx`, `lib/chart-model.ts`, `pages/ChartTab.tsx` |

## Deliberate deviations

- **Plain SQL migrations and `pg` instead of Drizzle.** Row-level security, exclusion constraints, immutability
  triggers and SECURITY DEFINER functions are the core of the design, and they read more clearly as SQL than as ORM
  escape hatches. Swapping in Drizzle later only touches the data-access layer.
- **Custom schedule grid instead of FullCalendar Premium.** Avoids a commercial license for the prototype. The grid
  is operatory-column based; drag-to-reschedule is not built (the API supports reschedule).
- **Schedule to patient record.** Clicking a patient's name on an appointment opens their record on that
  appointment's visit layer (or the complete chart, with "Start visit for this appointment", when nothing is charted
  yet; starting it links the visit to the appointment and seats the patient). A sticky "Back to schedule" bar returns
  to the same location and day with the appointment selected. The hash carries only opaque ids and the schedule date
  (`#/patients/<id>/chart?from=schedule&loc=…&date=…&appt=…`, `#/schedule/<location>/<date>/<appointment>`).
- **Local adapters stand in for AWS.** `LocalRecordSigner` (Ed25519 keys on disk) for KMS signing,
  `LocalFieldCipher` (AES-256-GCM) for KMS envelope encryption, encrypted local files for S3, the in-process outbox
  worker for SQS, password + TOTP for Cognito. Each sits behind an interface so the production adapter is a drop-in.
- **`FakeErxPartner` instead of DoseSpot.** Implements search, screening (allergy cross-reactivity, interactions),
  idempotent transmit and an asynchronous status callback over the real signed webhook path, plus the partner's EPCS
  steps (drug schedules, identity proofing, signing tokens, logical access, the two-factor signing window). It is not
  certified and nothing leaves the process.
- **Video: self-hosted LiveKit or a sandbox.** `LiveKitRtcAdapter` (`RTC_PROVIDER=livekit`) gives real video;
  `FakeRtcAdapter` (default, used by tests) carries no media. Only synthetic jurisdictions ZZ and ZY are enabled.
  See `telehealth.md`.
- **Token in sessionStorage.** The web client keeps the opaque session token in memory/sessionStorage. Production
  should move it to an httpOnly, SameSite=strict cookie at the gateway.

## Fixed while building

- The signed-row guard trigger let any column change on tables with no post-signing mutable columns (PL/pgSQL
  `TG_ARGV` is NULL when no arguments are passed). The guard now defaults to "everything frozen"; a test proves a
  direct UPDATE on a signed finding fails.
- A plan item fulfilled by a procedure now records which procedure fulfilled it.
- The outbox worker's polling timer let a failed poll (for example during a database reset) crash the API with an
  unhandled rejection. Failed polls are now logged and retried on the next tick.
- DATE columns are returned as `YYYY-MM-DD` strings, so a date of birth can never shift by a day across time zones.

## Patient filters and recall

The Patients tab filters by recall, next appointment, treatment plan, provider, age group and balance; filters
combine with each other and with the search box, and work without a search term (first 200 rows).

- **In recall** (the active cycle of care) means an open recall (`due` or `scheduled`) with a due date, or treatment
  that is still to be done (plan items `PROPOSED`, `PLANNED`, `PATIENT_ACCEPTED`, `SCHEDULED`). **Overdue** and
  **Due in the next 30 days** look only at the recall due date, in the home location's time zone.
- **Recall is restarted by signing.** When a visit that includes a signed prophylaxis or periodic exam is signed, the
  open hygiene recall is marked `completed` and a new one is due one interval after the visit date (the patient's
  existing interval, else `DEFAULT_RECALL_MONTHS` = 6). Audited as `recall.create` with `source: encounter.sign`.
  Re-signing an amended visit does not move it. `POST /recalls` still sets one by hand.
- **Provider** means booked with (any non-cancelled appointment) or performed work for the patient.
- **Balance** filters on the estimated patient share (ledger balance minus insurance still expected). It needs
  `billing.read`; staff without it get 403 for the filter and no amount column.
- The search is audited as `patient.search` with the filters used; the search text is never written to the audit.
- There is no inactive/deceased patient status yet, so every patient with an open recall counts as current.

## Periodontal charting

The **Perio** tab on a patient record charts a full-mouth exam and compares it with an earlier one.

- **A perio exam is a chart entry of its visit**, like a finding: one live exam per visit, recorded by anyone with
  `clinical_finding.record` (hygienists, assistants, dentists). Measurements are typed rows, not JSON:
  `perio_tooth` (mobility 0-3, keratinized gingiva in mm, mucogingival defect, note) and `perio_site`
  (MB B DB DL L ML: probing depth, recession, bleeding, suppuration, plaque, calculus, furcation grade I-IV).
- **CAL is computed by Postgres** (`probing_depth + recession`, a generated column), so it can never disagree with the
  two values it comes from. Recession is CEJ to gingival margin, negative when the margin is above the CEJ.
- **Furcations only where a tooth has one**: maxillary molars B, ML, DL; maxillary first premolars ML, DL;
  mandibular molars B, L. Primary teeth are refused (the perio chart covers the permanent dentition).
- **Saved a tooth at a time** (`POST /perio-exams/:id/teeth`) with the tooth's version as an optimistic lock; a save
  that changes nothing does not bump the version. Every save is audited as `perio.record` with the tooth's position code.
- **Signing locks the exam with its visit.** The exam and its measurements (aggregated in a fixed order, without
  timestamps) are part of the attested payload, so integrity checks catch any change to a single site. A database
  trigger refuses writes to measurements of a signed or voided exam, and measurements on another patient's tooth.
- **Amendments supersede the whole exam**: the first save during an amendment copies the signed exam and its
  measurements to a new exam (keeping who recorded each value) and applies the change there. The amendment diff
  lists `perio` with `teeth` or `sites` as the changed fields.
- **In person only.** A telehealth visit cannot start a perio exam (TH-005).
- **Entry**: click or tap a cell, then type. A digit enters the value and moves along the usual probing path
  (maxillary buccal 1→16, palatal 16→1, mandibular lingual 17→32, buccal 32→17), skipping teeth the chart shows as
  missing or extracted. Shift + digit adds 10, "−" makes a recession negative, B S P C toggle site findings. The
  keypad under the chart does the same for touch and stylus. **Voice entry is not built**: browser speech recognition
  sends audio to a third-party service, which would be a new PHI vendor needing a BAA review.
- **Colorblind-safe**: 4-5 mm depths are bold and underlined, 6 mm and deeper are bold in a dark box, site findings are
  letters (B S P C) with distinct shapes, the gingival margin line is solid with round points and the pocket base
  dashed with square points, and changes since the compared exam carry ▲ / ▼ arrows.
- **Comparison** shows the whole-mouth numbers side by side and lists every site whose depth or attachment level
  moved by 2 mm or more. These numbers are descriptive; staging, grading and diagnosis stay with the dentist.
- The seed gives Jordan a signed comprehensive exam on the 2023 recall visit; today's visit has none, so a new exam
  can be started there and compared with 2023.

## Endodontic charting

The **Endo** tab on a patient record shows one tooth at a time: its endodontic diagnoses, pulp and periapical tests,
and the canals of each root canal.

- **Three kinds of chart entry**, each recorded in a visit, signed with it and amended by superseding the row:
  `endo_diagnosis` (pulpal and apical diagnosis plus presenting symptoms), `endo_test` (cold, heat, EPT, percussion,
  palpation, bite on one tooth, optionally marked as a control) and `endo_canal` (one canal of a root canal
  procedure). Value lists are our own keys with labels that follow the published AAE terminology; no licensed code
  content. The database checks every value list, which results go with which test, and that an EPT reading only goes
  with a responsive EPT and a lingering time only with a thermal test.
- **Who records what**: tests need `clinical_finding.record` (dentists, hygienists, assistants); the diagnosis needs
  `diagnosis.create` (dentists only); canals need `procedure.complete` (dentists, hygienists, assistants, as for other
  procedure annotation). Editing and voiding go through the generic entry routes (`entries/endo-diagnoses|endo-tests|endo-canals`)
  with the same checks as recording; the kind of test and the canal name are fixed once recorded (void and re-record).
- **Canals belong to a root canal procedure** in the same visit, on the same tooth (checked by the API and by a
  database trigger), and each canal name appears once per procedure. Working length is 5-35 mm in 0.5 mm steps,
  master apical file an ISO size, taper 0.02-0.12.
- **Completion rule.** When canals are recorded, marking the root canal performed requires every canal to be obturated,
  calcified or not located, with a working length and obturation recorded for each obturated canal; the canal records
  then stand in for the free-text "canals treated" and "obturation" fields. Once the root canal is performed (or
  signed), a canal can't be added or changed back to unfinished. Root canals charted without canal records still
  complete on the free-text fields.
- **In person only.** A telehealth visit can't record endo diagnoses, tests or canals.
- **Colorblind-safe**: abnormal test results carry ⚠ with bold, underlined text (and "Abnormal" for screen readers);
  control-tooth rows are italic and labelled "(control)"; canal status is written out with a mark (● obturated,
  ✕ calcified, ○ unfinished in bold); the working-length diagram labels every bar with its canal and length and
  uses solid, hatched and outline fills for status.
- The visit ledger and the sign screen show one line per tooth with endo entries, so the dentist sees them as part of
  what gets signed.
- The seed gives Jordan's 2021 root canal on #19 its workup (tests on #19 with #20 as control, diagnosis) and three
  obturated canals with working lengths.

## Implant records

The **Implants** tab on a patient record shows one card per implant: what was placed, how, and every step since.

- **An implant is a device, not a procedure.** The placement record (`implant`) is a chart entry of the visit where
  it was placed. It holds the device's identity (manufacturer, product family, catalog number, lot and/or serial,
  which the database requires at least one of), its size (diameter 2.5-7 mm, length 5-20 mm in 0.5 mm steps),
  surface, platform, insertion torque, ISQ, bone quality, timing, healing protocol, and the graft and membrane with
  their lots. It is recorded against an implant placement procedure at the same site in the same visit.
- **The site is an implant tooth instance.** Placement creates (or reuses) a `tooth_instance` of kind `implant` at
  the dental position, so findings and probing can later sit on the implant rather than the extracted tooth. One
  device at a site at a time: a second placement there is refused until the first one's removal is recorded.
- **Later steps are events** (`implant_event`) in the visit where they happen: second-stage uncovery, healing
  abutment, abutment, restoration (type and screw or cement retention), stability check (ISQ), follow-up (bone loss),
  complication (named from a fixed list) and removal (with a reason). The database checks which details go with
  which step. Removal ends the device; nothing more can be recorded on it.
- **`device_id` is the device's lasting identity**: the id of its first placement record, set by the database and
  carried by every amended version and every event, so a device's history survives amendments. The card shows the
  stage reached (healing, uncovered, abutment placed, restored, removed) and the ISQ trend.
- **Completion rule.** A device record stands in for the free-text manufacturer, lot, diameter and length fields
  when the implant placement procedure is marked performed.
- **Who records**: `procedure.complete` (dentists, hygienists, assistants) for placements and events; edits and voids
  go through the generic entry routes (`entries/implants|implant-events`) with the same checks; the kind of step is
  fixed once recorded. In person only.
- **Colorblind-safe**: the stage is written out with a mark (◷ healing, ◎ uncovered, ▣ abutment, ✓ restored,
  ✕ removed) and a distinct border; complications and removals in the history carry ⚠ with a wavy underline; a
  removed implant's card has a dashed border and its title struck through.
- The odontogram now draws a placed implant at a site where the tooth was extracted, instead of the extraction X.
- The seed gives Hector Alvarez an immediate implant at #30 (2024, after a sectioned extraction, with graft and
  membrane), uncovery and a screw-retained crown four months later, and a 2025 follow-up.

## Oral surgery

The **Surgery** tab on a patient record has a card per extraction and per biopsy specimen.

- **Surgical record of an extraction** (`surgical_detail`), one per extraction procedure, recorded in its visit on the
  same tooth: impaction (with Winter angulation and Pell and Gregory class), flap design, bone removal, sectioning,
  whether a root tip was left (needs a note), socket graft and membrane with lots, sinus communication (upper teeth
  only, and a confirmed one needs how it was managed), hemostasis and how, sutures (material, size, count),
  complications from a fixed list, and verbal or written post-op instructions. The approach follows from what was
  done: a flap, bone removal or sectioning makes it surgical, and a bony impaction can't be simple. The database
  checks the same rules.
- **Completion rule.** A surgical record stands in for the extraction's free-text technique, hemostasis, sutures and
  post-op fields; if it says hemostasis was not achieved, the extraction can't be marked performed.
- **Biopsies** are a new procedure (`biopsy`, mouth scope, invented code SYN-511). Each specimen (`biopsy_specimen`)
  records site, technique, size, appearance, clinical impression, fixative, lab and container label. A biopsy can't
  be marked performed until a specimen is recorded. `specimen_id` is the specimen's lasting identity across amendments.
- **Pathology results** (`biopsy_result`) are recorded by a dentist (`diagnosis.create`) in the visit where they are
  reviewed, which may be a telehealth visit: date received (not before collection, not in the future), accession
  number, category (benign, premalignant, malignant, non-diagnostic), the pathologist's diagnosis as reported, a
  follow-up plan (required unless benign) and whether the patient was told. One result per specimen; corrections
  are edits or amendments.
- **Waiting list.** `GET /biopsies/awaiting-results` lists specimens with no result at the caller's locations
  (clinical staff only; break-glass patients are left out). The Patients page shows it when non-empty, and a result
  more than 14 days out is marked overdue.
- **Who records**: `procedure.complete` for surgical records and specimens, `diagnosis.create` for results. Surgery
  and specimens are in person only.
- **Colorblind-safe**: specimen status is written out with a mark and border (◷ awaiting, dashed; ⚠ overdue, double;
  ✓ benign; ▲ needs follow-up, dotted); complications, sinus communication, a retained root tip and failed hemostasis
  are listed with ⚠ and a wavy underline.
- The seed adds Hector's #30 surgical record, Mei Tanaka's impacted #1 (2025), Samuel Okafor's leukoplakia biopsy
  with a dysplasia result, and two biopsies still waiting (one overdue).

## Lab cases

A **lab case** is a work order to a dental laboratory: a crown, bridge, veneer, implant crown, denture, night guard
and so on. It is not a chart entry; it is an order with a status, tracked until the work is seated. The charted
procedure (the crown prep, the seat) is still recorded and signed in its visit as usual.

- **Labs** (`dental_lab`) are kept on the **Lab cases** page: name, phone, email, address, active.
- **The prescription (Rx)** (`lab_case`, `lab_case_item`): lab, prescribing dentist, impression (digital scan with a
  scan ID, or conventional), what is enclosed, instructions, requested due date, and 1 to 16 units. A unit is on a
  tooth (crown, bridge retainer, pontic, inlay/onlay, veneer, implant crown) or an arch (complete or partial denture,
  night guard), with material and shade. Units point at the patient's tooth instance; the tooth number is stored for
  display only. An implant crown needs an implant on file at that site. Each tooth once per case; a digital scan has
  no physical impression.
- **Chart images** (`lab_case_attachment`): x-rays and photos already in the patient's chart can be attached to a
  draft, in order. Only the case patient's own images that aren't marked entered in error; the database checks the
  same. They are fixed with the prescription when it's sent: the frozen Rx lists each by image id and its SHA-256, so
  the record shows exactly which files went with the case. The printed Rx lists them (type, date, teeth); the screen
  also shows thumbnails. An image marked entered in error after sending stays listed with a ⚠ note. Nothing is
  transmitted to the lab from the app.
- **States**: Draft → At the lab (SENT) → Back from lab (RECEIVED) → Seated, with Cancelled from any open state. From
  Back from lab a dentist can send the case back for an adjustment, a remake or the next stage (try-in), which starts
  a new round with its own due date and instructions.
- **Who does what** (privileges, never job titles): `lab_case.manage` (front desk, assistants, practice manager,
  dentists) keeps labs, drafts and edits cases, records them coming back, seating and cancelling, and links the seat
  appointment. `lab_case.authorize` (dentists) sends: only the case's prescribing dentist, with a fresh step-up code
  and an active license in the location's state (`lab_case.authorize` is a credentialed and step-up privilege). The
  prescribing dentist chosen on a draft must hold `lab_case.authorize`.
- **Frozen once sent.** Sending stores the prescription as the lab receives it (`lab_case_event.rx_snapshot`, patient
  by id only) with its SHA-256, and the database refuses any later change to the Rx, its units, or who authorized it
  and when. A send-back keeps its own snapshot (Rx plus the new instructions). History (`lab_case_event`) is
  append-only and cases are never deleted. Every read and change is audited.
- **Tracking.** `GET /lab-cases?view=open|overdue|received|all` lists cases at the caller's locations with flags:
  overdue (at the lab past its due date), due on or after the seat appointment, and still at the lab on or after
  the seat appointment's day. The patient's **Lab cases** tab shows the same flags as callouts.
- **Printed Rx.** "Print prescription" prints only the Rx sheet. On paper the patient is first name, last initial and
  chart number: enough for the lab to match the case.
- **Colorblind-safe**: each status pairs its words with its own mark and border (✎ Draft, dashed; ➜ At the lab,
  dotted; ⬇ Back from lab, heavy with a fill; ✓ Seated; ✕ Cancelled, struck through), and flags carry ⚠ or ◷ with
  their words and a double or dashed border. Rows that need a look also get a bar at the left edge.
- The seed adds two labs; Jordan's 2021 crown #19 (seated, linked to the charted crown); Hector's crown #14, back
  from the lab for today's crown appointment; Samuel's three-unit bridge #28-30, overdue from the lab; and a draft
  upper night guard for Priya waiting for Dr. Jones to authorize. The older cases are moved back in time by the seed
  (which disables the history guard for that one step); everything else goes through the lab service.

## Diagnostic imaging

The **Imaging** tab on a patient record lists the patient's DICOM studies with a viewer and the dentist's read of
each. Plain x-rays and photos (PNG, JPEG, SVG) stay where they were, on the Chart tab.

- **A study is one DICOM series** (`imaging_study`, a chart entry in its visit): a CBCT volume or a 2D DICOM
  radiograph (panoramic, cephalometric, intraoral). Upload is `POST /encounters/:id/imaging-studies` with the files of
  one series (base64, up to 600 files, a 200 MB body limit on this route only). `media.upload` records it.
- **The original files are kept unaltered**, each encrypted in the media store under an opaque key with its SHA-256;
  the study row lists the keys and digests. A **viewing volume** is made from them (slices sorted by patient position,
  rescale slope and intercept applied, MONOCHROME1 inverted, stored as int16) and kept the same way with its own
  digest. The database refuses any change to a study's files or digests, on an edit or an amended copy.
- **The DICOM reader** (`packages/shared/src/dicom.ts`) is ours and small: Part 10 files, implicit or explicit VR
  little endian, 8- or 16-bit greyscale. Compressed transfer syntaxes (JPEG, JPEG 2000, RLE), big endian, colour, and
  images over 1024 × 1024 or 1024 slices are refused with a clear error, not guessed at. Nothing it reads is logged.
  The DICOM modality must fit the chosen kind (CT for a CBCT; PX, DX or CR for a panoramic, and so on), a CBCT must
  have more than one slice and a 2D study exactly one, and the same series can't be filed twice.
- **Patient identity.** The header's patient ID is compared with the chart number, or else its family name and birth
  date with the chart. If they don't match, or the files carry no identity, the upload is refused (409) naming
  which fields differ, never their values, until the uploader says why it is still this patient. The study keeps the
  result (`matched`, `confirmed_mismatch`, `confirmed_unidentified`) and the reason; the header identity itself stays
  only in the original files.
- **Header facts** kept on the study: DICOM modality, study and series UIDs, device, acquisition time (UTC), kV, mA,
  exposure, size, voxel size, the scanner's window, the region (both arches, maxilla, mandible, localized, TMJ, sinus,
  other) and the teeth (as tooth instances; a localized scan needs teeth) and who took it.
- **Viewing** is through `GET /imaging-studies/:id/volume-url`: a 60-second signed link with no PHI in it, audited as
  `imaging_study.view` when issued (any `patient.read` role, with patient access). The browser decodes the volume and
  keeps it in memory only while the viewer is open.
- **The viewer** shows axial, coronal and sagittal slices through a crosshair (click a view to move it), slice
  sliders, window presets (as scanned, bone, soft tissue, implants and metal) with level and width, and straight-line
  measurements in millimetres from the voxel size. Patient right is on the left of the axial and coronal views and
  superior is up. A 2D study shows its one image.
- **The read** (`imaging_read`, a chart entry) is recorded by a dentist (`diagnosis.create`) in the visit where they
  review the scan: findings, impression, incidental findings with a required follow-up or referral, a note and up to
  20 measurements. A CBCT read must attest the **whole volume** was reviewed, not only the area of interest (API
  and database). Measurements are stored by voxel coordinates and the server works out the millimetres again; a
  figure sent by the browser is ignored. One live read per study; changes are edits, or amendments once signed.
  Measurements are a jsonb array checked by Zod and bounded by the database; they are part of the signed payload.
- **Unread worklist.** `GET /imaging/unread` lists studies with no read at the caller's locations (clinical staff
  only; break-glass patients are left out). The Patients page shows it when non-empty; a study waiting more than 7
  days is marked overdue.
- **Who does what**: `media.upload` uploads and voids studies and edits their region, description and note;
  `diagnosis.create` records reads; `patient.read` views. Studies and reads are signed with the visit.
- **Colorblind-safe**: read status is written out with a mark and border (◷ not read yet, dashed; ⚠ read overdue,
  double; ✓ read), an identity that didn't match is marked ⚠ with a wavy underline, and the viewer's crosshair is
  dashed with measurement lines labelled in text.
- The seed adds two synthetic CBCTs drawn by `apps/api/src/imaging/phantom.ts` (a lower jaw with teeth, the
  inferior alveolar canals and, for Hector, the #30 implant and crown): Hector Alvarez's 2025 implant check, read with
  two measurements, and Samuel Okafor's scan from nine days ago, not yet read (overdue). Their DICOM headers carry
  the chart's own identity, and their descriptions say SIMULATED.

## Controlled-substance prescribing (EPCS)

Controlled substances (DEA Schedules II to V) are prescribed only through the e-prescribing partner's certified EPCS
flow (MASTER_SPEC §15.4, 21 CFR 1311). We keep what the practice is responsible for and check it first; the partner
does identity proofing, holds the two-factor credential, makes the signature and keeps the DEA signing audit.

- **The schedule comes from the partner's drug database** (`lookupDrug`) when a draft is saved, never from the
  browser; the `controlledSchedule` field the client used to send is gone. The draft stores the schedule and class
  (opioid, benzodiazepine, other).
- **Rules on the content**, in `packages/shared/src/epcs.ts` and again in the database: no refills on Schedule II, at
  most five on III to V (federal), and at most a 7-day supply for opioids (a practice default). A controlled
  prescription is never drafted from a telehealth visit (`controlled_telehealth_prescribing_disabled`).
- **DEA registrations** are `credential` rows (`dea_registration`): number checked for format and check digit,
  encrypted (`identifier_enc`, bound to the holder) and shown as `•••••••563`; state, schedules and expiry are
  required. They count only after another administrator records a verification (the existing step, with step-up).
- **Enrollment** (`epcs_enrollment`): an access manager enrolls a prescriber or an access manager with the partner;
  identity proofing and the signing token happen on the partner's pages, and we copy their status (`Refresh from
  partner`). Nothing about it is set by hand.
- **Two-person logical access** (`epcs_access_grant`, 21 CFR 1311.125): someone with the new `epcs.manage_access`
  privilege (practice managers by default) proposes access for a prescriber, under one verified DEA registration, for
  some of its schedules, after checking the prescriber has `prescription.sign_controlled` and a verified license in
  that state. A **different** access manager, never the prescriber, approves it in the partner's two-factor window;
  the grant turns active only when the partner reports that authentication. At least one of the two must be a DEA
  registrant with a signing token. Either access manager can revoke at once (no step-up, so taking access away is
  never slowed down), and a prescriber can give up their own. Rows only move forward (pending → active or rejected,
  active → revoked); the database refuses anything else, a deletion, or an approver who is the proposer or prescriber.
- **Signing.** `POST /prescriptions/:id/epcs/start` needs `prescription.sign_controlled` and our step-up (in
  addition to the partner's two factors, never instead of them), then checks, every time: a verified license in the
  location's state; an active, unexpired DEA registration there covering the schedule; identity proofed with a bound
  token; active access for that registration and schedule; the schedule unchanged at the partner; the content rules;
  the PDMP attestation for opioids and benzodiazepines; every screening alert acknowledged; an EPCS-capable pharmacy;
  an NPI. It then locks the content, hashes it (including the schedule, license and DEA registration) and moves it to
  `EPCS_PENDING`, and opens the partner's signing window (`epcs_session`) with the full prescription and the hash.
  The prescription never enters our transmission queue.
- **The partner's report** (`kind: "epcs_session"` on the signed webhook, or the sandbox callback) is accepted only if
  the person who authenticated is the prescriber who opened it, with at least two distinct factors, before the window
  expired, over the same content hash, and the hash recomputed from the stored row still matches. Then the
  prescription is `SENT` with `signed_at` from the partner and events `SIGNED` and `SENT`; the pharmacy's
  acknowledgement makes it `ACCEPTED` as before. Anything else marks the session `failed` and the prescription
  `ERROR`, with a note to call the pharmacy, and audits an error. A declined or timed-out window leaves it locked: the
  same prescriber can open a new window (authority checked again) or anyone who prepares prescriptions can cancel it,
  which closes the window at the partner.
- **Evidence.** A finished `epcs_session` keeps the factors, the partner's signature reference and the content hash,
  and can't change; `signed_at` is filled once. Audit events: `credential.create`, `epcs.enroll`,
  `epcs.enrollment_sync`, `epcs.access_propose`, `epcs.access_approve_start`, `epcs.access_approve`,
  `epcs.access_reject`, `epcs.access_revoke`, `prescription.epcs_start`, `prescription.epcs_reopen`,
  `epcs.session_declined`/`_expired`, `prescription.epcs_sign` (success or error), and denials with their reason.
- **Screens.** The **EPCS** page (for `epcs.manage_access`) lists prescribers and access managers with their DEA
  registrations, enrollment and access, and does every step above. On **Prescriptions**, controlled favorites are
  marked, a controlled card shows its `C-II` mark (text with a double border), lists only EPCS-capable pharmacies,
  asks for the PDMP check, explains what is missing when the prescriber can't sign yet, and opens the partner window.
  In the sandbox the window is a dialog marked SANDBOX; in production it is the partner's own embedded page and our
  app never sees the PIN or token code.
- **For legal and clinical review before use with real patients:** the 7-day opioid limit and the PDMP attestation
  are practice defaults, not each state's rule; state controlled-substance registrations are not modelled; DEA "N"
  (non-narcotic) schedules are folded into the numbered ones.
- The seed gives Amy Jones and Marcus Lee synthetic, format-valid DEA numbers (not real registrations), enrolls them
  and Pat Morgan with the sandbox, approves Amy's access (proposed by Amy, approved by Pat) and leaves Marcus's waiting.
  Mei Tanaka has a hydrocodone prescription Amy signed in the window; Priya Natarajan has a triazolam draft.

## Not built yet

- Portal pieces still missing: online payment (needs a payment processor choice), referral and document downloads,
  SMS sign-in codes.
  Intake questionnaires beyond the health-history update request. Spanish translations of portal text.
- Revenue cycle gaps: a real clearinghouse adapter (needs a contract and BAA), claim attachments (x-rays,
  narratives), predeterminations, coordination of benefits on secondary claims (secondary estimates ignore the
  primary payment), claim status inquiry (276/277), statements by mail, payment plans, collections.
- Telehealth gaps: LiveKit audio egress into the encrypted media store, transcription, the replay buffer, referral
  records, telehealth billing codes, real state rules (each needs legal review), an approved triage protocol.
- Imaging gaps: compressed DICOM (JPEG, JPEG 2000, RLE; needs a decoder library), uploads larger than the
  200 MB body limit (needs direct, chunked upload to object storage), downloading or sending the original files
  (export to a specialist), DICOMweb or a PACS connection (each is a new vendor needing a BAA and an adapter),
  oblique and panoramic reconstructions, 3D rendering, nerve tracing and implant planning, annotations other than
  straight lines, a radiology referral when the dentist wants a specialist read of a CBCT, and AI assistance (Phase 8).
  Measurements assume an axis-aligned volume (no gantry tilt or oblique orientation).
  Lab case gaps: electronic case submission and status updates from a lab portal (each lab is a new vendor that
  needs a BAA and an adapter), sending scan files or the attached images to the lab electronically, lab invoices and remake cost tracking, linking units
  to plan items in the form (the API accepts `plannedProcedureId`), and per-unit status for multi-unit cases. Flags
  compare the seat appointment's UTC date, so a late-evening appointment can be a day off.
  Oral surgery gaps: sedation and general anesthesia records (monitoring, vitals, recovery), consent linked to the
  procedure, an electronic pathology requisition and results feed from a lab (needs a lab partner and BAA), a
  suture-removal reminder for non-resorbable sutures, other surgical procedures (alveoloplasty, frenectomy, incision
  and drainage), and showing a biopsy site on a soft-tissue diagram.
  Implant gaps: UDI barcode scanning and a device-recall search across patients, probing on implant sites in the
  perio chart (the implant tooth instances now exist), drawing the implant restoration on the odontogram from
  implant events, and implant-supported bridges spanning several sites.
  Endo gaps: radiographic working-length films linked to a canal, retreatment and apicoectomy detail, a referral
  letter to an endodontist, and recording on primary teeth from the Endo tab (the API accepts them; the tooth list
  shows permanent teeth only).
  Perio gaps: probing around implants (needs implant tooth instances), voice entry (needs a speech vendor with a
  BAA), a perio maintenance recall interval, and printing the chart for the patient or a referral.
- EPCS gaps: refill requests, CancelRx and change requests from pharmacies, and medication history from the partner
  (next part of Phase 7); the real DoseSpot EPCS adapter (needs the contract, BAA and sandbox credentials); reading
  the state PDMP through an integration rather than an attestation; state-specific limits; partner webhooks for a
  revoked token or failed identity check (status is pulled today); the partner's DEA-required reports; controlled
  prescribing by telehealth (stays off).
- AI assistance (Phase 8).
- Production adapters: Cognito, KMS, S3, SQS, DoseSpot. Terraform is a skeleton and has never been applied.
- Backup/restore drills and monitoring (MVP item 12 covers tenant isolation, access control and PHI-safe logging
  in tests; backup/restore needs the AWS environment).
- Practice-level setup beyond staff: adding locations, operatories and appointment types still happens in the
  seed script or SQL. Operatory hours and holidays (provider time off covers closures for now).
- A QR code on the first sign-in page (it shows the key and an `otpauth://` link instead).
- Primary teeth on the odontogram (the anatomy model and API support them; the drawing shows permanent teeth).

## Known quirks of the seed

- Seeded historical visits show today's date as their signing time, because signing always stamps the real clock.
  Their visit dates (2019, 2021, 2023) are correct.
- X-rays are generated SVGs labelled SIMULATED · NOT DIAGNOSTIC.
