# AGENTS.md — Instructions for AI Coding Agents

## Mission

Implement the dental practice platform described in this repository without weakening clinical provenance, authorization, privacy, or auditability.

## Priority order

When requirements conflict, use this order:

1. Patient safety and clinical integrity
2. Legal/regulatory and privacy/security requirements
3. Data provenance and auditability
4. Correct authorization/tenant isolation
5. Interoperability and durable domain modeling
6. Usability and speed of clinical workflow
7. Product convenience
8. Implementation convenience

## Hard prohibitions

Do not:

- delete or overwrite signed clinical facts in place;
- allow a non-authorized actor to verify, sign, prescribe, or attest;
- infer provider privilege solely from a job-title string;
- treat scheduled procedures as performed procedures;
- create a claim from an unsigned/unverified procedure unless explicitly configured and legally reviewed;
- allow AI output to become final clinical truth without required human review;
- expose PHI in client logs, telemetry, crash dumps, URLs, third-party analytics, or support tooling;
- introduce a new PHI-handling vendor without a documented trust-boundary and BAA/subprocessor review;
- implement controlled-substance signing as a normal password-only action;
- hard-code CDT/SNODENT content that requires licensing into source control unless licensing explicitly permits it;
- use patient-visible tooth numbers as permanent database primary keys;
- rely on front-end filtering for tenant isolation.

## Coding expectations

- Prefer explicit domain types over generic JSON blobs for clinical records.
- All clinical mutations must include actor, timestamp, organization, patient, source, and version/provenance.
- Use append-only or versioned models for signed/attested records.
- Use database constraints and server-side policy enforcement for tenant boundaries.
- Any endpoint that returns PHI must have explicit authorization tests.
- Any endpoint that changes clinical status must have state-machine tests.
- Any background job that handles PHI must be idempotent, auditable, and encrypted in transit/storage.
- Any external integration must use an adapter layer; do not couple core domain models to vendor payloads.

## Required pull-request checklist

Every PR that changes clinical or PHI behavior must answer:

- What clinical object/state changed?
- Who is allowed to perform the action?
- What audit event is emitted?
- Can this alter a signed record? If yes, why is it an amendment instead of an edit?
- Does this create a new PHI disclosure or vendor dependency?
- Is there an authorization test?
- Is there a tenant-isolation test?
- Is there a negative-path test?
- Is the behavior reflected in API/schema/docs?
- Has a clinical SME review been requested where appropriate?

## AI feature rule

Use the pattern:

`AI suggestion → explicit human review → accepted structured data → provenance records both suggestion and acceptance`

Never use:

`AI output → silent final chart mutation`
