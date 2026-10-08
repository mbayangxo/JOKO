# Jokko: recorded decisions

This is the owner's decision log. Each entry is binding on later work until it is explicitly revised. **None of these decisions authorizes a production write.**

## D-J2: Production and migration (recorded at J2 acceptance, 2026-10-03)

The J2 Money Kernel was accepted **locally**. It has not been deployed: production is untouched and branch deployments stay disabled.

| # | Decision | Applies to |
|---|---|---|
| D1 | Production investigation is **read-only first**. | Every production access |
| D2 | Do **not** baseline production migration history yet (`db:resolve-baseline` is not run). | `_prisma_migrations` in production |
| D3 | Keep the new database deployment step **disabled** (`MIGRATION_DEPLOY_ACTIVATED` unset; `db-migrate-deploy.mjs` exits 3). | `vercel-build` |
| D4 | Do not drop or transform unknown legacy data. | All legacy tables and columns (`JOKKO-LEGACY-SCHEMA.md`) |
| D5 | Do not classify unknown historical backing as either backed or deficient. It is modelled as **legacy / unverified** until reconciled (`migration:opening:*`, `differences.migrationOpening`). | Reserve and reconciliation |
| D6 | A **genuine post-migration reconciliation deficit** may trigger financial containment. Unknown legacy provenance on its own is surfaced and risk-managed **separately**: it is not a deficit and does not freeze. | `reconcileFromLedger`, coverage policy |
| D7 | Preserve the old XOF balances, KebuInvestment, KoriRedemption, Ñu Lekk and MerchantPromo until their meaning, data and dependencies are established. | Legacy value |
| D8 | Agent commissions must be **funded liabilities**, never fabricated wallet value. | `agent_commission`, payouts |
| D9 | Submitted partner payouts require provider reconciliation or admin review. | `partner-payouts-service` |
| D10 | Financial adjustments use **risk-based maker/checker**. High-risk or high-value operations need dual authorization. Tightly limited lower-risk adjustments may use a single authorized operator, with immutable audit history. | `money-kernel/admin.js`, J3 admin duties |

How these apply to the current code:
- **D5/D6:** `ledgerPosition()` already separates `migrationOpening` (legacy / unverified) from `suspense` and the real reconciliation exceptions. The integrity freeze applies only to genuine invariant or reconciliation failures. Coverage below 100 % caused by legacy openings is reported, not frozen.
- **D10:** J3 implements this as a policy table in `lib/money-kernel/admin.js`. A single operator holding the `finance.adjust.low` permission is allowed only below a low cap and only on non-customer accounts. Everything else goes through dual authorization. Every adjustment is append-only audited.

## D-J3: Identity, trust & permissions (recorded at J3 acceptance, 2026-10-05)

The J3 gate was accepted **locally**. Not deployed. Production untouched; branch deployments, production baselining and the deploy step stay disabled. Read-only production verification remains a parallel, BLOCKED workstream.

| # | Decision | How it applies |
|---|---|---|
| D11 | Do **not** assign production operator roles yet. First inventory existing production operators read-only. `--break-glass` is emergency/bootstrap only, never ordinary administration. Preserve separation of duties: avoid routinely giving one human support + risk/compliance + finance + approver/sysadmin authority. | `scripts/admin-roles.mjs` is not run against production; SoD conflicts stay enforced. |
| D12 | Pre-J3 sessions are **not** trusted for outbound financial authority. Re-authentication / PIN confirmation under the J3 trust model; no grandfathering. | Session-less tokens are untrusted in production (`requestTrust`). |
| D13 | Keep the **24 h new-device cash-out hold** and the **60-day** maximum session lifetime, with rotation, device trust, revocation and risk-triggered step-up. A 60-day session alone is never sufficient evidence for a high-risk financial operation. | Cash-out always needs step-up in the session, plus the risk guard. |
| D14 | **Tier 0 is receive-only for money.** Email-only users may use non-financial features and receive value, but cannot send or withdraw until the required verification is done. | `TIER_LIMITS[0]`. |
| D15 | Initial maker-checker thresholds: **5 000 ₭** platform adjustment, **10 000 ₭** refund, **500 000 XOF** agent float. They are conservative, configurable defaults, not permanent policy, and their usage is instrumented for later calibration. | `LIMITS` in `lib/authz/catalog.js`; usage reported by `GET admin/money/limits-usage` (J4). |
| D16 | Diaspora/local status may affect product routing, country context, rails, currency, UX or services, but must **not** inherently change authentication trust, fraud score, identity confidence or security permissions. Never use ethnicity, nationality, language, name, neighbourhood or diaspora identity as a proxy for trustworthiness. | J4: the pre-J3 device-login flag ("foreign IP unless diaspora") is replaced by an account-relative "new login country for this account" signal. Regression tests cover it (`tests/unit/fraud-rules.test.js`). |
| D17 | Passkeys and KYC re-verification stay recorded as **future security work**. They are not faked to make a gate green. | Listed as open in the gate reports. |

