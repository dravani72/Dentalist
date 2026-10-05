# MASTER SPEC — Dental Practice Management and Clinical Record Platform

## 1. Product definition

The product is a cloud-based dental practice operating system combining:

- patient and clinical record management;
- resource-aware scheduling;
- anatomically detailed odontogram and procedure annotation;
- medical/dental history and medication reconciliation;
- diagnosis and treatment planning;
- practitioner verification, attestation, signatures and amendments;
- prescriptions routed to a patient-selected pharmacy;
- patient portal and secure communications;
- insurance/claims integration;
- imaging/lab/referral integration;
- HIPAA-aligned administrative, technical and operational safeguards;
- a constrained AI assistance layer.

The platform should be modeled as a **temporal, anatomically aware clinical record system** whose administrative functions derive from verified clinical events.

## 2. Canonical clinical chain

```text
ANATOMY
  ↓
OBSERVATION
  ↓
DIAGNOSIS
  ↓
RECOMMENDATION
  ↓
TREATMENT PLAN
  ↓
PATIENT DECISION
  ↓
SCHEDULED WORK
  ↓
PROCEDURE OCCURRENCE
  ↓
PRACTITIONER VERIFICATION
  ↓
SIGNED ENCOUNTER
  ↓
CLAIM
  ↓
PAYMENT / REMITTANCE
  ↓
LONGITUDINAL OUTCOME
```

Each stage is distinct. A future/planned procedure must never be represented as completed simply because an appointment or claim line exists.

## 3. Actors and authority

Primary actors:

- Patient
- Parent/guardian/authorized representative
- Front desk
- Dental assistant
- Registered dental hygienist
- Dentist
- Dental specialist
- Treatment coordinator
- Billing/RCM user
- Practice manager
- Compliance/security officer
- DSO/group administrator
- Laboratory/referral partner
- System administrator/support engineer

Authorization must use **role + privilege + scope + credential + context**.

Representative privileges:

```text
patient.read
patient.write_demographics
medical_history.record
clinical_finding.record
clinical_finding.verify
diagnosis.create
treatment_plan.create
procedure.start
procedure.complete
procedure.verify
encounter.sign
encounter.amend
prescription.prepare
prescription.sign_noncontrolled
prescription.sign_controlled
claim.prepare
claim.submit
record.export
audit.read
security.break_glass
```

Scopes can include organization, region, location, patient relationship, treating-provider relationship, specialty, and active credential status.

## 4. Organization and tenancy

Hierarchy:

```text
Group / DSO
└── Organization / Practice
    ├── Location
    │   ├── Operatories
    │   ├── Providers
    │   ├── Staff
    │   └── Equipment/resources
    └── Shared services
```

Every persisted business/clinical entity must be associated with an owning tenant. Access decisions are made server-side. DSO administrators do not automatically receive unrestricted access to all clinical records; cross-location access must be explicitly granted and auditable.

## 5. Patient master record

The patient aggregate includes:

- immutable internal patient UUID;
- legal name, preferred name, former names;
- date of birth;
- addresses and contact methods;
- communication preferences;
- preferred language and accessibility requirements;
- emergency contact;
- guardian/responsible party/guarantor relationships;
- insurance policies;
- consents and directives;
- preferred pharmacy/pharmacies;
- medical history;
- dental history;
- allergies and adverse reactions;
- current and historical medications;
- problem list/conditions;
- vitals;
- referral sources;
- documents and external records;
- longitudinal clinical timeline.

SSN should not be used as the primary identifier.

Every mutable clinical fact should support provenance fields such as:

```text
source_type
source_id
recorded_by
recorded_at
verified_by
verified_at
status
valid_from
valid_to
version
supersedes_id
```

## 6. Medical history

Use structured fields, not only PDF forms. Capture, where clinically relevant:

- allergies, reaction type and severity;
- active medications;
- past adverse drug reactions;
- anticoagulants/antiplatelets;
- diabetes;
- hypertension/cardiovascular disease;
- infective endocarditis history;
- prosthetic joints and premedication considerations;
- immunosuppression;
- renal/hepatic disease;
- bleeding disorders;
- pregnancy status when relevant;
- osteoporosis/antiresorptive therapy;
- chemotherapy/radiation history;
- respiratory disease;
- seizure disorders;
- implanted devices;
- tobacco/nicotine use;
- alcohol/substance use where clinically relevant;
- surgical history;
- physician contacts/medical clearances.

