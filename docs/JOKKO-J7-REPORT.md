# Jokko J7 gate report: Commerce & distribution network (local)

Branch `claude/jokko-forensic-audit-rprqia`, on the accepted J6 head (`9af5009` code, `2d36dac` report; decisions D28–D30 in `f326760`).

**Scope and limits.**
- Built and proven **locally only**. Nothing was deployed and no pull request was opened.
- Production is untouched: no production row was read or changed. The Kebu Supabase project was not touched.
- The database deployment step stays inert (`db-migrate-deploy.mjs` exits 3).

**Verdict:** GATE_VERDICT

Design and inventory: `docs/JOKKO-J7-COMMERCE.md` (binding; extends `JOKKO-ECONOMIC-OS-ARCHITECTURE.md`).

**Problems found in existing code and fixed during J7** (none was a new P0; none created or destroyed money):

| # | Finding (pre-J7) | Severity | Resolution |
|---|---|---|---|
| F1 | A suspended / closed business kept receiving money on most paths. Only some checked `Business.status`, and none checked it inside the money transaction. | P1 (compliance control bypass) | One policy, `lib/business/eligibility.js`, share-locks the business **inside** every acceptance transaction (§1). |
| F2 | **Legacy B2B net / COD orders checked the credit limit outside the order transaction**, against an unlocked aggregate. Concurrent orders could overshoot the supplier-granted limit. | P2 (supplier credit overshoot; no money created) | Re-checked under the (supplier, buyer) trade lock inside the order transaction. 8 concurrent orders on one limit → exactly 3 (`tests/j7/legacy-credit.test.js`). |
| F3 | **Dispute "waive" / "adjust" overwrote `TradeInvoice.amountKori`**, erasing what was invoiced. | P2 (audit history erased) | Corrections are `CreditMemo` rows. The principal is immutable (DB trigger), and invoices are never deleted. |
| F4 | Invoice payments left no per-payment record, and a duplicate ledger reference was not refused at invoice level. | P3 | `TradeInvoicePayment` rows (unique ledger reference, append-only). `amountPaid` reconciles with them. |
| F5 | Deactivating a trade account was unattributed (`active=false` only). | P4 | `revokedAt` / `revokedBy`; a revoked account grants nothing, including to orders reserved before the revocation. |

---

## 1. J7.0 — business suspension hard gate (gate item 1)

**One policy:** `assertBusinessCanReceive(tx, businessId, purpose)`.
- It share-locks the `Business` row (`FOR SHARE`) inside the money transaction.
- A concurrent `POST admin/businesses/:id/status` (row-locked UPDATE) either commits first, and the payment is refused, or waits until the payment commits.
- Money is never redirected: a refused payment does not happen.

| Acceptance purposes (refused unless `active`) | Restitution purposes (always allowed) |
|---|---|
| `merchant_payment`, `voucher_redemption`, `charge`, `order_payment`, `marketplace_payment`, `b2b_payment`, `invoice_payment`, `capital_in`, `partner_settlement`, `channel_adapter` | `refund`, `reversal`, `return_credit`, `remediation` |

