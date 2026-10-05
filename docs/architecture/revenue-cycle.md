# Revenue cycle

MASTER_SPEC §17. Migration `0007_revenue.sql`, API `apps/api/src/billing/`, shared rules `packages/shared/src/billing.ts`.

## Money and the ledger

- Money is integer cents everywhere.
- `ledger_entry` is append-only (trigger + no UPDATE/DELETE grant). Kinds: charge, patient_payment,
  insurance_payment, adjustment, refund, reversal. The amount is signed from the account's view: charges and refunds
  raise the balance, payments and write-offs lower it. The balance is the sum; nothing is cached.
- `applies_to_id` ties a payment or adjustment to the charge it settles (null = credit on the account).
  A correction is a `reversal` naming the entry it cancels, once (`reverses_id` is unique). A patient payment is
  reversed as a whole (returned check). Insurance payments are never reversed here, and a charge on a live claim
  can't be reversed until the claim is voided.
- Patient payments go to the oldest charges' patient share first (open amount minus insurance still expected);
  the rest stays as credit. Refunds can't exceed the credit. Reference fields refuse anything that looks like a
  card number.

## Charges

- Only SIGNED procedures are charged (scheduled or performed-but-unsigned work never is). Signing a visit queues
  `billing.post_charges`; it posts every procedure with a code and an office fee, and the rest wait in
  **Not yet charged** for billing staff to code.
- The code is suggested when a procedure is performed (`suggestBillingCode`, versioned by date of service) and
  can be changed by billing on a signed, uncharged procedure. That edits only the billing projection columns,
  which the signed-row guard allows.
- An amended procedure is not charged again if an earlier version was.

## Code sets and fees

- `billing_code.code_system` is `CDT` (licensed, loaded per deployment) or `SYNTHETIC` (invented, for dev/tests).
  Each code has a benefit category. Rules map our procedure concepts to codes by surface count and tooth class.
- `fee_schedule`: one active office schedule per practice, plus network (contract) schedules linked from payers.
  A fee change is a new row with an effective date, so past dates of service keep their fee.

## Insurance and estimates

- `insurance_policy` gained payer, benefits (coverage percent per category, deductible and which categories waive
  it, annual maximum, benefit-year start). Member ids are encrypted with the policy id as context and shown masked.
- `eligibility_check` keeps every answer. A check from the last 30 days supplies remaining maximum and deductible;
  otherwise they are tallied from this benefit year's claims.
- `estimate()` (shared) splits each item into contract write-off, insurance and patient share, in phase order so
  earlier work uses the deductible and maximum first. Staff see all open plan items; the portal only items from
  signed visits.

## Claims and remittance

- A claim is built from posted charges for one treating dentist at one office, with the insurance estimate per
  line. A trigger keeps a procedure on at most one live claim per coverage rank.
- Sending (claim.submit) freezes the lines, moves procedures SIGNED → CLAIMED and queues `claim.submit`. The claim
  id's idempotency key is the patient control number, so retries never file twice. A rejection moves procedures back
  to SIGNED; the claim can be voided and rebuilt.
- After acceptance `claim.poll` looks for the remittance (bounded retries). Each remittance is posted once
  (unique clearinghouse reference): line adjudication, an insurance payment and, in network, a contractual
  write-off on each charge; unmatched claims are kept on the remittance row and logged by id only.
- `ClearinghousePartner` is the vendor boundary; `FakeClearinghouse` adjudicates a demo plan per member id.

## Portal

New `billing` scope (patients and guardians get it by default; caregivers don't). Shows amount due, claims status,
activity without staff notes or names, and estimates. No online payment until a processor is chosen.

## Privileges

`billing.read`, `charge.post`, `payment.post`, `ledger.adjust`, `insurance.manage`, `fee_schedule.manage`, plus the
existing `claim.prepare` and `claim.submit`. Front desk: read, payments, insurance. Billing: everything except fee
schedules. Dentists: read. Practice manager: read, adjustments, fee schedules.
