# Jokko J9: Work & Opportunity

**Status: built and verified LOCALLY. Not deployed.** J9 money is inert unless `JOKKO_WORK_MONEY_ENABLED=true`, which is unset everywhere. The production delivery-dispute P0 remains **OPEN**, and no live J9 money may move while it is. The audit of what already existed is in [`JOKKO-J9-AUDIT.md`](JOKKO-J9-AUDIT.md).

## 1. What J9 is (and is not)
- **J9 is** a way for verified businesses to offer real work and pay for it **safely through J2**: explicit terms, funding *before* a binding paid assignment, proof of the work, a fair acceptance window, disputes with independent rulings, and a worker-owned record.
- **J9 is not** an HR system. Contracts, attendance policy, leave and performance belong to the employer, or to **Kabu** when the employer runs HR there. J9 does not rebuild Kabu's HR OS.
- **J9 is not** a gig product listing. The old "Publier un gig" created a marketplace product that prepaid the poster with no terms and no proof. New gig listings are refused with `gig_listing_retired`.
- **Employment ≠ contract work.** An employee's wage goes through the employer's payroll (J5), never through J9 contractor rails. Job-like contract terms (≥ 30 h/week for more than 12 weeks) are refused as `classification_requires_employment`.

## 2. Lifecycle

```
opportunity (verified business; worker-fee language → under_review, invisible until ops approve)
  → apply | invite (discoverable workers only; a block = "not found")
  → screening (structured: declared skills, VERIFIED qualifications, availability — never protected attributes)
  → offer: explicit terms, immutable (DB), hashed; prepaid work FUNDED NOW into escrow:work:<offer>
  → worker accepts the exact termsHash (age / minor rules; explicit, revocable business role if the work needs one)
  → work: attendance by business-issued single-use codes; milestone evidence (receipt for reimbursements)
  → business accepts | disputes within the window — or AUTO-ACCEPT when the window lapses
  → earning: escrow → worker:<id>:earnings (accrued, hold 24 h / commission 7 days, frozen by any open dispute)
  → payout: worker → own wallet (idempotent per key)
```