Each item should show source and last-confirmed date in the clinical UI.

## 7. Scheduling

Scheduling is **resource-aware**, not merely provider-aware.

Appointment resources may include:

- patient;
- treating provider;
- hygiene provider;
- assistant;
- operatory;
- imaging room;
- scanner;
- sedation resource;
- specialty equipment.

Appointment fields:

```text
appointment_id
patient_id
location_id
appointment_type
planned_procedures[]
provider_allocations[]
resource_allocations[]
start_time
end_time
provider_active_minutes
chair_minutes
priority
status
confirmation_state
insurance_readiness
preauthorization_state
consent_requirements
medical_clearance_requirements
prep_instructions
encounter_id
```

Support:

- drag/drop and keyboard scheduling;
- multiple provider calendars;
- operatory/resource overlays;
- hygiene columns;
- recurring ortho visits;
- emergency slots;
- waitlist and short-notice list;
- recall and reactivation;
- online booking for constrained appointment types;
- cancellation/no-show reasons;
- conflicts and dependency rules;
- procedure-based duration templates;
- clinician-time versus chair-time modeling.

## 8. Clinical encounter

Encounter lifecycle:

```text
DRAFT → IN_PROGRESS → READY_FOR_REVIEW → VERIFIED → SIGNED
                                     ↘ AMENDMENT_REQUIRED
```

An encounter may contain:

- chief complaint;
- history of present illness;
- medical history confirmation;
- vitals;
- examination findings;
- odontogram updates;
- periodontal measurements;
- imaging/media references;
- diagnoses;
- treatment plan discussions;
- procedures performed;
- medications administered;
- prescriptions;
- consent references;
- post-op instructions;
- follow-up/recall plan;
- attestation/signature.

## 9. Dental anatomy model

Support:

- permanent dentition;
- primary dentition;
- mixed dentition;
- supernumerary teeth;
- retained primary teeth;
- congenitally missing teeth;
- unerupted/partially erupted/impacted teeth;
- edentulous regions;
- implants;
- pontics and prosthetic units.

Do not use displayed tooth number as a primary key.

Model an anatomical slot and a patient-specific tooth instance separately:

```text
DentalPosition
- universal_designation
- fdi_designation
- palmer_designation
- arch
- quadrant
- anatomical_region

ToothInstance
- patient_id
- dental_position_id
- dentition
- status
- erupted_state
- created_at
- retired_at
```

## 10. Odontogram and procedure annotation GUI

The core clinical workspace should contain three synchronized representations:

1. **Graphical anatomy** — interactive teeth, surfaces, implants and prosthetic units.
2. **Clinical timeline** — historical events by tooth/region/procedure.
3. **Structured inspector** — findings, diagnosis, plan, materials, technique, verification and media.

### 10.1 Surface selection

Support common dental surfaces and combinations:

- Mesial
- Distal
- Buccal
- Facial
- Lingual
- Occlusal
- Incisal

The UI should permit direct visual selection and automatic generation of combinations such as MO, DO, MOD, MODBL.

### 10.2 Annotation layers

Separate visual layers for:

**Anatomic state**
- present
- missing
- unerupted
- partially erupted
- impacted
- retained primary
- supernumerary
- congenitally absent

**Existing treatment**
- composite
- amalgam
- crown
- veneer
- inlay/onlay
- sealant
- bridge
- implant
- post/core
- endodontic therapy
- removable prosthesis
- orthodontic appliance

**Finding/pathology**
- caries
- recurrent caries
- fracture
- craze line
- abrasion
- erosion
- abfraction
- attrition/wear
- failed restoration
- open/defective margin
- open contact/food trap
- periapical lesion
- suspicious oral lesion
- sensitivity/pain findings

**Planned treatment**
- proposed but not accepted
- patient accepted
- scheduled

**Clinical certainty**
- suspected
- probable
- confirmed
- historical
- resolved

### 10.3 Structured procedure annotation

A procedure occurrence can capture:

```text
anatomic_target
surfaces
preoperative_findings
preoperative_diagnoses
procedure_type
procedure_code_candidate
technique
isolation
anesthetic_events[]
materials_removed[]
materials_placed[]
shade
liner_base
matrix_system
bonding_system
cement
occlusal_adjustment
contact_verified
occlusion_verified
hemostasis
complications
implant_device_info
lab_case_reference
clinical_media[]
postop_status
postop_instructions
performed_by[]
assisted_by[]
completion_time
verified_by
verification_time
```

