# J9 decision review (A5): P-J9-1 … P-J9-10

**None of these decisions is approved.** Each row gives the proposed policy, its implications, the **safe default currently in code** (conservative, and inactive in production), whether local implementation can proceed, and the approvals needed. "Local" means code and tests on this branch only. Nothing here is deployed.

**Approver key:**
- **Owner:** product / business owner.
- **Finance:** finance lead; reconciles the ledger.
- **Counsel:** Senegal / WAEMU-qualified lawyer.
- **Compliance:** BCEAO / e-money and AML (see `docs/K21-REGULATORY-STRATEGY.md`).
- **Security:** security review of the change.
- **Ops:** support / operations lead.

## P-J9-1: J9 money activation, holds and windows
- **Proposed policy:** J9 money stays OFF until the P0 is closed and verified. Then finance approves the A2 settlement values:
  - earning hold: 24 h;
  - contest window: 24 h after explicit acceptance, 72 h after deemed acceptance;
  - commission hold: 7 days;
  - appeal window: 48 h;
  - dispute SLA: 72 h.
- **Financial:** payout eligibility = max(hold, contest window). A shorter window raises the risk of a false completion paid without recourse (no clawback, P-J9-9); a longer one delays worker income.
- **Legal:** escrow of a business's funds for a worker is custody of Kori in a closed loop. It must stay inside the regulatory posture (no external-rail payout from J9).
- **Security:** policy overrides are bounded (`WORK_SETTLEMENT_JSON`; unsafe values ignored).
- **Safe default (in code):** `JOKKO_WORK_MONEY_ENABLED` is unset, so no J9 money moves; the A2 values above are the defaults.
- **Local implementation:** done (A2).
- **Approvals:** Finance (values), Owner (activation), Compliance (custody posture).

## P-J9-2: employment vs contract classification
- **Proposed policy:** contract terms of ≥ 30 h/week for more than 12 weeks are refused as contract work and routed to employment / payroll.
- **Financial:** misclassified wages expose the employer to social contributions (CSS, IPRES) and tax, and Jokko to facilitation risk.
- **Legal:** **a generic threshold is not compliance.** The Senegalese Code du travail and its collective agreements define employment by subordination, not by hours alone. The rule is a product guard only and needs a jurisdiction-specific legal review, with a review for each country before any expansion.
- **Security:** none specific.
- **Safe default (in code):** the refusal is active, which is the conservative direction. The UI states that the rule is not legal advice.
- **Local implementation:** done as a guard. A real classification needs counsel's criteria.
- **Approvals:** **Counsel (mandatory)**, Owner.

## P-J9-3: reclassify legacy cooperative produce payouts
- **Proposed policy:** stop recording farmer produce settlements as payroll wages (`payroll_out`, auto-created "farmer" employee). Use a dedicated member-produce-settlement kind.
- **Financial:** today's records overstate payroll and understate purchases. Reclassifying history is a ledger change: do it **forward-only**, with history annotated and never rewritten.
- **Legal:** a farmer recorded as an "employee" can imply an employment relationship that does not exist.
- **Security:** none specific.
- **Safe default (in code):** unchanged live behaviour. The F1 double-payout fix is separate (A3).
- **Local implementation:** can proceed (a new kind and a forward-only switch behind a flag). **Not started.**
- **Approvals:** Finance, Counsel (on the employment implication), Owner.

## P-J9-4: affiliate commission
- **Proposed policy:** refund-aware deferred settlement (A4), or default 0 %, or retire the programme.
- **Financial:** the immediate mode pays the commission before fulfilment and never reverses it, which invites farming.
- **Legal:** a commission paid to a consumer for referrals can look like a payment service or unregulated marketing. The 5 % rate and its disclosure need review.
- **Security:** deferred mode adds self-dealing, velocity and one-per-order controls.
- **Safe default (in code):** `AFFILIATE_DEFERRED_SETTLEMENT` is unset, so the legacy behaviour is unchanged. **Correction:** this behaviour is **not** in the live production `7d262de`; it is latent on `19ac203`.
- **Local implementation:** done (A4).
- **Approvals:** **decide before any deploy of the default branch.** Owner, Finance, Compliance.