## D-J4: Money vertical slices (recorded at J4 acceptance, 2026-10-05)

The J4 gate was accepted **locally**. It has not been deployed: production is untouched, Vercel branch deployments stay disabled, and the database deployment step stays inert.

| # | Decision | How it applies |
|---|---|---|
| D18 | **Fees are 0** for P2P, money requests, merchant payments, internal Jokko transfers and cash-out. No fee schedule is invented without real provider, agent and unit-economics data. The fee architecture stays configurable and ledger-backed. Every future fee must be (1) server-authoritative, (2) disclosed before confirmation, (3) posted as a **separate ledger posting**, (4) attributed to the correct funded/revenue account, and (5) shown on the receipt. | `lib/money/policy.js` defaults every flow to 0. `MONEY_FEES_BPS` is ignored for all flows until a flow has a separate fee posting wired into the kernel (today only cash-out has one). The preview and the receipt show the fee line. |
| D19 | **Pre-J4 money requests are not retroactively expired.** They are preserved until production has been inspected read-only. New requests use the 7-day expiry policy. | Legacy rows keep `expiresAt = NULL` (proven in the J4 rehearsal). No backfill or expiry job runs on them. |
| D20 | J4 follow-ups are ordinary cleanup: the money-request UI shows the expired and limit states; the merchant UI for creating and showing J4 charge QR codes is completed in J5. The J4 architecture is not reopened unless a regression is found. | Request UI fixed at the start of J5. Merchant charge UI is part of J5 §D. |

## D-J5: Merchant + Business OS (recorded at J5 acceptance)

The J5 gate was accepted **locally**. The code gate is `fa0700c` and the report commit is `025654a`. Nothing is deployed: production is untouched, branch deployments stay disabled, the database deploy step stays inert unless explicitly activated, and the Kebu Supabase project is not touched.

| # | Decision | How it applies |
|---|---|---|
| D21 | **New businesses settle merchant payments into their business wallet.** | `Business.settlementMode` defaults to `business`. |
| D22 | **Existing businesses keep their current owner-personal settlement** until read-only production inspection. **No bulk migration.** | The J5 migration sets existing non-brand businesses to `owner`. Only the owner can switch, one-way. |
| D23 | Kabu's current **platform-wide settlement wallet** (`PARTNER_SETTLEMENT_USER_ID`) is **legacy integration behaviour**, not the desired architecture. | The path is isolated and labelled legacy (J6.0); new mapped businesses never use it. |
| D24 | Kabu merchants mapped through the consented Kabu↔Jokko business mapping **settle to the mapped merchant's business wallet**. | J6.0 settlement recipe. |
| D25 | **Distribution representatives, merchant staff and financial agents are separate authority domains.** Their permissions are never combined implicitly; one role never grants another. | J3/J5 business capabilities vs J6 agent authority; tested adversarially (J6.13). |
| D26 | **J5 Business Lite stays deliberately lighter than Kabu Shop.** Kabu/Shopify is not rebuilt inside Jokko. | Scope guard in the architecture document, §16. |
| D27 | `docs/JOKKO-ECONOMIC-OS-ARCHITECTURE.md` is a **binding architectural constraint** for later phases. | Changing it is a recorded decision. |

