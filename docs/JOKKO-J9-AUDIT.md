# Jokko J9.0: forensic audit of work and opportunity code

**Scope.** Everything in this repository that touches work, earnings or labour:
- jobs, gigs, worker profiles, business staffing, payroll;
- courier work, distributor reps, pickup-point operations;
- commissions, apprenticeships, OpportunityOS;
- the Kabu team / work integration.

**Method.** I read the code and schema, reproduced findings with tests on a local database, and checked every claim against the code. No production access, nothing deployed. **The delivery-dispute P0 remains OPEN in production.**

**Classification key:**

| Class | Meaning |
|---|---|
| JOKKO-NATIVE | Jokko owns the facts and the money. |
| KABU-OWNED | Kabu's HR / commerce OS owns it. Jokko only moves money on an authorized instruction. |
| SHARED | Both sides hold part of it, through a contract. |
| ADAPTER | The bridge between the two. |
| LEGACY/DUPLICATIVE | Pre-J2 / J3 code whose concept J9 replaces or must contain. |
| FUTURE/DORMANT | Architected or labelled, not active. |

## 1. Inventory and classification

| Surface | Where | What it really is | Class | J9 action |
|---|---|---|---|---|
| **Gigs (Movement → Gigs)** | `src/screens/MovementScreen.js` `GigsPanel` / `submitGig` → `createProduct({category:'gig'})` | A **marketplace product listing** with category `gig`. A buyer pays the poster up front with product-order semantics. There is no offer, no terms, no completion evidence, no acceptance, no dispute and no employment / contract distinction. **A product listing is not a work contract.** | LEGACY/DUPLICATIVE | Replaced by J9 opportunities. Gig posting is gated off (no new gig products). Existing rows are left as-is (historical). |
| **"Jobs" list (Movement → Drive)** | `MovementScreen` `loadJobs` / `acceptDelivery` | The legacy `DeliveryTask` open-claim marketplace (closed to new use by D41). | LEGACY | None. D41 / D43 own it. |
| **WorkerProfile / WorkerReceipt** | `lib/worker-service.js`, `WorkerProfileScreen` | Worker modes (`delivery` / `seller` / `gigs`), a `WRK-` id (`Math.random`), and a receipt per completed legacy delivery (the only writer: `delivery-service.js`). Its `reputationScore` = jobs × 10 + earnings / 1000 + **KYC tier × 50**: it rewards income and paperwork, not the quality of the work, and has no correction or appeal. The `creditTier` and `loanNote` ("for loans") **over-claim**: no lender relationship exists. | LEGACY | Kept read-only as history. J9 adds its own work record (verified, correctable) and **does not read or write `reputationScore`**. The loan wording is reported (proposal P-J9-6). |
| **Business staff / members** | `BusinessMember`, `lib/authz/catalog.js` `BUSINESS_ROLES` | J3 / J5 role grants, such as `fleet_driver`, `distribution_rep` and `fulfillment`. These are **authority**, not employment. | JOKKO-NATIVE (authority) | J9 never infers employment from a role. Each J9 engagement is its own grant (D25). |
| **Payroll** | `lib/payroll-service.js`, `PayrollGroup` / `PayrollEmployee` / `PayrollRun` | The employer's own tool (J5 boundary). It is a business-wallet → employee transfer with its run record in the same transaction. Manual pay relies on the client's `Idempotency-Key` for dedup (a deliberate repeatable act). | JOKKO-NATIVE (J5) for Business Lite; KABU-OWNED when the employer runs HR in Kabu | No change. J9 staffing **refers** to payroll for employees and never pays wages through contractor rails. |
| **Kabu payroll instructions** | `lib/integrations/kabu.js` `payrollInstructions: DORMANT` | Kabu staff authority → Jokko payout instruction → J3 → J2. | ADAPTER (DORMANT) | Not built in J9 (**do not rebuild Kabu's HR OS**). The contract is in the J9 integration section. |
| **Cooperative deliveries / payouts** | `lib/cooperative-service.js`, `FarmerDeliveryLog` | Produce delivered by a member farmer, verified by a business admin, paid at a rate per ton **through the payroll rail**. It auto-creates a `PayrollEmployee` with `jobTitle: 'farmer'`, so a produce sale is recorded as `payroll_out` wages. **Misclassification** (a member's produce settlement is not a wage). See finding F1 for the double-payout defect. | JOKKO-NATIVE (legacy feature, J2 money) | F1 fixed locally. Reclassification proposed (P-J9-3). J9 cooperative work never counts produce settlements or dividends as wages. |
| **Distribution reps** | `TerritoryRep`, `lib/b2b/network.js` `assignTerritoryRep` | Territory assignment of an existing member. **No commission exists.** | JOKKO-NATIVE (J7) | J9 type B adds rep commission **only on a verified, received first order** (J8 receiving), funded by the distributor's rule, default 0 and disabled. |
| **Affiliate commissions** | `lib/affiliate-service.js`, `AffiliateProfile.commissionBps` default **500 (5 %)** | Paid **at purchase**, inside the payment split, with status `paid` immediately. It is **not reversed on refund** (no refund path references it). Self-referral is blocked only for the same user id, so a second account can farm it. | LEGACY (J4 / J5 commerce, live) | **Not changed** (a live financial rule, owner decision). Reported as R-J9-2 / P-J9-4. J9 rep commissions use the opposite design (verified outcome, hold, reversible before payout). |
| **Agent commissions** | `lib/agents/commission.js`, `AgentCommission` (J6) | Cash-network commission on verified cash-in / cash-out, under configured rules. | JOKKO-NATIVE (J6) | Reused as a pattern only. J9 never pays agent commissions. |
| **Courier work** | `lib/logistics/*`, `CourierEarning` (J8) | Funded earning from the shipment fee: escrow → accrued → hold → releasable → paid, exactly one per shipment (I21 / L6). | JOKKO-NATIVE (J8) | **J9 does not duplicate it.** The courier type A opportunity **links** to J8 earnings (read-only) for history and statements. |
| **Pickup-point operations** | `lib/logistics/pickup-points.js` | Custody at a point, with release by a recipient code. **No operator fee exists.** | JOKKO-NATIVE (J8) | J9 type C adds a per-parcel fee, accrued only on a **verified** release (`pickup_point_release` proof) and funded by an explicit rule, default 0 and disabled. |
| **Apprenticeships** | none | None. | — | J9 type F, built new: always a work arrangement with explicit learning terms, a stipend of ≥ 0, never unpaid "trial work" disguised as training, and minor restrictions enforced. |
| **School** | `lib/school-service.js` | School fees and rosters. Not work. | Out of scope | None. |
| **OpportunityOS** | `lib/intelligence/demand.js`, architecture doc | A k-anonymous **aggregate** demand feed; the consumer is **DORMANT**. | FUTURE/DORMANT | J9 publishes no individual worker data to it. The integration section defines only aggregates (counts of open opportunities by type and area, k ≥ 10). |
| **Kebu / Kabu Team / Work** | none in this repo (only the `kabu.js` adapter table) | Kabu owns HR (contracts, attendance, leave, performance). | KABU-OWNED | J9 receives no HR data. Kabu → Jokko pays only through the dormant payroll-instruction adapter. |
| **Reputation and trust signals** | `kebu-score-service.js` (business), `moi-service.js` (Ngor), `vouch-service.js`, `reviews-service.js` | Checked for ethnicity, ancestry, nationality, language, neighbourhood and diaspora proxies in the scoring inputs: **none used**. | JOKKO-NATIVE | J9 work trust uses only verified work facts, with correction and appeal (§ J9 design). |

## 2. Findings

| # | Severity | Finding | Evidence | Status |
|---|---|---|---|---|
| F1 | **P1 (double payout, live route)** | `POST businesses/:id/cooperative/payout` paid the farmer once **per concurrent request**. 4 parallel requests → 4 transfers from the business wallet; the logs were marked paid outside the money transaction. Also, because `payoutReference` is `@unique`, paying **two or more logs together** failed *after* the money moved, leaving them `verified` and payable again. No money is created (each transfer debits the business wallet); the business overpays its member. | `tests/j9/coop-payout.test.js`: 4/4 succeeded on the old code. | **Fixed locally:** the logs are claimed before paying (a conditional per-log claim), marked `paid` with a per-log reference **inside** the same money transaction, released on failure, and `payout_held` when risk-held (never payable twice). 3/3 tests. **Production still has the defect until deployed** (deploy is blocked; the P0 is open). |
| F2 | P2 (misclassification) | A cooperative produce settlement is recorded as wages (`payroll_out`, an auto-created `PayrollEmployee` "farmer"). | Code. | Reported (P-J9-3). Changing a live ledger kind is a financial decision. |
| F3 | P2 (honesty) | Worker profile: "reputation for loans" and a credit tier with no lender behind them. The score rewards earnings and KYC tier. | Code. | Reported (P-J9-6). J9 neither reads nor extends it. |
| F4 | P2 (commission integrity) | Affiliate commission (5 % default) is paid at purchase and not reversed on refund; can be farmed with a second account. | Code. | Reported (R-J9-2 / P-J9-4). No live rule changed. |
| F5 | P3 (product honesty) | "Gigs" are product listings: the poster is prepaid like a seller, with no work protections. | Code. | J9 gates new gig products (`gig_listing_retired`) and replaces them with funded opportunities. |

## 3. What J9 builds on (unchanged)
- **J2:** the only money authority (`move`, accounts, holds, invariants).
- **J3:** route policy, roles, step-up, maker/checker, audit.
- **J5:** business identity and payroll (the employer's tool).
- **J7:** commercial outcomes (POs, receiving).
- **J8:** custody proofs and courier earnings.
