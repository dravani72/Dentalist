# Dental Practice Management Platform — AI Development Handoff

**Version:** 1.0.0  
**Audience:** Product leads, software architects, security/compliance leads, UX designers, clinical dental SMEs, QA engineers, AI coding agents  
**Status:** Architecture and product-context baseline; not legal advice or a substitute for jurisdiction-specific counsel.

## Product thesis

Build a dental practice operating system in which **verified clinical truth is the source of record**. Scheduling, prescriptions, claims, communications, analytics, and automation must derive from authenticated clinical events rather than overwrite them.

Canonical lifecycle:

`ANATOMY → OBSERVATION → DIAGNOSIS → RECOMMENDATION → TREATMENT PLAN → PATIENT DECISION → PROCEDURE → VERIFICATION → SIGNED RECORD → CLAIM → PAYMENT → LONGITUDINAL OUTCOME`

## Non-negotiable principles

1. **No silent clinical history rewrite.** Signed records are immutable; corrections are amendments with provenance.
2. **Role is not authority.** Clinical privileges are explicit and scoped by provider, location, credential, and jurisdiction.
3. **Billing codes are projections of clinical data.** CDT/claim structures must never be the primary clinical model.
4. **Prescribing is its own regulated subsystem.** EPCS must use a compliant partner/application boundary unless the product is independently audited/certified for DEA requirements.
5. **HIPAA is an operating model, not a checkbox.** Security, privacy, BAAs, incident response, access controls, and auditability are architectural concerns.
6. **AI assists; licensed humans decide.** AI may draft, transcribe, structure, flag, or suggest; it must not autonomously diagnose, attest completed treatment, sign records, or prescribe.
7. **Every clinically significant fact carries provenance.** Who, what, when, source, status, verification, and version.
8. **Tenant isolation is enforced server-side and at the data layer.** Never rely on UI filtering.

## Package contents

- `MASTER_SPEC.md` — canonical product and architecture specification.
- `AGENTS.md` — instructions for AI coding agents and human reviewers.
- `docs/01_product_charter.md` — scope, goals, non-goals, success criteria.
- `docs/02_roles_permissions.md` — actors, privilege model, authorization matrix.
- `docs/03_clinical_domain_model.md` — clinical ontology and longitudinal event model.
- `docs/04_odontogram_annotation_gui.md` — detailed odontogram/procedure annotation UX and data capture.
- `docs/05_scheduling.md` — resource-aware scheduling and recall workflows.
- `docs/06_encounter_attestation_records.md` — encounter lifecycle, verification, signatures, amendments.
- `docs/07_erx_epcs.md` — medications, pharmacy selection, eRx, EPCS boundary.
- `docs/08_hipaa_security_privacy.md` — HIPAA-aligned security/privacy architecture and controls.
- `docs/09_interop_billing_imaging.md` — FHIR/HL7, SNODENT/SNOMED, CDT, X12, DICOM, clearinghouse and imaging integration.
- `docs/10_ux_information_architecture.md` — major screens, navigation, clinical interaction patterns.
- `docs/11_system_architecture.md` — services, data stores, trust boundaries, deployment and observability.
- `docs/12_api_events.md` — API conventions and event contracts.
- `docs/13_ai_features_guardrails.md` — allowed AI use cases, review gates, PHI handling.
- `docs/14_test_acceptance.md` — testing strategy and acceptance criteria.
- `docs/15_roadmap_backlog.md` — phased implementation plan.
- `docs/16_risk_register.md` — product, clinical, regulatory, technical and security risks.
- `docs/17_regulatory_matrix.md` — federal/state domains and implementation obligations.
- `docs/18_regulatory_sources.md` — authoritative source references verified for this handoff.
- `schemas/database.sql` — starter PostgreSQL schema.
- `schemas/openapi.yaml` — starter API surface.
- `schemas/core_entities.schema.json` — machine-readable core object shape.
- `schemas/permissions.csv` — privilege catalog starter.
- `diagrams/*.mmd` — Mermaid diagrams for system context, trust boundaries, state machine and ER model.
- `planning/epics.csv` — initial backlog/epic plan.
- `planning/prompt_pack.md` — prompts for AI-assisted implementation and review.
- `planning/definition_of_done.md` — release gates.

## Recommended use with an AI-assisted dev team

1. Load `AGENTS.md`, `README.md`, and `MASTER_SPEC.md` into the agent context.
2. Give agents **one bounded epic at a time** from `planning/epics.csv`.
3. Require schema/API changes to update the corresponding files in `schemas/`.
4. Require clinical workflow changes to update acceptance tests and threat/privacy implications.
5. Require a licensed dental SME to review any change that affects clinical semantics.
6. Require security/compliance review for any new PHI flow, subprocessor, analytics path, or external integration.
7. Never allow an agent to invent legal or prescribing requirements. Use `docs/18_regulatory_sources.md` as the source baseline and re-verify time-sensitive rules before release.

## Suggested first implementation target

A narrowly scoped MVP should deliver:

- multi-tenant organization/location/provider model;
- patient master record + medical history + allergies/medications;
- resource-aware scheduling;
- encounter creation;
- permanent/primary dentition odontogram;
- structured findings, diagnoses, treatment plans, completed procedures;
- provider verification + signed encounter + amendments;
- immutable audit trail;
- patient-selected pharmacy storage;
- non-controlled eRx through an external prescribing partner;
- basic patient portal;
- security foundation suitable for a HIPAA business associate.

Do **not** start with autonomous AI diagnosis, direct pharmacy-network construction, in-house EPCS certification, claims adjudication, or every dental specialty at once.