## J6: proposed decisions (awaiting acceptance)

These are the choices J6 was built on. They are **not accepted decisions** until the owner says so. Each is reversible without data loss.

| # | Proposal | Why / where |
|---|---|---|
| P-J6-1 | The legacy bearer-QR agent routes (`deposits/agent`, `withdrawals/agent`, `agent/deposits/*`, `agent/withdrawals/*` writes) are **retired (410)**. Their history stays readable. | Whoever held the withdrawal QR could collect the cash (J6 report §0 A1). |
| P-J6-2 | Legacy active agents are **fail-closed** until compliance adopts them (organization + approved service point). No bulk migration; read-only production inspection first (as D22). | `POST admin/agents/:id/adopt`; rehearsal §27. |
| P-J6-3 | **Customer fee 0** for agent cash-in and cash-out (consistent with D18). Agent commissions come only from the funded commission budget. | `lib/agents/commission.js`. |
| P-J6-4 | **No commission rule is active and the budget is 0 by default.** Rates are a finance/business decision, made through the rule + maker-checker machinery. The legacy monthly "prime" estimate stays LEGACY and accrues nothing new. | J6 report §9, risk 5. |
| P-J6-5 | Physical cash is **self-reported only** and never shown as authoritative. | `AgentCashReport`, liquidity view. |
| P-J6-6 | Default cash-network limits (`lib/agents/limits.js`): challenge 15 min; completion window 30 min, then review; customer cash-out 1 000 000 XOF/day and 6/day; standard point 500 000 per operation; business agent required above 500 000. | Configurable, validated `AGENT_CASH_LIMITS_JSON`. |
| P-J6-7 | Unmapped Kabu payments keep the **legacy platform settlement by default**, with a switch (`PARTNER_LEGACY_PLATFORM_SETTLEMENT=false`). Recommended to switch off once Kabu sends `merchant.external_business_id` for every mapped merchant, **after** deciding how Kabu payouts are funded (risk 4). | J6.0. |

## D-J6: Agents & cash network (recorded at J6 acceptance)

The J6 gate was accepted **locally**. The code gate is `9af5009` and the report commit is `2d36dac`. Nothing is deployed: production is untouched, no PR was opened, and the Kebu Supabase project is not touched. The proposals P-J6-1 to P-J6-7 above are superseded by these accepted decisions where they overlap. The rest (P-J6-1, P-J6-3, P-J6-5, P-J6-6) remain as implemented.

| # | Decision | How it applies |
|---|---|---|
| D28 | **Agent commission rates stay inactive at 0.** No economics are invented before real cash-handling and provider economics are known. The funded commission architecture is preserved so finance can later configure and fund legitimate rates. | No active `AgentCommissionRule`; the budget is 0. The rule, funding and clawback machinery stays (J6.7). |
| D29 | **A merchant's funds fund that merchant's ordinary payouts.** Mapped Kabu collections settle to the mapped Jokko business wallet. Mapped merchant-initiated disbursements should ultimately debit that merchant's available business funds through an explicit J2 recipe. The platform wallet funds only genuine platform obligations. **The existing generic Kabu payout path is not migrated yet.** Current payout uses are first classified by economic meaning (merchant disbursement, refund, supplier payment, payroll, affiliate/commission, platform incentive, other) and are not treated as one generic recipe where their accounting differs. Legacy unmapped behaviour stays isolated until inspection and migration. | J7.25 classification (code/schema only, read-only). |
| D30 | **Legacy production agents are adopted only after read-only production inspection.** No service points are invented and no legacy agent is automatically activated. | `POST admin/agents/:id/adopt` stays operator-driven; no bulk adoption. |

## D-J7: Commerce & distribution network (recorded at J7 acceptance)

The J7 gate was accepted **locally**. The code gate is `eb7d7cb` and the report commit is `afc54bb`. Nothing is deployed: production is untouched, no PR was opened, and the Kebu Supabase project is not touched.

