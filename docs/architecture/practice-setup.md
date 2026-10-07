# Practice setup

Staff administration, licenses, provider working hours and first sign-in (MASTER_SPEC §3 and §8). Migration
`0008_practice_setup.sql`, API `apps/api/src/admin/*`, web **Staff** tab (`#/admin`) and the first sign-in page
(`#/setup`).

## Who can do what

Everything here needs the `admin.staff` privilege (the practice manager template has it). On top of that:

| Action | Extra requirement |
| --- | --- |
| Add a staff member with privileges, add privileges to someone, reactivate someone | Fresh step-up (authenticator code within 5 minutes) |
| Verify a license | Fresh step-up; the verifier cannot be the license holder (also a database CHECK) |
| Reset someone's sign-in | Fresh step-up; not yourself; refused when the person also works at another practice |
| Change your own privileges | Removing privileges is allowed except staff administration; adding is refused |
| Deactivate | Not yourself; ends every session of that person at once |

Every change writes an audit event (`staff.create`, `staff.update` with privileges added/removed, `staff.deactivate`,
`staff.reactivate`, `staff.reset_sign_in`, `staff.setup_issue`, `credential.create`, `credential.verify`,
`credential.status`, `provider_hours.set`, `provider_time_off.create`, `provider_time_off.cancel`,
`auth.setup_complete`). Refusals are audited as `denied` in their own transaction.

A refusal for a missing privilege names it (`details.privilege`, and its plain label in the message) so the person
knows what to ask an administrator for. In the web app, errors on these screens appear as callouts inside the panel
(icon, title word and border style, never color alone) with a Dismiss button; the rest of the screen stays usable.
Signing out clears the address bar, and an address for a section the signed-in person can't open shows a notice above
their landing section instead of an error-only page (this was the "You do not have permission" seen after a license
was added and someone else signed in on the same screen).

## Privileges, templates and provider kind

- Authority comes only from the stored privilege list. The role template is recorded for reference, and the screen
  shows which privileges differ from it (`+ added`, `− removed`).
- `staff_member.provider_kind` (dentist, hygienist or empty) says who can be booked. It grants nothing. Scheduling,
  online booking, the chart's "performed by" list and consent provider pickers use it instead of the template name.
  The migration copies it from the template once for existing staff.
- Privilege changes apply on the person's next request (the session re-reads the membership every time).

## Licenses

- Licenses entered by an administrator start as `pending_verification` and satisfy no signing check.
- "Record verification" stores who checked, when, and where (for example the state board's lookup page). Only then
  does the license become `active`.
- Suspend, revoke or mark expired takes effect on the holder's next signing or prescribing attempt.
- NPIs are recorded as active straight away: they are public registry numbers and grant nothing.
- DEA registrations are managed on the **EPCS** page, not the Staff page: the number is stored encrypted and shown
  only as its last three digits, and it goes through the same "Record verification" step (another administrator,
  with a step-up). See "Controlled-substance prescribing (EPCS)" in `implementation-notes.md`.

## Working hours and time off

- `provider_hours`: weekly blocks per provider and location, in clinic-local minutes, effective from a date.
  Changing hours never rewrites the past: running hours end the day before the new set starts, and planned hours
  that never started are marked `superseded_at` (kept, not deleted).
- `provider_time_off`: absolute time ranges with a category (vacation, sick, training, meeting, other). Adding time
  off reports how many existing bookings overlap; they are not moved automatically.
- Online booking offers a time only when a provider of the right kind works then (inside one block, not on time
  off) and a chair and the patient are free. It replaces the fixed Monday to Friday 8 to 5 hours.
- Staff booking still allows times outside working hours (emergencies, late patients). The booking form shows a
  warning with a ⚠ symbol and text when the time is outside the provider's hours or during time off.

## Sign-in accounts

Workforce sign-ins (`user_account`) are global: one person can work for several practices. The API role cannot
write that table directly; four narrow `SECURITY DEFINER` functions do the few writes administration needs:

- `staff_account_find_or_create`: a new email gets an account that cannot sign in until setup is finished; an
  existing email (someone who works at another practice) is linked without touching their password or authenticator.
- `staff_account_reset`: wipes password and authenticator and ends sessions, only when every membership of that
  account is in the calling practice.
- `account_setup_org` / `account_setup_apply`: resolve and complete a setup code.

### First sign-in

1. The administrator adds the person (or resets their sign-in) and gets a one-time setup code, valid 3 days. It is
   also emailed. Only a hash is stored.
2. The person opens **Set up my sign-in**, types the code (it never goes in a URL), picks a password of at least
   12 characters, adds the shown key to an authenticator app and confirms with a code. Five wrong codes void the
   setup code.

### Authenticator codes work once

`user_account.totp_last_step` records the newest 30-second step accepted for that account. Sign-in, step-up and
setup accept a code only for a later step, so a code seen over a shoulder or replayed from a captured request is
refused, and so is any older code still inside the clock-drift window. A refused replay is audited as
`totp_replay`. In practice this means signing in and then confirming a signature needs two different codes; the
step-up dialog says so.

Tests give each synthetic account its own clock (`totpClock` override) so every simulated sign-in can use a fresh
code; production always uses the wall clock.

## Production notes

With Cognito, the setup code flow maps to Cognito's admin-created user invitation, and Cognito enforces TOTP reuse
protection itself; the privilege, license, hours and audit pieces stay as they are.