### 10.4 Restorative example

```text
Tooth: 30
Surfaces: MOD
Finding: recurrent caries
Existing: amalgam
Procedure: replacement direct restoration
Removed: amalgam
Placed: composite
Shade: A2
Isolation: rubber dam
Matrix: sectional
Contact verified: yes
Occlusion verified: yes
Post-op instructions: delivered
```

### 10.5 Periodontal subsystem

Per tooth, support six sites:

```text
MB B DB / ML L DL
```

Measurements:

- probing depth;
- recession;
- clinical attachment level;
- bleeding on probing;
- suppuration;
- plaque;
- calculus;
- mobility;
- furcation;
- mucogingival defects;
- implant-specific findings.

Input modes should include keyboard, touch/stylus and voice-assisted sequential entry.

### 10.6 Endodontic subsystem

Capture:

- pulpal diagnosis;
- apical/periapical diagnosis;
- symptoms;
- percussion/palpation;
- thermal/EPT findings;
- canal anatomy/names;
- working lengths;
- reference points;
- apex locator values;
- instrumentation system;
- irrigants and medicaments;
- master apical size;
- obturation material/system;
- sealer;
- temporary restoration;
- complication events;
- pre/intra/post-op imaging.

Individual canals should be selectable as clinical objects.

### 10.7 Implant subsystem

An implant is a persistent device object. Store:

- manufacturer;
- product family;
- catalog number;
- lot/serial number as applicable;
- diameter;
- length;
- implant surface/type;
- anatomical site;
- placement date;
- insertion torque;
- ISQ where used;
- graft and membrane products/lots;
- healing protocol;
- abutment and lot;
- abutment torque;
- restoration type;
- screw/cement retention;
- complications and follow-up findings.

### 10.8 Oral surgery subsystem

Support structured details for:

- simple/surgical extraction;
- impaction classification;
- flap;
- bone removal;
- sectioning;
- socket graft;
- membrane;
- biopsy;
- sutures;
- sinus communication;
- hemostasis;
- complications;
- post-op instructions.

### 10.9 Local anesthetic/medication administration

Record as structured medication administration events:

- drug;
- concentration;
- vasoconstrictor;
- amount/cartridge count;
- route/injection type;
- anatomic site;
- time;
- administering clinician;
- response/adverse event.

## 11. Terminology

Separate clinical terminology from billing terminology.

Recommended structure:

```text
Finding → SNODENT/SNOMED concept (where licensed/available)
Diagnosis → SNODENT/SNOMED / ICD mapping as appropriate
Treatment → internal clinical procedure concept
Billing projection → CDT version effective on date of service
```

Terminology services must be versioned. Do not commit proprietary code-set text into the repository unless licensing permits it.

## 12. Procedure lifecycle

Recommended state machine:

```text
OBSERVED
→ DIAGNOSED
→ PROPOSED
→ PLANNED
→ PATIENT_ACCEPTED
→ SCHEDULED
→ IN_PROGRESS
→ PERFORMED
→ CLINICALLY_VERIFIED
→ SIGNED
→ CLAIMED
```

Alternative terminal/branch states:

- declined;
- deferred;
- cancelled;
- partially_completed;
- referred;
- failed;
- replaced;
- voided_with_reason;
- amended.

Transition rules must be enforced server-side.

## 13. Verification, signature and amendment

Staff may draft portions of a clinical record within scope. Clinically consequential completion requires an authorized practitioner.

Example provenance:

```text
Procedure entered:        Jane Smith, CDA 14:31
Clinical details edited:  Amy Jones, DDS 14:44
Procedure completed:      Amy Jones, DDS 14:52
Encounter signed:         Amy Jones, DDS 15:03
```

When signing:

1. Validate required data and privilege.
2. Canonicalize the clinical payload to be attested.
3. Store signer, credential, role and authentication context.
4. Store timestamp and signature metadata.
5. Generate a tamper-evidence digest/hash.
6. Freeze the signed version from in-place mutation.

Corrections create amendments referencing the prior signed version:

```text
signed_version_id
amendment_reason
changed_fields
amended_by
amended_at
new_effective_version_id
```

## 14. Audit trail

Every sensitive operation should answer:

- who;
- did what;
- to which object/patient;
- when;
- from which authenticated session/device context;
- under which authorization;
- what the previous state/value was, where appropriate.

Audit events should be append-only or otherwise tamper-evident. Avoid unnecessary PHI in infrastructure logs.

High-value event categories:

- authentication/session;
- authorization denial;
- patient record access;
- clinical create/update;
- signature/verification;
- amendment;
- prescription preparation/sign/transmission;
- export/download/print;
- break-glass;
- bulk data operation;
- admin configuration;
- integration transmission/result;
- security incident.

## 15. Prescribing

### 15.1 Medication workflow

```text
Patient
→ Medication reconciliation
→ Allergy review
→ Select medication
→ Strength / form / route
→ Dose / frequency / duration
→ Quantity / refills
→ Indication
→ Interaction/contraindication checks
→ Prescriber review
→ Patient-selected pharmacy
→ Sign
→ Transmit
→ Acknowledgement/status
```

Staff may prepare a prescription if policy allows; only an authorized prescriber may sign/transmit according to applicable law and configuration.

### 15.2 Pharmacy preference

Support:

- primary pharmacy;
- alternate pharmacy;
- 24-hour pharmacy;
- mail-order/specialty pharmacy if relevant.

Store durable pharmacy-network identity plus a transmission-time snapshot of name/address/contact information.

### 15.3 Integration boundary

Core product owns:

- patient medication list;
- allergy data;
- prescribing UX;
- prescriber privilege checks;
- prescription intent/record;
- pharmacy preference;
- transmission status history.

External prescribing partner should own, where feasible:

- pharmacy directory/routing;
- NCPDP SCRIPT transport;
- refill requests;
- CancelRx;
- medication history;
- electronic prior authorization;
- EPCS certification and controlled-substance signing infrastructure;
- PDMP integration if offered/appropriate.

### 15.4 Controlled substances / EPCS

Treat as a separate authorization path. Maintain:

```text
provider_credential
state_license
DEA_registration
DEA_schedule_authorization
registration_expiration
state_authority
EPCS_identity_proofing_status
EPCS_credential_status
EPCS_logical_access_status
```

Controlled-substance signing must use the compliant EPCS flow and required authentication factors of the integrated certified/audited application. Do not substitute ordinary application authentication.

## 16. Patient portal

Patient/authorized representative functions:

- appointment view/request/limited self-scheduling;
- intake and medical-history updates;
- consent forms;
- treatment plan and estimate review;
- balances/payments;
- medication list;
- prescription status;
- selected pharmacy management;
- secure messaging;
- referral/document access;
- record-access request;
- amendment request;
- communications preferences.

Delegated access requires explicit relationship/authorization modeling.

## 17. Insurance and revenue cycle

Clinical data generates claim candidates; claims do not define the clinical chart.

Support adapters for:

- 270/271 eligibility;
- 837D dental claim;
- 276/277 claim status;
- 278 authorization/referral where applicable;
- 835 ERA/remittance;
- attachment/document workflows;
- patient estimates and payment allocation.

CDT codes must be versioned by service date and licensed appropriately.

## 18. Imaging and media

Support:

- bitewing;
- periapical;
- panoramic;
- cephalometric;
- CBCT;
- intraoral photography;
- extraoral photography;
- intraoral scans;
- external documents.

Media metadata:

```text
patient_id
encounter_id
study_id
modality
acquisition_time
device
operator
anatomic_targets[]
clinical_interpretation
annotations[]
original_source
integrity_digest
```

Use DICOM where appropriate and preserve original diagnostic media where required.

## 19. Consent

Consents are versioned objects, not mutable PDFs.

Store:

- template ID/version;
- procedure(s)/scope;
- language;
- patient/guardian;
- provider;
- presented timestamp;
- signature timestamp;
- witness if needed;
- revocation timestamp/reason;
- immutable rendered copy/digest.

## 20. HIPAA/privacy/security operating model

A SaaS platform that creates, receives, maintains, or transmits PHI for covered dental practices will typically operate as a business associate. Subcontractors that handle PHI can also fall within the business-associate chain. BAAs and operational safeguards must be part of vendor onboarding.

### 20.1 Administrative safeguards

- documented risk analysis and risk management;
- security responsibility assignments;
- workforce authorization and termination procedures;
- security awareness/training;
- vendor/subprocessor governance;
- incident response;
- contingency/disaster-recovery planning;
- periodic control reviews;
- sanctions and policy enforcement;
- documentation retention.