| # | Decision | How it applies |
|---|---|---|
| D31 | **The legacy marketplace-based B2B ordering path is no longer the normal path for new B2B orders.** The J7 purchase order is the canonical path for new B2B / wholesale orders. Legacy data is not deleted. Existing legacy orders and their history keep whatever safe completion and read behaviour they need. A compatibility / deprecation boundary stops new B2B activity from creating orders through the weaker legacy lifecycle. Historical records are not migrated unless that is necessary and proven safe. | J8.0: new `channel='b2b'` marketplace orders are refused (`b2b_use_purchase_orders`), with an explicit, default-off compatibility switch. Legacy B2B order read, fulfilment, COD settlement, invoice payment and disputes stay working. |
| D32 | **A read-only production inspection is required before any deployment of the J7 migration**, because legacy invoice and trade-account states may conflict with the new safeguards (J7 report §40.1–2). That inspection is **not** performed until explicitly authorized. | `scripts/forensics/production-exposure.sql` §20 is the prepared read-only query set. |
| D33 | **Jokko Distribution is meant to support real physical distribution at large scale.** The founder's future physical distribution company uses the same neutral infrastructure as every other distributor, with **no hard-coded privileged access**. | No business-id-keyed code path in J7 / J8. Scale claims are limited to what was measured. |

## J8: proposed decisions (awaiting acceptance)

These are the choices J8 was built on. They are **not accepted decisions** until the owner says so. Each is reversible without data loss.