## P-J9-5: platform fee on work
- **Proposed policy:** the fee stays 0.
- **Financial:** no revenue from J9.
- **Legal:** a fee on escrowed work turns Jokko into a paid intermediary, with tax (VAT) and regulatory implications.
- **Security:** none specific.
- **Safe default (in code):** `PLATFORM_FEE_BPS = 0`.
- **Local implementation:** nothing to do.
- **Approvals:** Finance, Compliance, Counsel (before any non-zero fee).

## P-J9-6: legacy "reputation for loans" wording
- **Proposed policy:** hide the "réputation pour les prêts" / credit-tier wording until a lender relationship exists.
- **Financial:** none directly.
- **Legal:** implying credit eligibility without a lender is misleading consumer communication.
- **Security:** none specific.
- **Safe default (in code):** the wording is still live in the legacy profile.
- **Local implementation:** **can proceed now**; it is copy only. Recommended.
- **Approvals:** Owner (copy).

## P-J9-7: minors
- **Proposed policy:**
  - no work under 16;
  - at 16–17 (verified date of birth): non-hazardous work only, no night work; apprenticeships allowed;
  - unknown age: hazardous work refused; other work needs an attestation.
- **Financial:** none directly.
- **Legal:** **flag for jurisdiction-specific legal review.** Senegal's minimum working age and its list of hazardous work (arrêtés) apply, and they differ by country. A self-attestation is weak evidence.
- **Security:** age data is PII (verified date of birth only from KYC tier 2).
- **Safe default (in code):** the refusals are active.
- **Local implementation:** done as a guard. Raising unknown-age work to "verified age required" is a one-line change, recommended pending counsel.
- **Approvals:** **Counsel (mandatory)**, Owner.

## P-J9-8: rep commission eligibility
- **Proposed policy:** commission only on the merchant's first order that was received **and** paid. Ineligible outcomes are recorded once and never re-evaluated; an outcome waiting for budget is paid in order once funded.
- **Financial:** budget-bounded (`workRuleBudget`), with no unfunded promises.
- **Legal:** commission agents are contractors, so the terms must be disclosed.
- **Security:** self-dealing checks are active.
- **Safe default (in code):** as proposed, behind the J9 money flag.
- **Local implementation:** done.
- **Approvals:** Finance, Owner.

## P-J9-9: no automatic clawback
- **Proposed policy:** paid work earnings are never clawed back automatically. A ruling against an unpaid earning is reversed under maker/checker; a ruling against a paid earning goes to support / legal.
- **Financial:** the business bears a paid false completion. A2 shrinks this risk: payout only after the contest window, and a ruling waits for the appeal window.
- **Legal:** debiting a worker's wallet without consent or a legal basis is a high risk.
- **Security:** none specific.
- **Safe default (in code):** as proposed.
- **Local implementation:** done.
- **Approvals:** Finance, Counsel.

## P-J9-10: F1 cooperative double-payout fix
- **Proposed policy:** ship the fix as its own patch on `7d262de` after the P0, never bundled and never from `19ac203`.
- **Financial:** **live P1 exposure** until it is deployed.
- **Legal:** recovering any duplicate payment needs the farmer's consent.
- **Security:** none specific.
- **Safe default (in code):** the package is ready (A3), **not deployed**.
- **Local implementation:** done (A3).
- **Approvals:** Owner (deploy authorization), Ops (verification), with verified Vercel access.

## Also flagged for legal review (A6)
- **Payroll:** J9 records employment obligations and never pays wages. The employer's payroll tax and social contributions stay outside Jokko and need counsel's confirmation of the boundary.
- **Evidence attachments:** retention limits and the purpose of processing personal data under Loi n° 2008-12 (CDP Sénégal) need confirmation.
