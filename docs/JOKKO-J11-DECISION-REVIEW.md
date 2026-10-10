# J11 outstanding decisions: P-J11-1 … P-J11-6 (review pack)

**Status: ALL PENDING.** None is approved by this document, and silence is not approval. Whatever is decided, J11 money stays off in production (`JOKKO_COLLECTIVE_ENABLED`, `JOKKO_PROTECTED_FUNDS_ENABLED` unset) until a separate activation decision.

**Source of the wording.** `docs/JOKKO-DECISIONS.md` lists these items by short label only:
> "Still pending, exact terms to be reviewed: P-J11-1 (one tontine model, legacy retirement), P-J11-2 (release threshold), P-J11-3 (default after receiving), P-J11-4 (Jekkal protected), P-J11-5 (caps and AML, compliance), P-J11-6 (wording, counsel)."

The exact proposal texts are in `docs/JOKKO-J11-PLAN.md` §4 (quoted below). Where `docs/JOKKO-J11-0-AUDIT.md` §5 restated a proposal, both texts are given.

---

## P-J11-1: One tontine model
**Current wording (J11-PLAN §4):** "One tontine model. The legacy processor is retired after a read-only exposure check and a reviewed migration."
**Audit restatement (J11-0 §5):** "The J11 engine replaces both legacy and escrow-v1. Legacy groups stay frozen until a reviewed migration plan."

| | |
|---|---|
| **Recommended decision** | Adopt the J11 engine as the only tontine model. In production, retire the legacy processor via the P0-A containment (already authorized, not yet deployed). Freeze legacy groups as **read-only history**: no conversion, no money. **Do not migrate** legacy groups automatically. After the forensics, members of a legacy group may start a **new** J11 group by fresh consent. Escrow-v1 stays off and is deleted from the code once J11 ships. |
| **Alternatives** | (a) Auto-convert legacy groups to J11. *Not recommended:* legacy memberships were never consented, so conversion would manufacture consent. (b) Keep both models. *Not recommended:* two rule sets, and the legacy one is the P0. (c) Retire legacy without forensics. *Not recommended:* it loses the evidence needed for restitution. |
| **Financial implications** | Legacy collections already credited to creators' wallets stay where they are until a finance/legal restitution decision (case by case). The J11 engine starts from zero balances, so there is no transfer of legacy value. |
| **Legal / compliance** | Restitution and customer notification are separate reviewed decisions (P0-A §6). The record of non-consensual debits must be preserved. |
| **Safe inactive default (current state)** | Legacy: contained once P0-A is deployed (**not yet**). J11 engine: dark. Escrow-v1: dark, and its post-payout cancel is refused. No migration code exists. |

## P-J11-2: Release threshold / second confirmation
**Current wording:** "Release threshold for a second member's confirmation (proposal: any payout ≥ 100 000 XOF, or any pot release)."

