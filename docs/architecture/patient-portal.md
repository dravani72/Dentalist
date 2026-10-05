# Patient portal

MASTER_SPEC §16 (portal), §19 (consents) and the Architecture Plan's portal identity notes, as built.

## Who can see what

- **Separate identities.** Patients and representatives have `portal_account` rows, never workforce accounts.
  Sign-in is email + password, then a 6-digit code sent to the email (10 minutes, 5 tries, stored hashed). Five
  wrong passwords lock the account for 15 minutes. Sessions are opaque tokens with the same idle and absolute
  limits as staff sessions. A staff token is refused on portal routes and a portal token on staff routes.
- **Access grants, not accounts, decide access.** A `portal_access_grant` names the account, the patient, the
  relationship (`self`, `parent_guardian`, `legal_representative`, `caregiver`), the record areas (scopes), how
  staff verified the relationship (required for anyone but the patient), who granted it and when it ends. One
  account can hold grants for several patients (a parent with two children) and at several practices.
- **Invitations start grants.** Staff with `portal.manage` create an invitation; the 12-character code is shown
  once (for handing over in person) and emailed. Only its hash is stored. It expires in 14 days, works once and
  only for the invited email.
- **Age rules** (`apps/api/src/portal/portal-rules.ts`): own access from age 13; parent/guardian access only for
  patients under 18 and always ending on the 18th birthday; consent forms are signed by an adult patient, a
  parent/guardian of a minor, or a legal representative, never a caregiver or a minor.
  **Open item: state rules on adolescent confidentiality and minors' consent vary and need the practice's legal
  review before go-live.** The thresholds are constants in one file.
- **Caregivers** start with appointments, pharmacy choice and messages. Staff can widen this with the patient's
  authorization. Caregivers cannot change contact preferences or sign forms.

## Two walls

1. The API checks the caller's live grant and scope for the patient on every request (`PortalService.grant`),
   and audits each denial.
2. Every portal transaction sets `app.portal_patients` to the granted patient ids. Migration 0006 adds a
   RESTRICTIVE `portal_scope` policy to every RLS table with a `patient_id` (and to `patient`), so Postgres hides
   and refuses rows of any other patient even if a query forgets its WHERE clause. Staff transactions leave the
   setting empty and are unaffected. An empty grant list restricts to the nil UUID, never to "everyone".

Tables without a `patient_id` (for example `appointment_resource`, `prescription_event`) are only reached through
joins from patient-scoped rows; online booking reads provider and operatory busy times server-side and returns
times only.

## What patients see and do

| Area | Shown | Patient can |
| --- | --- | --- |
| Appointments | Past 18 months and upcoming, with provider and location | Confirm; book online (only types marked `online_bookable`, at least 24 h ahead, re-checked server-side and protected by the double-booking constraint); ask to cancel; request an appointment |
| Visits | **Signed visits only**: procedures, diagnoses, aftercare and next-step notes | Ask for a correction (amendment) |
| Treatment plan | Open items from signed visits, with plain-language status | (cost estimates arrive with billing) |
| Health | Current allergies, medications, conditions, last review date | Send a history update, which goes to staff; a clinician enters it through the versioned history |
| Prescriptions | Signed prescriptions only, with transmission status | Choose pharmacies (marked `source = patient_portal`) |
| Messages | Threads with the office | Start and reply; read receipts both ways |
| Forms | Consent requests | Read, sign (typed name + agreement), or decline |
| Requests | Records copy (30-day clock), amendment (60-day clock), history update, appointment, cancellation | Track status and the office's note |
| Settings | Contact preferences | Change them (not caregivers) |

Nothing a patient submits edits the clinical record directly. Requests carry a `respond_by` date for the HIPAA
access (45 CFR 164.524) and amendment (164.526) clocks; the staff inbox flags overdue ones.

## Consents (§19)

- `consent_template` versions are immutable (trigger); a wording change is a new version and retires the old one.
- A `consent_request` ties a template version to a patient, optional plan items and a named dentist.
- Signing re-renders the text on the server and requires the SHA-256 the signer was shown, so a form that changed
  after it was opened cannot be signed. The signature stores the exact rendered text, its hash, signer
  relationship, typed name, portal account, when it was presented and when it was signed. Signatures are immutable
  except for revocation (trigger).

## Notifications and privacy

- Emails never contain PHI: the invitation and sign-in emails carry only the code; "something new" emails say only
  that a message, form or request update is waiting. They go through the outbox (`portal.notify`) to grant
  holders with the matching scope, unless the patient turned portal emails off.
- Audit: every portal read and write goes to the same hash-chained trail with purpose `patient_access` and the
  portal account in `details.portalAccountId`. The practice's "Who viewed this chart" report shows these as
  "Patient portal: name". Request and message text is never written to the audit trail.

## Staff side

- **Patient workspace → Portal & forms**: who has access and what they can see, last activity, end access,
  invitations (with relationship, scopes, verification note, optional end date), consent forms sent and signed
  (view the signed copy with its hash), send a form, send a secure message.
- **Portal inbox** (`portal.respond`): open conversations and patient requests for the staff member's locations,
  with response deadlines; consent template versions (`consent.manage` to author).
- Privileges: `portal.manage` (front desk, practice manager), `portal.respond` (front desk, assistant, hygienist,
  dentist, practice manager), `consent.manage` (dentist, practice manager).

## Production follow-ups

- Move portal identities to a separate Cognito user pool (the plan's choice); grants, sessions and audit stay here.
- Add SMS codes, rate limiting at the edge for the public sign-in routes, and email deliverability (SES).
- Legal review of the age thresholds and of what a caregiver may see by default.