| # | Proposal | Why / where |
|---|---|---|
| P-J8-1 | **Own-fleet and buyer-pickup PO deliveries are tracked by J8 only when the seller opts in** (`tracked: true`). Untracked deliveries keep J7's seller-recorded path, labelled `deliveryRecordedBy: 'seller'`. Making tracking mandatory for every distributor is a product decision, not made here. | `lib/b2b/purchase-orders.js` hand-off; `docs/JOKKO-J8-LOGISTICS.md` §2. |
| P-J8-2 | **Jokko Logistics stays operationally not activated** (`JOKKO_LOGISTICS_ENABLED` unset) until real couriers, an operations desk and a fee are approved. The default rule (local 150 Kori, 80 % to the courier, 24 h hold) is a placeholder for finance to set. | `lib/logistics/fees.js`. |
| P-J8-3 | **COD stays DORMANT** in J8 (no courier cash collection) until a separately authorized cash-collection capability is built on J6 primitives. | §10. |
| P-J8-4 | **A receiver-side failure (absent, refused, closed, bad address) still pays the courier** once the goods are back at the source; an operational failure refunds the sender. | §8.5. |
| P-J8-5 | **Paid courier earnings are not clawed back** by a dispute ruling; only unpaid earnings are reversed (maker/checker). Recovering paid amounts would be a separate, explicit finance process. | `reverseEarningInTx`. |
| P-J8-6 | **No courier handoff after pickup** (re-assignment of goods already in a courier's custody) in J8; such cases go through exception / return. | §6. |

## D-J8: Movement, logistics & fulfilment (recorded at J8 backend acceptance)

The J8 backend was **provisionally accepted locally**, based on the reported local tests, financial and custody invariants, migration rehearsals and security sweeps (report `fa01818`). The product is **not finished** until the internal-pilot gate (UI, 40-merchant scenario, catalogue mapping, legacy exposure) is met. Nothing is deployed. **The delivery-dispute P0 remains OPEN in production.** These decisions supersede P-J8-1 to P-J8-6.

| # | Decision | How it applies |
|---|---|---|
| D34 | **Jokko-managed deliveries use verified tracking and custody.** Seller-managed delivery may stay self-reported, but it is **clearly labelled unverified** and never represented as independent proof. | `poView.deliveryRecordedBy = 'seller_self_reported'`, `deliveryVerified: false`; `'verified_shipment'` / `true` only from a J8 proof. Jokko Logistics is always tracked. |
| D35 | **150 Kori, the 80 % courier share and the 24 h hold are TEST CONFIGURATION ONLY.** Production activation stays disabled until finance approves pricing and settlement rules. | `JOKKO_LOGISTICS_ENABLED` unset ⇒ refused; `lib/logistics/fees.js` labels the defaults as test configuration. |
| D36 | **COD stays disabled.** It is never activated through courier or agent role shortcuts. | `cod_not_activated`; no courier cash path; a J6 agent is not a courier (tested). |
| D37 | **Failed-delivery compensation is configurable and funded, and requires evidence.** A failed attempt is not a completed delivery. Sides are distinguished: receiver (absence, refusal, closed, address), source (merchant fault), courier fault, safety, platform cancellation. The courier's reason is a claim. Compensation is paid only when the side is confirmed (by that side itself, or an operator ruling), at a configured share of the held fee, default **0**. A courier fault never pays. A platform cancellation needs platform funding, which is not built, so it pays 0. | `FEE_RULES.local.failedAttemptBps` (receiver / source only; ≤ courier share); `failure/respond`, `admin/.../failure/rule`; `settleFailedAttemptInTx`. |
| D38 | **Settled courier earnings are not automatically clawed back.** Fraud, overpayments and adjustments require authorized, auditable procedures with financial controls. | Dispute reversal touches unpaid earnings only, via maker/checker; paid earnings are reported as unrecoverable. |
| D39 | **There is no ordinary mid-route handoff in the initial release.** Emergency reassignment (dispatcher or ops, with a reason, audited) must not create duplicate custody or earnings. | The new courier holds nothing until a handoff code bound to them is used. There is one active assignment and one earning per shipment, paid to whoever completes the verified delivery. |
| D40 | **A supplier's product identifiers are never inserted into a buyer's catalogue or stock.** Received units go to the buyer's own product through an explicit mapping. Until then they wait in an unmatched receipt that sits in no stock position. | `BuyerProductMapping`, `UnmatchedReceipt`; invariant L5 reconciles both. |
| D41 | **The legacy open-claim courier marketplace is closed to new usage** (per the J8-completion instruction to address legacy consumer delivery). Historical rows and in-flight obligations are preserved. | `LEGACY_CONSUMER_DELIVERY_ENABLED` (default off). Refused: `POST deliveries` (410), accept / claim of open tasks (410), nearby listing (empty), and hub last mile (409, after authorization). New consumer delivery orders become verified J8 `MERCHANT_FULFILLED` shipments (customer code; no courier fee). Tasks already accepted (fee in escrow) still complete: pickup, deliver, confirm, dispute and operator ruling. |

## D-J8 follow-ups (closed locally at the start of J9)

J8 was accepted as **locally internal-pilot ready** at `1dbb77e`. That is **not** production approval. The three follow-ups below are closed **locally**. Nothing is deployed and no production configuration changed. **The delivery-dispute P0 remains OPEN.**

| # | Decision | How it applies |
|---|---|---|
| D42 | **Rate limits are role- and action-aware, with no blanket bypass.** Each route is classed by its policy key. Reads and dispatch acts get a per-user, per-class budget that throttles with a targeted 429 and never locks the account. Custody codes have their own tight budget (code-guessing protection). Money, credentials and unknown routes keep the strict J3 limiter, whose abuse still earns the account-wide block. Batch endpoints charge one unit per item. | `lib/rate-limit.js` (`actionClass`, `enforceActionBudget`; budgets via `RL_<CLASS>_PER_MIN`, defaults 300 / 300 / 60); `POST logistics/shipments/batch/codes`, `POST businesses/:id/b2b/purchase-orders/batch` (≤ 60 items); `tests/j8/rate-limits.test.js`. The 40-merchant pilot runs without any lockout (`f172eb5`). |
| D43 | **Legacy delivery is inspected read-only before D41 goes live in production.** The query covers open tasks, held escrow, in-flight couriers, disputes, delivered-but-unconfirmed tasks and migration eligibility. It outputs opaque ids and counts only, and never mutates. It runs against production only with correctly authorized access. | `scripts/forensics/legacy-delivery-inventory.sql` (`BEGIN TRANSACTION READ ONLY … ROLLBACK`). Validated on a local DB only (`f696618`). |
| D44 | **Buyer-side return stock is held, never removed on request.** Shipping a return creates a `ReturnStockHold` per product. Sellable units move from the buyer's own mapped product into quarantine (never below zero). Damaged units are bounded by the PO's receiving record, were never credited, and move no stock. The handover is verified (the courier's pickup with the buyer's code) or self-reported (untracked). A cancelled or failed collection releases the hold once, and the return goes back to `approved` for another attempt with its own shipment. Unmapped goods have no stock effect. | `lib/b2b/returns.js`, `lib/commerce/inventory.js` (`return_quarantine` / `return_release`), adapter hooks (`onPickedUp`, j7_return cancel / return-to-source); DB guard `joko_return_hold_guard` (append-only, quantities immutable, state forward only); invariant **L9**; `tests/j8/return-stock.test.js`. Migration `20261015000000_j8_return_stock` is additive and backfills `shipAttempts` for already-shipped returns. |

## J9: proposed decisions (awaiting acceptance)

J9 was built on these choices. They are **not accepted decisions** until the owner says so. J9 money is **off** (`JOKKO_WORK_MONEY_ENABLED` unset), and nothing is deployed. **The production delivery-dispute P0 remains OPEN.**

| # | Proposal | Why / where |
|---|---|---|
| P-J9-1 | **J9 money stays OFF until the P0 is closed and verified, and finance approves the hold periods and the acceptance window.** Test values: 24 h earning hold, 7 days for commissions, an acceptance window of 24–168 h (default 72 h) with auto-accept. | `lib/work/contract.js`; `docs/JOKKO-J9-WORK.md` §4, §8. |
| P-J9-2 | **Contract terms of ≥ 30 h/week for more than 12 weeks are employment** and are refused as contract work. This is a conservative product rule; **counsel must confirm it** against Senegalese labour law. | `assertClassification`. |
| P-J9-3 | **Reclassify legacy cooperative produce payouts.** They are currently recorded as payroll wages (`payroll_out`, auto-created "farmer" employee). Proposed: a dedicated member-produce-settlement kind. This is a finance decision on a live ledger kind. | Audit F2. |
| P-J9-4 | **Affiliate commissions (live, 5 % default, paid at purchase, not reversed on refund):** set the default to 0, or hold until fulfilment and reverse on refund, or retire. This is an owner decision on a live financial rule; nothing was changed. | Audit F4. |
| P-J9-5 | **The platform fee on work stays 0.** Any fee needs a finance decision and a regulatory review: J9 escrow is closed-loop Kori custody. | `PLATFORM_FEE_BPS`. |
| P-J9-6 | **Legacy worker profile:** hide the "réputation pour les prêts" / credit-tier wording until a lender relationship exists, and stop presenting an income + KYC-tier score as reputation. | Audit F3. |
| P-J9-7 | **Minors:** no work under 16. At 16–17 (verified date of birth), non-hazardous work only and no night work; apprenticeships allowed. With unknown age, hazardous work is refused and other work requires an attestation. **Counsel must confirm.** | `assertAgeEligible`. |
| P-J9-8 | **Rep commission:** only on the merchant's first order that was received **and** paid. Ineligible outcomes (self-dealing, unverified receipt) are recorded once and never re-evaluated. An outcome waiting for budget is paid in order once funded. | `lib/work/rules.js`. |
| P-J9-9 | **No automatic clawback of paid work earnings** (as D38). A ruling against an unpaid earning is reversed under maker/checker. A paid earning is reported unrecoverable and goes to a support / legal path. | `reverseEarningInTx`. |
| P-J9-10 | **The cooperative double-payout fix (audit F1) ships as its own small patch after the P0 patch is deployed and verified on `7d262de`.** It is never bundled into the P0 patch, and never deployed from `19ac203`. | `lib/cooperative-service.js`, `tests/j9/coop-payout.test.js`. |