### 20.2 Technical safeguards

Baseline target:

- TLS for data in transit;
- strong encryption at rest;
- managed keys/secrets with rotation;
- unique user identity;
- MFA for workforce access;
- least privilege;
- granular RBAC/ABAC;
- automatic session timeout/locking;
- tamper-evident audit logs;
- integrity controls for signed clinical data;
- network segmentation;
- hardened deployment configuration;
- endpoint/device/session inventory;
- encrypted backups and restore testing;
- vulnerability scanning;
- penetration testing;
- dependency and container scanning;
- production/non-production isolation;
- no production PHI in developer environments;
- PHI-safe observability and analytics.

### 20.3 Break-glass access

Emergency access requires:

- explicit reason;
- patient(s) affected;
- user/session identity;
- elevated scope and expiry;
- immediate audit event;
- compliance/security notification according to policy;
- post-event review.

No hidden universal superuser should bypass auditing.

### 20.4 Incident/breach readiness

The system must make it possible to determine:

- which records were accessed;
- which data categories were involved;
- which users/sessions were involved;
- whether records were viewed/exported/transmitted;
- time window;
- affected integrations/vendors;
- encryption state;
- containment and remediation actions.

## 21. Interoperability

Preferred standards/adapters:

- FHIR/HL7 where appropriate for patient/clinical exchange;
- SNODENT/SNOMED terminology for dental clinical concepts where licensed/applicable;
- ICD-10-CM mappings where required;
- CDT for dental procedure billing;
- ASC X12 HIPAA transactions for claims/eligibility/remittance;
- NCPDP SCRIPT for e-prescribing through vendor integration;
- DICOM for diagnostic imaging where supported.

Create an internal canonical domain model and map external standards through adapters. Do not make vendor wire formats the core database model.

## 22. AI assistance

Allowed with human review:

- speech-to-text;
- structured extraction from dictated notes;
- chart summarization;
- draft notes;
- coding suggestions;
- contradiction/missing-field flags;
- scheduling duration suggestions;
- record chronology summaries;
- patient message drafting;
- prescription drafting for prescriber review;
- duplicate-record detection suggestions.

Not autonomous:

- diagnosis;
- treatment decision;
- certification of work completed;
- encounter signature;
- record amendment approval;
- prescription signing/transmission;
- EPCS signing;
- final claim coding without configured review where required.

AI outputs must have provenance including model/version, prompt/reference context where policy permits, generated timestamp, reviewer, acceptance/edit history, and final authored clinical content.

## 23. UX principles

Clinical screens should minimize context switching and keep patient-safety alerts visible.

Recommended desktop layout:

```text
┌──────────────────────────────────────────────────────┐
│ PATIENT BANNER: name | DOB | allergies | alerts     │
├────────────┬───────────────────────┬─────────────────┤
│ Navigation │     Odontogram        │ Inspector       │
│ Overview   │     / anatomy         │ Finding         │
│ History    │                       │ Diagnosis       │
│ Perio      │                       │ Procedure       │
│ Images     │                       │ Materials       │
│ Plans      │                       │ Notes           │
│ Rx         │                       │ [VERIFY]        │
├────────────┴───────────────────────┴─────────────────┤
│ Encounter / tooth / procedure timeline              │
└──────────────────────────────────────────────────────┘
```

Input modes:

- mouse;
- keyboard shortcuts;
- touch/stylus;
- voice-assisted entry.

Voice-derived structured data must remain a draft until reviewed.

## 24. Service architecture

Suggested bounded contexts/services:

- Identity & Access
- Organization/Location
- Patient Registry
- Scheduling
- Clinical Encounter
- Dental Anatomy/Odontogram
- Terminology
- Treatment Planning
- Attestation/Signature
- Medication/Prescription
- Imaging/Media
- Consent/Documents
- Patient Portal/Communications
- Revenue Cycle
- Integration Gateway
- Audit/Security Events
- AI Assistance

Start as a modular monolith if the team is small, but preserve these boundaries in code/modules and events. Premature microservices can increase security and operational complexity.

## 25. Data storage

Recommended:

- PostgreSQL for transactional/domain data;
- object storage for media/documents with encryption, checksums and scoped access;
- dedicated immutable/tamper-evident audit storage strategy;
- queue/event bus for reliable integration workflows;
- search index only for derived/query acceleration, not authoritative records;
- analytics warehouse receives minimized/de-identified or explicitly governed data flows.

