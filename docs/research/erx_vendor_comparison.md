# E-prescribing integration: options and recommendation

Researched 2026-10-02. Prices are public or third-party figures and vary by contract; confirm in vendor quotes before committing.

## Recommendation

**Integrate DoseSpot through its Full API, starting with its iFrame ("JumpStart") for the first pilot.** Keep ScriptSure (DAW Systems) as the negotiating alternative. Do not pursue direct Surescripts certification.

Why:

1. **It is already the dental default.** DoseSpot is the e-Rx engine inside Patterson's Eaglesoft and Fuse, and Patterson sells it to Eaglesoft practices at about $55/month per prescriber *including* controlled substances. Dentists and their staff will recognise the workflow, and DoseSpot knows dental prescribing patterns (short opioid courses, antibiotics, chlorhexidine).
2. **EPCS is covered by their audited stack.** Dentists routinely prescribe Schedule II opioids, and many states mandate EPCS. Our spec (MASTER_SPEC §15.4, README principle 4) already says EPCS must use a certified partner rather than our own auth. DoseSpot runs identity proofing, two-factor signing and the DEA third-party audit; we never become the EPCS-certified application.
3. **It matches the boundary in MASTER_SPEC §15.3.** The partner owns pharmacy directory, NCPDP SCRIPT transport, refill requests, CancelRx, medication history and EPCS. We own the prescribing record, pharmacy preference and status history.
4. **Two-step path keeps us fast.** The iFrame can be live in about 30 days with a 5–10k setup; the Full API (3–6 months) lets us build our own prescribing UI on top later without changing partner.

## Comparison

| Option | What it is | Time to live | Cost (indicative) | EPCS | Fit for us |
|---|---|---|---|---|---|
| **Surescripts direct** | Become a certified network participant and build NCPDP SCRIPT, directory, EPCS ourselves | 12–18 months | ~$500k+ upfront, plus DEA audit and ongoing maintenance | We must pass DEA third-party audit and run identity proofing | Poor. Explicitly ruled out in README ("no in-house EPCS certification") |
| **DoseSpot** | Surescripts-certified middleware; iFrame or REST API | iFrame ~30 days; Full API 3–6 months | Setup $5–10k (iFrame) / $10–20k (API); ~$500–800 per prescriber/yr; EPCS ~$75–135 per prescriber/yr | Yes, Schedules II–V, ID proofing + 2FA included | **Best.** Proven in dental (Eaglesoft, Fuse) |
| **ScriptSure (DAW)** | Surescripts-certified middleware; white-label UI or native API | White-label in weeks; API 4–6 weeks (vendor claim) | Quote-based | Yes, II–V included, not a separate module | Strong alternative; less dental footprint |
| **DrFirst Rcopia** | Large e-Rx platform used by many EHRs | Months | ~$799 per *feature* per year (e-Rx, med history, EPCS each billed) | Yes | Capable but feature-by-feature pricing adds up for a small practice |
| **Weno Exchange** | Low-cost e-Rx switch | 2–4 weeks (iFrame) | Switch API $1,600 one-time + $8/prescriber/yr + $0.08/script | EPCS available, extra setup | Cheapest; thinner tooling and support |
| **Photon Health** | Modern GraphQL e-Rx API aimed at digital health | Fast (sandbox available) | Not public | Not confirmed in their docs | Nice developer experience, but EPCS gap makes it a risk for dentistry |

## Things that apply whichever partner we pick

- **Pharmacy directory.** The partner exposes Surescripts' directory (95%+ of US pharmacies) with search by name, address, ZIP and EPCS capability. We store the partner's pharmacy ID (NCPDP ID) plus a snapshot of name/address at send time, as §15.2 requires. Pharmacy search should filter to EPCS-enabled pharmacies when the script is controlled.
- **EPCS rules (21 CFR Part 1311).** Each prescriber needs identity proofing through a DEA-approved credential provider, two-factor authentication at signing, logical access controls set by two people, and audit logs. CMS separately requires 70% of Part D controlled-substance scripts to be electronic (automatic exception at 100 or fewer per year, which will cover many dentists), and several states mandate EPCS for every controlled script regardless.
- **HIPAA / BAA.** We sign a BAA with the partner; it covers their handling of prescription data only. Everything in our own app and infrastructure (medication list, allergies, prescription record, audit logs) stays our responsibility. We also need BAAs with our own hosting provider.
- **Contract questions to ask.** Per-prescriber vs per-practice pricing; whether EPCS and identity proofing are bundled; who pays for the DEA audit; sandbox access; webhook support for status updates, refill requests and CancelRx; PDMP lookup availability by state; dental-specific drug favourites.

## Suggested next steps

1. Request sandbox access and quotes from DoseSpot and ScriptSure.
2. Pilot non-controlled prescriptions through the DoseSpot iFrame (this is the non-controlled e-Rx step already in the roadmap).
3. Add EPCS (Phase 7) using the partner's flow, then move to the Full API if we want our own prescribing UI.

## Sources

- [E-Prescribing Integration 2026: Costs & API Options (Of Ash and Fire)](https://www.ofashandfire.com/blog/e-prescribing-integration-guide-2026)
- [How Much Does an ePrescribing Platform Cost? (DoseSpot)](https://dosespot.com/how-much-does-an-eprescribing-platform-cost/)
- [DoseSpot ePrescriptions (Patterson Dental)](https://www.pattersondental.com/cp/software/revenue-cycle-management-software/dosespot)
- [E-Prescribing API Integration for Health Tech Platforms (DAW Systems / ScriptSure)](https://dawsystems.com/blog/e-prescribing-api-integration-platform-vendors)
- [Photon Health FAQ](https://photonhealth.com/faq)
- [CMS 2026 EPCS Program Requirement At-A-Glance](https://www.cms.gov/files/document/my-2026-cms-epcs-program-requirement-glance.pdf)
- [Rcopia vs DoseSpot (SelectHub)](https://www.selecthub.com/e-prescribing-software/rcopia-vs-dosespot/)