| | |
|---|---|
| **Recommended decision** | **No human confirmation for rules-determined tontine payouts.** The destination and amount are fixed by rules every member approved, and a confirmation step gives one member a veto they could use for extortion. Instead, payouts above **100 000 XOF (10 000 ₭)** go through the existing **J3 risk engine** (large-transaction and night rules). A flagged payout is **held, never redirected**, and reviewed by risk ops. Protected funds keep their maker/checker (already built). |
| **Alternatives** | (a) Second member's confirmation over the threshold (the original proposal): adds a veto and a social-pressure point. (b) Recipient confirmation: the recipient cannot be harmed by receiving, so it adds nothing. (c) Ops approval for every pot: does not scale and adds operator risk. |
| **Financial implications** | A held payout keeps the pot in escrow (members' money is not at risk) but delays the recipient. A service level for review is needed. |
| **Legal / compliance** | Risk-hold criteria must be documented. Holds must be explainable to the user. |
| **Safe inactive default** | Engine dark. Payouts would follow the rules with no extra hold. The risk-engine integration is **not built**. |

## P-J11-3: Default after receiving (and recovery of claims)
**Current wording:** "Default policy menu (skip turn / replacement / pro-rata refund on cancel). **No automatic debit of a defaulter.**"
**Audit restatement:** "A recorded obligation, private reminders, no automatic debit, no public shaming. Disclosed as the members' risk."

| | |
|---|---|
| **Recommended decision** | (1) Keep: **no automatic debit, no public shaming**; missed payments are recorded and reminders are private. (2) A **voluntary repayment** path: a member who owes may repay into the group's settlement account. Recoveries go to the members who are owed **pro-rata to their claims**, executed only through maker/checker. (3) A **rules-chosen safeguard at creation**: "new members receive later" (a trust-aware rotation the members approve). (4) Disclose clearly before joining that members who have not yet received bear the default risk; **Jokko does not guarantee** pots. |
| **Alternatives** | (a) Security deposit (each member locks one contribution until completion). Strong protection, but it is held customer money and needs custody review. (b) Replacement members who take over a defaulter's position: complex consent questions. (c) Reporting to a credit bureau: licensing and data-protection issues. (d) Status quo: claims are records only, and creditors have no route to recovery. |
| **Financial implications** | Recovery distribution moves money between members. It must be pro-rata, idempotent and audited, and Σ recoveries can never exceed Σ owed. A deposit would increase funds held per group. |
| **Legal / compliance** | Debt collection rules; consumer protection (disclosure before joining); data protection for any default reporting; possibly the BCEAO view of pooled held funds (deposit option). |
| **Safe inactive default (current)** | Claims are recorded, immutable and balanced (P-J11-8). **No recovery mechanism exists**, so nothing is redistributed or forgiven. |

## P-J11-4: Jekkal protected campaigns
**Current wording:** "Jekkal: escrow plus a verified beneficiary before publishing; anonymous donations allowed but traceable to ops."

| | |
|---|---|
| **Recommended decision** | Keep **protected campaigns dormant** until three things exist: counsel-approved wording ("protégé" is not insurance or escrow, see P-J11-6), staffed trust-and-safety plus finance operators, and a verified-beneficiary rule (KYC tier ≥ 2, consent; already built). Anonymous donations: **hidden from the public, always traceable to ops** (current design). **Direct** Jekkal continues under P-J11-9 (approved). |
| **Alternatives** | (a) Make protected the default for new campaigns: more safety, but money is held. (b) Retire direct gifts: removes a simple, honest product. (c) Allow fully anonymous donations: AML gap. |
| **Financial implications** | Held funds per campaign until goal or deadline; automatic full refunds on failure; operator cost per release. |
| **Legal / compliance** | Holding donor funds pending a condition may be regulated (escrow-like). Charitable-solicitation rules may apply. Fraud reporting duties. |
| **Safe inactive default (current)** | `JOKKO_PROTECTED_FUNDS_ENABLED` off: every route answers 503. Direct Jekkal requires beneficiary consent and discloses a direct transfer. |

## P-J11-5: Caps and AML triggers
**Current wording:** "Caps per group and per person (Kori limits, tier-based), plus AML review triggers. **Compliance decision.**"

**Fact found during this review (finding J11-F7, latent, flag off):** the engine allows a contribution of up to **500 000 ₭** and up to 30 members (a pot of up to 15 000 000 ₭). The payout credits the recipient's wallet **without checking the KYC-tier balance cap** (Tier 2: 200 000 ₭; Tier 3: 1 000 000 ₭, `lib/tier-limits.js`). A rules-mandated payout could therefore push a wallet beyond its regulatory cap. This is not theft or money creation, but it is a compliance gap. **Conservative local guard added (J12 commit):** rules cannot be proposed if a full pot would exceed the **lowest member's** tier balance cap, and a payout re-checks the recipient's headroom. If there is no headroom, the payout is **held in the pot**, never forced into the wallet.

| | |
|---|---|
| **Recommended decision** | Contribution and pot caps derived from the **members' KYC tiers**: pot ≤ the lowest member's balance cap (now enforced locally). Per-person limits on simultaneous groups (e.g. 3) and on total monthly commitments. **AML triggers** (review, never automatic action): fast group cycling, groups whose members share devices or agents, pots near caps, repeated early-exit claims, and a single organizer across many groups. Protected funds: goal ≤ the recipient's tier cap or a business limit. |
| **Alternatives** | Flat caps independent of tier (simpler, but inconsistent with wallet limits); no group caps (not acceptable). |
| **Financial implications** | Lower caps reduce pot sizes and therefore usefulness for larger tontines. Tier upgrades become the path to bigger groups. |
| **Legal / compliance** | BCEAO e-money limits and KYC tiers; AML/CFT obligations (suspicious-transaction review and reporting). **Compliance must set the numbers.** |
| **Safe inactive default** | Engine dark. Tier-cap guard enforced locally. No AML triggers built (any activation needs them). |

## P-J11-6: Wording
**Current wording:** "Wording: no "investment", "interest", "returns" or "credit". **Counsel and compliance review.**"

| | |
|---|---|
| **Recommended decision** | Adopt the banned-term list (investment, interest, returns, credit, guaranteed, insured, deposit) for all J11 surfaces. Add a **wording test** that fails the build if user-facing J11 strings contain them outside negations. Have counsel approve: "protégé / cagnotte protégée" (or rename it, e.g. "cagnotte à versement contrôlé"), "épargne objectif", "créance / doit" in claims, and the rules disclaimer ("pas de garantie, pas d'assurance, pas d'intérêt, pas de rendement"). |
| **Alternatives** | Keep the current words and rely on disclaimers (weaker), or rename everything after counsel review (cleanest). |
| **Financial implications** | None directly. Misleading wording carries liability risk. |
| **Legal / compliance** | Consumer protection; BCEAO marketing rules for e-money (no implied interest or deposit). Counsel must sign off. |
| **Safe inactive default** | Current strings already avoid interest, returns and guarantee claims. "Protégé" appears only on dormant screens and APIs. No automated wording test yet. |