## 26. API conventions

- REST or typed RPC for transactional app APIs;
- stable UUIDs;
- optimistic concurrency/version fields for mutable drafts;
- idempotency keys for prescriptions, claims, payments and external transmissions;
- request correlation IDs that do not embed PHI;
- explicit authorization context server-side;
- no PHI in URLs/query strings when avoidable;
- pagination and bounded exports;
- signed URLs with short TTL for media downloads;
- webhooks/events signed and replay-protected.

## 27. Testing

Required classes:

- unit tests for domain rules/state machines;
- authorization tests for every PHI endpoint;
- tenant-isolation tests;
- clinical semantic tests;
- migration tests;
- integration contract tests;
- eRx/EPCS vendor sandbox tests;
- claim transaction validation;
- accessibility tests;
- load/concurrency tests for schedule/charting;
- security scanning;
- penetration tests;
- backup/restore and disaster recovery exercises;
- audit integrity tests;
- amendment/signature immutability tests.

## 28. Release gates

No production release if any of the following are unresolved:

- cross-tenant access defect;
- signed-record mutation defect;
- missing audit trail for sensitive action;
- PHI leakage to non-approved telemetry;
- privilege bypass for verification/signature/prescription;
- unencrypted PHI transport/storage path;
- unreviewed new PHI subprocessor;
- EPCS flow deviates from certified/audited partner path;
- restore process is untested;
- critical/high exploitable vulnerability without approved exception.

## 29. Build sequence

### Phase 0 — Compliance/security foundation

- tenant model;
- identity/MFA;
- RBAC/privileges;
- audit events;
- secrets/key management;
- logging/monitoring;
- BAA/subprocessor process;
- CI security gates.

### Phase 1 — Patient + scheduling

- patient master record;
- medical history/allergies/medications;
- providers/locations/operatories;
- resource-aware scheduling;
- recall/waitlist.

### Phase 2 — Clinical core

- encounter;
- odontogram;
- findings;
- diagnoses;
- treatment plan;
- procedure occurrence;
- provider verification;
- signed record/amendment;
- media attachments.

### Phase 3 — Patient interaction

- portal;
- forms/consents;
- secure messaging;
- appointment confirmations.

### Phase 4 — eRx

- pharmacy preferences;
- medication reconciliation;
- non-controlled eRx vendor integration;
- refill/CancelRx if available.

### Phase 5 — Revenue cycle

- terminology versioning;
- eligibility;
- claim generation;
- clearinghouse;
- remittance/payment workflows.

### Phase 6 — Advanced clinical

- perio;
- endo;
- implants;
- oral surgery;
- labs;
- advanced imaging.

### Phase 7 — EPCS and advanced medication workflows

Only through a compliant audited/certified integration path with jurisdictional review.

### Phase 8 — AI assistance

- dictation/structuring;
- summarization;
- chart completeness;
- coding support;
- workflow intelligence.

## 30. MVP acceptance definition

The MVP is clinically meaningful when a practice can:

1. create a patient and verify demographics/medical history;
2. schedule a resource-correct appointment;
3. open an encounter;
4. document tooth/surface-specific findings;
5. create a diagnosis and treatment plan distinct from performed work;
6. record a procedure with detailed structured annotation;
7. have the authorized practitioner verify and sign;
8. amend the signed record without destroying history;
9. retrieve a complete audit history;
10. store/select a patient pharmacy and send a non-controlled prescription through an approved external partner;
11. give the patient controlled portal access to designated records/functions;
12. demonstrate tenant isolation, backup/restore, access controls and PHI-safe logging.

## 31. Product differentiation

The strongest defensible product concept is **clinical truth as structured longitudinal dental data**.

A tooth is not a colored polygon. It is a persistent clinical object with a history of findings, diagnoses, restorations, procedures, failures and outcomes.

Example timeline:

```text
#19
2019  MO composite
2022  distal marginal defect observed
2023  recurrent caries diagnosed
2023  crown recommended
2024  patient deferred
2025  fracture observed
2025  crown performed; lithium disilicate; shade A2; lab XYZ
2026  recall; asymptomatic; margins intact
```

This model supports safer clinical work, better auditability, richer analytics, more defensible records, cleaner claims generation and higher-quality AI assistance.