**Enforcement points:**
- merchant pay (business wallet, and legacy owner-personal settlement);
- Kori merchant spend;
- vouchers;
- QR charges: creation and payment;
- marketplace / consumer orders (paid, COD, net);
- B2B transfers (recipient);
- owner capital-in;
- invoice payments;
- school fees;
- ticket sales;
- held-transaction execution (payloads from before J7 are checked against the owner's businesses);
- Kabu bound-merchant validation;
- J7 purchase orders (submit and pay);
- the Mbolo charge card.

`BusinessIneligibleError` → `409 business_inactive` on every route.

**Not blocked:**
- refunds, reversals and returns to a business that was the buyer;
- owner withdrawal, payroll and outgoing B2B (freezing outflows is the separate account-freeze control).

**Evidence** (`tests/j7/suspension.test.js`, 5):
- every path refused, wallet and legacy owner settlement, with nothing moved or redirected;
- refund and owner draw still work while suspended;
- a held payment approved after suspension is refused;
- **12 concurrent payments racing a suspension: each either completes fully or is refused, and totals reconcile**;
- the policy table.

Also covered: a suspended supplier takes no PO and no PO payment (`po-lifecycle`), and a suspended **buyer** still receives its refund (`adversarial`).

## 2. Existing-commerce inventory and classification (item 2)

`JOKKO-J7-COMMERCE.md` §1 classifies every commerce area 1–6:
- consumer orders = 1;
- B2B-as-marketplace-channel = 5 LEGACY (kept working, credit now locked);
- trade accounts / invoices = 3;
- distribution = 3;
- catalog = 1;
- inventory = 3;
- delivery = 3 / 6;
- Kabu = 4; Mbolo = 4;
- Askaan / Askoo = 6; group purchasing = 6.

Nothing was deleted and no system was duplicated. Business Lite keeps its J5 scope.

## 3. Canonical commercial contract (item 3)

The shared primitives are Party, Lines (server-priced snapshots), Payment (J2 + `PaymentRecord`), Fulfilment events (`CommerceEvent`), Receivable (`TradeInvoice`), Return (`CommercialReturn`) and Stock movements (§2 of the design doc).

The order kinds keep **separate state machines**: consumer `Order` (J5) and B2B `PurchaseOrder` (J7). Kabu orders are by reference only; manual / POS sales are off-ledger records.

## 4. Distributor operating model (item 4)

Distributor (`operatingMode` distribution / wholesale / manufacturer) → territories → depots (`InventoryLocation`) → reps → merchant relationships → wholesale catalog → price lists → order intake (PO) → fulfilment handoff → delivery record → collections (invoice payments) → returns → reconciliation (depot movements; invoice payments and memos).

- A distributor can itself be the buying side of a relationship with a manufacturer: roles are per relationship.
- Managing thousands of relationships uses cursor pages (§33).
- None of it gives the distributor ownership of, or open access to, a merchant (§5, §27).

## 5. Merchant acquisition and consent (item 5)

The J5/J6 rule is unchanged:
- A rep invites or assists, and records the territory and source.
- The merchant owns its account, accepts, and can end the relationship.
- An invitation is not access; an `invited` relationship cannot order (adversarial test).

J7 adds `assignedRepUserId` (operational): a rep sees relationships they **introduced or were assigned**, never every merchant in a territory.

**Rep evidence** (`network-privacy` test 1): 18 private endpoints were tried on the distributor and on the merchant, and none answered 2xx. They cover:
- wallets, business money, payroll, customers, analytics;
- the supplier's sales and invoices, listings management;
- the merchant's orders, POs, invoices, suppliers and catalog;
- trade accounts.

Also from that test:
- Relationship cards carry no money or contact data.
- A rep cannot accept POs or assign themselves to territories.
- The rep summary returns counts only.
- A removed rep gets nothing.

## 6. Wholesale catalog (item 6)

`WholesaleListing` carries:
- SKU, unit / pack / case, units per pack;
- base price per ordered pack, quantity tiers (`WholesalePriceTier`), MOQ and step;
- availability (available / limited / preorder / out_of_stock);
- territory list, depot, optional reference to the seller's `Product`;
- effective dates, status.

Visibility: **only** businesses with an active relationship carrying the `wholesale_catalog` scope, filtered by territory and effective dates. There is no storefront, theme or merchandising (Kabu's domain).

## 7. Server-authoritative pricing (item 7)

There is one pricing function, `priceFor`: relationship price list > best quantity tier > base. Quote and submit both use it.

The client sends listing ids and pack counts, plus the total it was shown (`expectedTotalKori`). A mismatch is `409 price_changed`, with the server total returned.

**Tested manipulations, all refused:**
- a client unit-price field (strict schema → 400);
- a forged total → 409;
- a forged price-list price from a buyer without that list → 409;
- below MOQ, wrong step;
- out of stock, inactive listing;
- another supplier's listing, and a listing outside the buyer's territory → 404;
- a self-granted term → `term_not_granted`;
- a wrong payment amount → `amount_mismatch`.

Currency is ₭ throughout. No tax or fee applies to B2B POs in J7, and none is invented.

## 8. B2B purchase-order lifecycle (item 8)

```
quote (draft, not persisted) → submitted → accepted | rejected
accepted → (due now: buyer pays) → confirmed      submitted → confirmed directly for a granted Net term (credit reserved at submit)
confirmed → preparing → ready → fulfilment_requested → delivered (seller-recorded) → received (buyer) → completed
cancel: buyer before acceptance (or accepted-unpaid); seller before preparing (refunds a paid order)
dispute: buyer after delivery → resolved by the seller (corrections = credit memos / returns)
```

**Every transition** runs in one transaction:
- the PO row is locked;
- the actor's business authority is re-checked in the transaction;
- the status update is conditional, so a concurrent duplicate gets `409`;
- an append-only `PurchaseOrderEvent` is written;
- a `CommerceEvent po.<status>` goes to the outbox.

**Buyer and seller actions are distinct and side-checked:**
- The buyer cannot accept or advance its own order, and the seller cannot receive it.
- Payment confirms but never delivers: `deliveredAt` stays null until the seller records delivery.
- The full lifecycle history is asserted in `po-lifecycle` test 1.

**Authority:**
- **Buyer:**
  - `business.purchasing` to submit and receive;
  - `business.pay` (plus step-up) to pay;
  - `business.pay` also to **commit the business to Net credit** (an inventory clerk cannot).
- **Seller:**
  - `business.orders.fulfill` or `business.distribution.manage` to accept, advance and resolve;
  - `business.orders.cancel` to cancel;
  - `business.refund` when the cancellation refunds money.

## 9. Trade accounts and terms (item 9)

- **Terms:** Due now, or Net 7 / 15 / 30 / 60 / 90, and **only** the single term the supplier granted on its `TradeAccount`. Due now is always available.
- **Account conditions:** active, not revoked, limit > 0.
- **The model tracks:**
  - TradeAccount, CreditLimit, AvailableCredit (limit − exposure);
  - Invoice, Terms, DueDate;
  - Receivable / Outstanding (principal − paid − credited);
  - Payment (`TradeInvoicePayment`), CreditMemo;
  - PastDue (`pastDue` flag, past-due filter, analytics);
  - Dispute (PO and invoice).
- **Jokko never lends:** no Jokko money is advanced, and financing stays DORMANT.

## 10. Credit concurrency (item 10)

- **Exposure** = outstanding invoices + credit reserved by open POs.
- **Lock:** every change runs under `lockTradeExposure` — an advisory lock on (supplier, buyer) plus `FOR UPDATE` on the account row.
- **At delivery** the reservation turns into the invoice, so exposure is unchanged and never double-counted.

| Attack | Result |
|---|---|
| 8 concurrent Net-30 POs × 3,000 on a 10,000 limit | exactly 3 accepted, the rest `credit_limit_exceeded` (`trade-credit`) |
| same on the legacy channel | exactly 3 (`legacy-credit`) |
| order racing a limit reduction | never above the new limit |
| revoke during submit | serialized; a reservation made before revocation cannot be accepted (`term_revoked`) |
| duplicate order (10 concurrent submits, one idempotency key; later retry after "app restart") | one PO, one reservation |
| invoice paid twice concurrently (1,500 + 1,500 on 1,500 outstanding) | one 200, one 409 |
| invoice payment retry with the same key | replays, nothing moves |
| credit memo twice (same reference, 3 concurrent) | one memo, two replays |
| two memos racing the outstanding | only one fits; paid + credited ≤ principal (also a DB trigger) |
| cancel restoring credit twice (concurrent cancels) | one 200, one 409; reservation released once |

## 11. Invoices and receivables (item 11)

`lib/b2b/invoices.js`:
- An invoice is issued per delivered Net PO, idempotently (`INV-<po>`), with the due date from the term.
- Payments are partial-capable and recorded as rows.
- Credit memos (dispute waive / adjust, return credit, correction) are records.
- **DB guards:**
  - an invoice cannot be deleted;
  - principal, parties and reference are immutable;
  - paid + credited ≤ principal;
  - payment and memo rows are append-only.
- The buyer's business pays from its wallet (`POST b2b/invoices/:id/pay`, `business.pay` + step-up + idempotency key).
- Legacy personal / KEBU invoice payment keeps working and now writes payment rows.
- Every outstanding computation (summary, receivables, reminders, admin ops, scores) is net of credits.

## 12. Restock workflow (item 12)

- **API:** `GET b2b/suppliers` returns connected suppliers, the terms granted, available credit, open orders, and whether the supplier is accepting. Then catalog → quote → submit → pay / receive.
- **App:** `src/screens/RestockScreen.js` (Business hub → "Réapprovisionner"). It is one screen, phone-first:
  - large steppers that honour MOQ / step;
  - the server total and the granted terms, with no images;
  - one idempotency key per order for every retry;
  - step-up only to pay;
  - "price changed" sends the user back to the quote.
- Whether it works is proven through the API tests. The screen itself was parse-checked and built (web export, §38). It was **not** exercised on a device.

## 13. Reorder foundation (item 13)

`GET b2b/suppliers/:id/reorder` works from **the merchant's own delivered purchase history** with that supplier over 180 days.

- **Suggestion rule:** a listing needs ≥ 2 deliveries, and the time since the last one must be ≥ 80 % of the average interval.
- **Quantity:** the average number of packs, rounded to the MOQ / step.
- **Evidence:** order count, average packs, average days between, days since last.
- **Confidence:** at most "medium" (low below 4 orders).
- `autoOrder: false`. It is proven that a suggestion creates no order.

**Shelf-stock signal ("stock appears low based on recorded sales"): NOT ACTIVATED.** No mapping exists from a wholesale listing to the merchant's own shelf product, and inventing one would be false certainty (dormant register).

## 14. Territory permissions (item 14)

Territories are operational:
- They decide which listings are offered where: a listing for territory T1 is invisible and unorderable from T2.
- They record which reps cover them (`TerritoryRep`).

Assigning a rep to a territory gives them **no** merchant data (tested). Only distributor managers can assign reps; a rep cannot assign themselves.

## 15. Depots and stock (item 15)

`DepotStock` holds `onHand` / `reserved` per (location, product), with a DB check: `onHand ≥ 0`, `0 ≤ reserved ≤ onHand`.

**Movements** (`receive`, `adjust` — which needs a reason — `reserve`, `release`, `dispatch`, `return_restock`) are append-only rows in the same transaction, under `FOR UPDATE`. They sum exactly to the position (asserted).

**Timing:**
- stock is reserved at acceptance;
- released at cancellation, once;
- decremented at dispatch, once (concurrent dispatch → one 200, one 409).

**Oversell race:** 6 concurrent acceptances × 30 units against 100 in stock → exactly 3; the rest `insufficient_stock`. The retail shelf (`Product.inventory`) is not touched.

## 16. Fulfilment handoff (item 16)

`ready → fulfilment_requested` records the mode and emits `fulfillment.requested`, the outbox contract for J8:

| Mode | Status |
|---|---|
| `seller_delivery` | ACTIVE |
| `buyer_pickup` | ACTIVE |
| `third_party` | ACTIVE (outside Jokko) |
| `jokko_logistics` | **DORMANT** — refused with `fulfilment_not_activated` |

Delivery is recorded by the seller and labelled `deliveryRecordedBy: seller`. Jokko never claims a delivery. Receipt is the buyer's own act.

## 17. Returns (item 17)

```
requested → approved | rejected → goods_returned → received → resolved
```
- **Amounts** come from the PO snapshot.
- **Quantities** are ≤ ordered minus earlier non-rejected returns (checked under the PO lock).
- **Restock** happens **only** when the seller confirms receipt of the goods, and only once (concurrent receive → one 200, one 409).

**Resolution:**
- a credit memo on the PO invoice (≤ outstanding); or
- a refund of money **actually paid**, never more than paid minus earlier return refunds; or
- none, with a reason.

**Proven:**
- no restock and no refund before the goods are back;
- refund once under concurrency;
- refund without payment refused (`refund_exceeds_paid`);
- the memo applied once;
- a rejected return is final;
- no return before delivery.

## 18. Group purchasing (item 18)

**DORMANT.** The contract is in the design doc §9: per-member POs at a pool price, no pooled money, and no shared liability. Activation is a product / regulatory decision.

## 19. Kabu interoperability (item 19)

By reference (§4 of the design doc):
- Kabu stays the system of record for its orders.
- A Kabu-linked business uses J7 B2B as itself.
- Fulfilment requests and PO read-by-reference stay DORMANT.

No Kabu order is mirrored.

## 20. Mbolo commerce (item 20)

**ACTIVE:** the seller charge card, `POST mbolo/threads/:id/charge-card`.
- The payload holds the code only; the amount comes from the server.
- Only staff with `business.charges.create` who are active thread members can post it.
- It is refused for a non-open charge or an inactive business.

Tested:
- A chat message saying "on a dit 200 ₭" changes nothing: paying 200 is refused, and only the server amount (1,200) is paid.
- The buyer cannot post commerce cards.
- Staff outside the thread cannot post.

Order-from-conversation: ARCHITECTED.

## 21. Askaan / Askoo (item 21)

**NOT IMPLEMENTED.** There is no code in this repository. The contract is in the design doc §6: discovery by reference, the seller's system of record, Jokko for payment, and returns via `CommercialReturn`.

## 22. Demand-intelligence privacy (item 22)

The design doc §10 records the reconsideration of k = 5 for B2B. `wholesaleDemandAggregates` publishes a category × region cell only with **≥ 10 distinct buyers AND ≥ 3 distinct sellers**.

- **Why stricter than consumer demand:**
  - few-seller cells would reveal one supplier's volumes;
  - ten buyers keep one shop's purchasing out of reach.
- **Never in the output:** ids, prices or terms.
- **Access:** internal function only, no route. `k < 10` is refused.

**Re-identification attempt (tested):**
- with 9 buyers the cell is suppressed;
- with 10 buyers it is published as counts only.

## 23. Distribution analytics authorization (item 23)

`GET b2b/analytics` returns relationships by status, POs by status, top listings, and receivables (outstanding / past due). Scope:
- the supplier's own trade only;
- `business.distribution.manage` or `business.analytics.read`.

**Attacked:** another supplier, a buyer, and a rep all got 403/404. The output has no merchant identifiers (asserted). `GET b2b/rep-summary` returns counts of the rep's own book only.

## 24. Physical-distribution-company compatibility (item 24)

The infrastructure is neutral (design doc §11). No code path is keyed to a business id, and every distributor goes through the same capability, relationship, pricing, credit and analytics code.

A future Jokko-affiliated distribution company would be one more `distribution` business with its own relationships, and would get no special access.

## 25. Route-to-market architecture (item 25)

Design doc §8 traces the flow: manufacturer product → listing → eligible merchants → restock / PO → aggregates → depot reservations → fulfilment → receivable → reorder.

- **Boundaries for OpportunityOS / IAWIC:**
  - outbox events `po.*`, `invoice.*`, `return.*`, `listing.*`, `fulfillment.requested`;
  - k-anonymous aggregates.
- None of OpportunityOS / IAWIC is built.

## 26. Kabu payout classification (item 26)

Code and schema only; production was not inspected (design doc §7). Every Kabu "payout" today:
- comes from `/v1/payouts`;
- is funded from the platform settlement wallet;
- carries no purpose, merchant or original payment;
- is authorized by the partner key alone.

**The table classifies each economic use:** merchant disbursement, refund, supplier payment, payroll, affiliate / commission, platform incentive, and other. For each it gives the intended debtor, recipient and proposed recipe.

**Recommendation:**
- add a `purpose` and the merchant id;
- one J2 recipe per purpose (disbursement and refunds first, from `business:<id>:wallet` via a new `business:<id>:held`);
- unknown purposes refused for mapped merchants;
- the legacy path kept isolated.

**No migration** (D29).

## 27. Commerce privacy attack results (item 27)

`tests/j7/network-privacy.test.js` (7) plus the sweeps (§31). Horizontal attempts, all 403 / 404:

| Direction | Attempts |
|---|---|
| merchant ↔ merchant | other buyer's PO, invoice, invoice payment, receive, return |
| supplier ↔ supplier | other supplier's PO (both ids), credit memo, analytics, relationship configure |
| distributor ↔ merchant | the supplier reading the merchant's buyer-side POs, suppliers list, wallet |
| rep ↔ merchant | §5 (18 endpoints) |
| buyer ↔ buyer | negotiated price never shown to another buyer, not even as a number in the payload |
| unconnected business | catalog, quote, PO by id |

A buyer cannot change its own price list. Kabu-linked businesses are ordinary businesses on the same code path; no separate case exists.

## 28. Adversarial lab (item 28)

| Case | Where | Result |
|---|---|---|
| suspended business accepts payment | suspension, po-lifecycle | refused, nothing moves |
| forged price / MOQ / term / self-granted Net 90 | po-lifecycle, trade-credit | refused |
| credit overspend + concurrency | trade-credit, legacy-credit | exact |
| duplicate PO / invoice payment / memo | adversarial, trade-credit | once |
| catalog tampering by another business | mutation sweep (`businesses/:id/b2b/listings`) | refused |
| distributor / rep reads | network-privacy | refused |
| fake / replayed / ended / invited relationship | adversarial | refused |
| relationship ended racing a submit | adversarial | all-or-nothing |
| removed rep | network-privacy | nothing |
| revoked terms | trade-credit | refused, including reserved orders at acceptance |
| depot oversell | po-lifecycle | exact |
| double decrement / double restore | adversarial, po-lifecycle | once |
| refund without payment | returns | refused |
| return double restock | returns | once |
| seller substitution (another supplier's listing) | po-lifecycle | 404 |
| Mbolo text as authority / card forgery | mbolo-charge-card | refused |
| cross-business order access | network-privacy, sweeps | refused |
| PII / wholesale-price leaks | network-privacy, data-exposure sweep | none |
| demand re-identification | network-privacy | suppressed |
| timeout / retry, response loss, app restart | adversarial (same key, later retry), trade-credit (invoice pay replay), po-lifecycle (pay replay) | replay, no second effect |
| concurrent transitions | accept vs cancel, double cancel, double dispatch, double receive, double resolve | one wins, state consistent |
| seller without funds asked to refund | adversarial | fails atomically; PO stays confirmed / paid |

## 29. Concurrency and destruction results (item 29)

All concurrency cases above end in an exact final state. **The DB refuses all of these:**
- deleting an invoice or a PO;
- rewriting an invoice principal or PO totals;
- updating or deleting PO events, lines, payments, memos or movements;
- over-reservation.

## 30. J2 money invariants (item 30)

`assertInvariants` runs after **every** test in all J7 money suites. `money:check` runs on the gate database after the full suite and again after load / sweeps (§34).

## 31. J3 authorization sweeps (item 31)

- **Coverage:** 36 new routes, each with a policy; the permission matrix was regenerated (528 routes).
- **Data-exposure sweep:** new candidates for foreign POs and invoices (as buyer **and** as seller), supplier relationships and depots.
- **Mutation sweep:** sources for POs, invoices, returns, relationships, territories and depots, from both sides.
- **Limitation:** strict request bodies make some sweep calls stop at validation (400). Authorization on those routes is proven by the dedicated horizontal tests (§27).

## 32. J4 / J5 / J6 regressions (item 32)

The full suite (§34) includes every earlier phase. The J4 idempotency middleware now also covers PO submit, pay and cancel, invoice pay, and return resolve.

## 33. Load and scale (item 33)

- **Load:** `test:load` result in §34.
- **Scale:** 2,000 relationships for one distributor page through `GET b2b/relationships` in 10 cursor pages of 200, with no duplicates and a bounded time. The query plan uses an index (asserted). A rep sees only their 7.
- **Not claimed:** tens of thousands of relationships have not been load-tested.

## 34–38. Fresh-database gate (items 34–38)

GATE_TABLE

## 39. Dormant capability register (item 39)

| Capability | Status |
|---|---|
| Jokko Logistics fulfilment mode | DORMANT (J8), refused |
| Group purchasing | DORMANT (contract) |
| Askaan / Askoo adapter | NOT IMPLEMENTED (contract) |
| Mbolo order-from-conversation | ARCHITECTED |
| Kabu PO read-by-reference, Kabu fulfilment requests | DORMANT |
| Reorder from shelf stock / recorded sales | NOT ACTIVATED |
| Wholesale demand feed to OpportunityOS / IAWIC | internal function only, consumer DORMANT |
| Trade-credit financing / receivables financing | DORMANT (no Jokko lending) |
| Kabu payouts by purpose | ARCHITECTED (classification + recipes), not migrated |
| Routes / collection rounds | DORMANT (J8) |
| Taxes / fees on B2B POs | NOT IMPLEMENTED (none charged) |

## 40. Unresolved risks (item 40)

1. **Pre-J7 overwritten invoices.** Invoices where `amountPaid > amountKori` (created by the old "waive" overwrite) satisfy the migration, but the new guard will refuse any **later update** of those rows.
   - The rehearsal seeds one and counts it.
   - The read-only exposure pack (§20 of `production-exposure.sql`) counts them in production.
   - **Inspect before deploying the J7 migration.** No production read was done.
2. **Legacy accounts already over their limit** (from the old unlocked race) are counted by the same pack. Such buyers simply cannot take new credit; nothing is clawed back.
3. **Legacy B2B channel orders** still settle through the pre-J7 flow: no supplier acceptance, and payment at placement. They are LEGACY; new B2B should use POs. Retiring the channel is a product decision.
4. **Restock screen** has not been exercised on a device (API-proven only).
5. **Sweep depth:** strict bodies stop some generic sweep calls at validation (§31). The dedicated tests cover authorization.
6. **Scale** beyond 2,000 relationships per distributor is not measured.

## 41. Exact commits (item 41)

COMMITS_TABLE

## 42. Recommendation for J8 Movement & Logistics (item 42)

Build J8 as the **consumer** of the J7 / J5 outbox, never inside order or payment handlers:

1. **Fulfilment request intake.**
   - `fulfillment.requested` events (PO and consumer orders) create a `Shipment` owned by J8.
   - Activate the `jokko_logistics` mode only when a real operator (Jokko or a contracted carrier) can accept.
2. **Physical custody chain.**
   - Pickup at a depot (`DepotStockMovement dispatch`), then in-transit, then handover.
   - Proof of delivery is signed by the **receiver's** authenticated act (the same pattern as the buyer's `receive`).
   - A courier's word alone is not proof.
3. **Carrier economics.** Delivery fees are a J2 recipe: buyer or seller pays into escrow, released on proof, refunded on failure. Reuse the J5 delivery-escrow lessons.
4. **Routes and collections.** Route planning uses territories and depots as inputs only. Cash-on-delivery collections reuse the J6 cash-network controls (bound agent / courier, PIN, held funds) rather than bearer tokens.
5. **Kabu fulfilment by reference** through the Partner API, with status webhooks back to Kabu.
6. **Before J8:**
   - decide whether legacy B2B channel orders are retired in favour of POs;
   - run the read-only J7 exposure checks (§40.1–2) on production.