- **Employment:** the offer carries the wage. Acceptance records a `PayrollEmployee` (the employer's obligation). No escrow, no J9 earning. A `nonpayment` claim stays possible ("missing prefunding never removes the obligation") and is ruled `finding_only`.
- **Ending early:** either party can end before any work is submitted or attended, and unearned escrow returns to the business. After that, only acceptance or a dispute closes the work: no unilateral clawback of attended work.

## 3. Opportunity types

| Type | Arrangements | Funding | Pay arises from |
|---|---|---|---|
| A. `courier` (business's own fleet) | contract / employment | prepaid per-delivery budget / payroll | each verified J8 delivery by the hired courier, once per shipment. **Never** when J8 already pays a courier earning. Grants `fleet_driver` (revoked on end). |
| B. `rep` | contract / employment | outcome rule / payroll | the merchant's **first** PO that is **received** (J8 receiving or the buyer's own receipt) **and paid**, once per merchant. Self-dealing (rep or distributor staff own or run the merchant) is ineligible. Grants `distribution_rep`. |
| C. `pickup_point` | contract | outcome rule | each `pickup_point_release` (recipient's code) of the rule business's parcels at that point, once per shipment. Paid to the operator **business** wallet after the hold. |
| D. `staffing` | contract / employment | prepaid / payroll | accepted milestones; attendance codes when terms say so. |
| E. `gig` | contract | prepaid | accepted milestones. |
| F. `apprenticeship` | apprenticeship | prepaid (stipend ≥ 0) | accepted milestones. Requires a learning plan and 1–52 weeks. Open to verified 16–17-year-olds (non-hazardous, no night work). |
| G. `coop_work` | coop_member (cooperatives only) | prepaid | accepted milestones, classified `member_work_payment`. **Never** wages, never a dividend (J9 has no distribution path). |

## 4. Money (J2 is the only authority)

| Event | Posting | Reference |
|---|---|---|
| prepaid offer sent | business wallet → `escrow:work:<offer>` | `WRK-FUND-<offer>` |
| offer declined / withdrawn / expired / blocked | escrow → business wallet | `WRK-REFUND-OFFER-<offer>` |
| milestone accepted (business, auto or ruling) | escrow → `worker:<id>:earnings` | `WRK-EARN-milestone:<id>` |
| courier verified delivery | escrow → worker earnings | `WRK-EARN-shipment:<id>` |
| unearned milestone / remainder / unused budget | escrow → business wallet | `WRK-REFUND-…` |
| rule budget funded / ended | business wallet ⇄ `escrow:work_rule:<rule>` | `WRB-FUND-…` / `WRB-END-<rule>` |
| verified outcome | rule budget → worker or `work_business:<id>:earnings` | `WRK-EARN-outcome:<key>` |
| payout | worker earnings → worker wallet / business earnings → business wallet | `WEP-…` / `WBP-<earning>` |
| ruling against an unpaid earning (maker/checker) | earnings → payer business wallet | `WRK-REV-<sourceKey>` |

**Rules:**
- **Integer Kori only.** Platform fee is 0, and any other value is refused in code. Rule amounts default to 0, and a 0-rate rule cannot be activated.
- **Dual control on rules.** A rule needs approval by a **different** member holding `business.pay`, and pays only from its prefunded budget. An outcome that finds the budget short **waits**; nothing is promised unfunded.
- **No automatic clawback.** Paid earnings are never reversed automatically; a ruling against a paid earning reports it as unrecoverable.
- **Classification on every earning:**
  - `contractor_payment`
  - `apprenticeship_stipend`
  - `member_work_payment`
  - `commission`
  - `service_fee`
  - `reimbursement`

  Payroll wages and ownership distributions are not J9 earnings.

## 5. Protections

| Threat | Control | Test |
|---|---|---|
| Fake jobs / impersonation | Verified, active businesses only; the posting shows the registered business | lifecycle "fake jobs" |
| Recruitment-fee scams | Workers never pay (no field exists); fee language → `under_review`, invisible until ops rule | lifecycle, E2E |
| Wage theft | Funded before acceptance; auto-accept after the agreed window; nonpayment dispute; employment obligation recorded | lifecycle, pilots |
| Fake completion | Evidence required; business dispute (before acceptance, or after while unpaid); ops ruling + finance execution | pilots |
| Fabricated attendance | Business-issued single-use code, attempt-limited (5) and counted outside the transaction | lifecycle |
| Collusion / self-dealing | People who run the business cannot be hired by it or accept their own work; rep / staff-owned merchants ineligible; W6 | lifecycle, pilots |
| Duplicate payouts | Unique `sourceKey` / `outcomeKey`, deterministic references, row locks, idempotent payout; concurrency tests | lifecycle, pilots |
| Discriminatory screening | Structured requirements only; no protected-attribute fields anywhere (a `nationality` field is rejected 400); fair discovery (newest first, worker-chosen filters, no paid ranking) | trust, lifecycle |
| Minors / hazardous work | Verified age (KYC tier ≥ 2 + date of birth): under 16 none; 16–17 non-hazardous, no night work; unknown age: hazardous refused, attestation otherwise | lifecycle |
| Harassment | Worker blocks a business: pending offers withdrawn (escrow refunded), invitations impossible; `harassment` dispute kind | lifecycle |
| Data leakage | Applicant card: handle, name, headline, skills, areas, verified qualifications, counts — never phone, email, age, date of birth, nationality, language, address or photo; dispute views show roles, not user ids | lifecycle, pilots, sweeps |
| Reputation manipulation | Feedback once per side, only after real work; the subject can contest (excluded until ruled); shown only with ≥ 3 ratings | pilots |
| Unauthorized staff | `business.staffing.manage` (owner, manager) to post or accept; `business.pay` to fund; authorization-boundary gate entries for every J9 money route | trust, sweeps |

## 6. Invariants (`lib/work/invariants.js`, run after every J9 test and in the gate)

| # | Invariant |
|---|---|
| **W1** | Offer escrow = what is still owed (sent → total; closed → 0; accepted → total − earnings − refunds). |
| **W2** | Each earnings account = its accrued + releasable earnings, and no earning exists without an account. |
| **W3** | Milestone ⇔ earning (accepted → exactly the amount; split → less; otherwise none). |
| **W4** | Employment and outcome engagements never hold escrow or earn from an assignment. |
| **W5** | Outcome earning ⇔ accrued outcome. |
| **W6** | No earning paid to the payer business's owner (or a business paying itself). |
| **W7** | Every earning has its accrual posting, with the exact amount. |

**DB guards:**
- offer terms are immutable;
- milestone amounts are immutable and its status only moves forward;
- earnings are immutable and their status only moves forward;
- evidence and outcomes are append-only;
- disputes are never deleted;
- amount CHECKs are enforced.

## 7. Integration contracts

| System | Contract | Status |
|---|---|---|
| **J2** | The only money authority. Accounts `escrow_work`, `worker_earnings`, `work_rule_budget`; I1–I21 plus W1–W7. | ACTIVE (local test ledger) |
| **J3** | Route policy for 57 J9 routes. Capability `business.staffing.manage`. Admin roles: `work_ops` (no money); finance gets `work.disputes.settle`. Conflict pairs `work_ops` ⟂ `finance_ops`, `sysadmin` ⟂ `work_ops`. Approval action `work_dispute_settle`. | ACTIVE |
| **J5** | Employment → `PayrollEmployee` (the employer's tool). J9 never pays wages. | ACTIVE |
| **J7** | Rep commission reads POs (`receivedAt`, `receivedBy`, `paymentStatus`, invoice), relationships (`introducedByUserId`) and open returns (commission hold). Read-only. | ACTIVE |
| **J8** | The courier type reads verified deliveries (`deliveryProof`, completed `CourierAssignment`) and refuses shipments with a J8 `CourierEarning`. The pickup-point fee reads `pickup_point_release`. Shipment disputes freeze or void. Read-only. | ACTIVE |
| **Kabu Team/Work** | Kabu keeps HR. Pay arrives only through the dormant payroll-instruction adapter (Kabu staff authority → Jokko instruction → J3 → J2). No HR data flows to J9. | DORMANT |
| **OpportunityOS** | Aggregates only (open opportunities by type and area, k ≥ 10). No individual worker data. | DORMANT (no feed built) |
| **J11 collective capital** | Ownership distributions are not J9 earnings. J9 has no dividend path. | FUTURE |
| **Japalante cooperative membership** | `coop_work` pays `member_work_payment` for labour only. Membership and dividends belong to J11 / Japalante. | FUTURE |

## 8. Dormant register

| Item | State | To activate |
|---|---|---|
| J9 money (`JOKKO_WORK_MONEY_ENABLED`) | **OFF** everywhere | P0 closed and verified; finance approval of hold periods; owner decision |
| Platform fee on work | **0**, hard-coded | finance decision (P-J9-5) |
| Rep commission / pickup-point fee rules | 0 / proposed by default | per business: dual approval + prefunding |
| Kabu payroll instructions | DORMANT | the Kabu integration track |
| OpportunityOS feed | DORMANT | governance approval |
| Worker payouts off-platform (to mobile money) | Not built: payouts land in the Jokko wallet only | existing J4 cash-out rails |
| `cron/work` (outcomes, auto-accept, promotion, expiry) | route exists; no schedule configured | scheduling at deploy |
| Ratings shown | only with ≥ 3 independent, uncontested ratings | — |

## 9. UI
- **Worker:** Mouvement → Travail → *Trouver du travail*, using `WorkScreen`. Tabs: discover, applications and offers (exact terms), missions (attendance codes, evidence, nonpayment), earnings (payout), profile (visibility, qualifications).
- **Business:** Business hub → *Recruter & missions*, using `BusinessWorkScreen`. Tabs: post, applicants (cards without contact data), funded offers with PIN step-up, missions (codes, validate or contest), commission rules.
- **Ops:** the ops console's **Work** tab. It covers the review queue, qualifications, disputes, settlements awaiting a second operator, and contested feedback. All user text is escaped.
