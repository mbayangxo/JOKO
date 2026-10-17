# Jokko J7: Commerce & Distribution Network (design and inventory)

**Status:** binding design for J7. It extends `JOKKO-ECONOMIC-OS-ARCHITECTURE.md` (D27) and does not replace it.
- Kabu stays the Shopify-class commerce OS.
- Jokko Business Lite stays light.
- J7 adds the **shared trade and distribution infrastructure** between businesses.

## 1. Inventory of existing commerce code (J7.1)

Classes: **1** JOKKO-NATIVE · **2** KABU-OWNED · **3** SHARED INFRASTRUCTURE · **4** ADAPTER/INTEGRATION · **5** LEGACY/DUPLICATIVE · **6** FUTURE/DORMANT.

| Area | Code | What it is | Class | J7 action |
|---|---|---|---|---|
| Consumer marketplace / shop orders | `lib/marketplace-service.js` (`placeMarketplaceOrder`), `lib/commerce/orders.js` (J5 state machine) | B2C order: pay now (or COD) → merchant prepares → pickup/delivery → buyer completes; refunds | 1 | Kept. J7.0 eligibility added. |
| B2B order as a marketplace channel | `channel='b2b'`, `Product.b2bPrice / b2bMinQty`, `validateB2bOrderPayment`, `settleCodOrderPayment` | Immediate / COD / net order paid at placement; **no supplier acceptance step, no lines snapshot of wholesale terms, no available-credit lock** (an unlocked aggregate could overshoot the limit) | 5 | **Kept working**, labelled legacy. Its credit check is now locked under the trade account (J7.9). New B2B work uses the Purchase Order (§2). |
| Trade accounts | `TradeAccount`, `upsertTradeAccount` | Supplier-granted buyer account: term, credit limit, COD, trust tier | 3 | Reused as the only source of terms (J7.8): status, a single granted term, limit. |
| Trade invoices | `TradeInvoice`, `payTradeInvoice`, disputes | Receivable per order | 3 | Reused. **Waive/adjust used to overwrite `amountKori`, erasing history.** They become **credit memos**; the principal is immutable; payments are recorded rows (J7.10). |
| Buyer portal / receivables / brand registration | `getBuyerPortalCatalog`, `getSupplierReceivables`, `registerDistributionBrand`, `seedBrandProducts` | Pre-J7 supplier-side views | 5 | Kept. The J7 wholesale catalog and restock supersede them for new work. |
| Distribution relationships, territories | `lib/business/distribution.js`, `MerchantRelationship`, `Territory` (J5) | Invitation ≠ access; merchant accepts; scopes; reps see own introductions | 3 | Extended: rep assignment, price list, territory availability, analytics. |
| Assisted onboarding | `lib/onboarding/assisted.js` (J6) | Rep introduces, merchant owns | 3 | Feeds the merchant acquisition network (J7.4). |
| Catalog / products | `Product`, `lib/commerce/catalog.js` (J5), `kind` product/service | Retail catalog; gigs are `kind=service` (J5 fix) | 1 | Wholesale listings reference a seller `Product` but are a separate operational catalog (J7.5). |
| Inventory | `InventoryLocation`, `StockMovement` (J5), `Product.inventory` | Store stock + append-only movements | 3 | Depot stock positions per location + reservations (J7.14). |
| Fulfilment / delivery | `lib/delivery-service.js`, hubs, parcels, `CommerceEvent` outbox (J5) | Rider marketplace (consumer orders), hub parcels; outbox for J8 | 3 / 6 | PO fulfilment handoff emits outbox events; Jokko Logistics stays DORMANT (J8). |
| Payment acceptance | `PaymentRecord`, charges (J4/J5) | One canonical record per payment | 3 | PO payments use the same J2 primitives. |
| Kabu | `lib/integrations/kabu.js`, Partner API | Link, payments, payouts | 4 | §4, §7. |
| Mbolo commerce | `mbolo-receipt-service.js`, `mbolo-commerce-service.js` | System-generated payment receipts and tontine cards. Users **cannot** post `commerce`/`payment` kinds (send API allows text/media only). | 4 | §5: charge card adapter. |
| Askaan / Askoo | none in this repository | — | 6 | Contract only (§6). |
| Group purchasing | none | — | 6 | Contract, DORMANT (J7.17). |

Nothing is deleted. Legacy paths keep working and are labelled.

## 2. Canonical commercial contract (J7.2)

Shared primitives:
- **Party:** business or person.
- **Lines:** each a snapshot of item, quantity and server price.
- **Payment:** J2 posting plus `PaymentRecord`.
- **Fulfilment events:** `CommerceEvent`.
- **Receivable:** `TradeInvoice`.
- **Return:** `CommercialReturn`.
- **Stock:** `StockMovement`, `DepotStockMovement`.

Different meanings keep **different state machines**:

| Order kind | Model / state machine | Why separate |
|---|---|---|
| Consumer order | `Order` + `lib/commerce/orders.js` (`pending_payment → confirmed → preparing → ready/out_for_delivery → delivered → completed`, cancel/refund) | Paid up front; buyer is a person; delivery to a home |
| B2B purchase order | `PurchaseOrder` + `lib/b2b/purchase-orders.js` (§3) | Supplier must accept; terms and credit; invoice; receiving by the buyer business; returns as credit memos |
| Wholesale order | B2B purchase order against a `WholesaleListing` (packs, MOQ, tiers) | Same lifecycle as B2B |
| Marketplace order | consumer `Order` with `sourceChannel` | Discovery surface only |
| Kabu ecommerce order | **Reference only** (Kabu is the system of record); Jokko holds the payment and `externalRef` | §4 |
| Mbolo conversational order | Seller-issued charge (server amount) or consumer `Order` referenced from the thread | §5 |
| Manual / POS sale | `PaymentRecord` `cash`/`manual` (off-ledger, J5) | Never Jokko money |

## 3. B2B purchase order (J7.7)

```
draft → submitted → accepted → confirmed → preparing → ready → fulfilment_requested → delivered → received → completed
              ↘ rejected     ↘ (cancelled by buyer before acceptance, or by either side before preparing)
                                       ↘ disputed (buyer, after delivery) → resolved
```

| Transition | Who |
|---|---|
| submit, cancel (before acceptance), receive / dispute | buyer business: `business.purchasing` |
| accept / reject, preparing, ready, request fulfilment, record delivery, cancel (before preparing) | seller business: `business.orders.fulfill` or `business.distribution.manage` |

**Confirmation = payment / term authorization:**
- **due now:** paid from the buyer business wallet at confirmation (J2 B2B transfer);
- **net N:** credit reserved under the locked trade account; invoice issued at delivery.

Delivery is recorded honestly by the seller (`recorded_by: seller`). `jokko_logistics` is refused while J8 is dormant.

## 4. Kabu interoperability (J7.18)

| Flow | System of record | Contract |
|---|---|---|
| Kabu order paid with Jokko | Kabu (order), Jokko (payment) | Partner payment → J2 → webhook (J6.0 per-merchant settlement) |
| Kabu merchant buys from a Jokko supplier | Jokko (PO, invoice) | Kabu-linked business uses Jokko B2B as itself; Kabu may later read the PO by reference (`ExternalLink objectType=purchase_order`, DORMANT) |
| Kabu fulfilment request | Kabu (order) → Jokko Logistics (J8) | DORMANT |
| Kabu merchant in a distribution network | Jokko (relationship) | Same `MerchantRelationship` as any business |
| Kabu payouts | Jokko money, Kabu instruction | §7 |

## 5. Mbolo conversational commerce (J7.19)

Contract:
1. A seller (staff with `business.charges.create`, member of the thread) posts a **charge card**. The card carries only the charge code.
2. The buyer opens the code. Amount and seller come from the server (`GET money/charges/:code`).
3. Payment is `payCharge` with `expectedAmountKori` (J4).

Message text is never authority. Users cannot post `commerce`/`payment` cards.
- **Route:** `POST mbolo/threads/:id/charge-card {code}` (`lib/b2b/mbolo-charge-card.js`).
- **Payload:** `{type: 'charge_card', code, version}` — no amount.
- **Refused when:** the charge is not open, the business is not active, or the sender is not an active thread member with `business.charges.create` on the charge's business.
- **Status:** **ACTIVE** (charge card). Order-from-conversation remains ARCHITECTED.

## 6. Askaan / Askoo marketplace contract (J7.20)

No code exists in this repository. Contract:
- A surface lists **verified, active** sellers (Kabu-linked, Business Lite, distributor or manufacturer) by reference.
- Catalog and availability come from the seller's system of record.
- The order is created in the seller's system (consumer `Order` or `PurchaseOrder`).
- Payment goes through Jokko (J2); fulfilment through the seller or J8; returns through `CommercialReturn`.

Discovery is never the financial system of record. **NOT IMPLEMENTED (contract).**

## 7. Kabu payout classification (J7.25, code/schema only; D29)

**Current path (every Kabu "payout"):**
- **Entry:** `POST /v1/payouts {reference, amount_xof, phone, method, metadata}`.
- **Record:** `PartnerPayout`.
- **Execution:** `executePartnerPayout`.
- **Ledger:** J2 ExternalOperation `direction=out`, `provider=julaya`, account `customer:<PARTNER_SETTLEMENT_USER_ID>:available`; `authorized` holds the ₭, `failed` releases once, `confirmed` retires.
- **Idempotency:** `partnerId + reference` unique, plus same amount and phone.
- **Authorization:** partner key only.
- **Purpose:** the request carries **no purpose, no merchant, no original payment**. Every economic meaning below collapses into "platform wallet → a phone".

| Economic meaning | Current funding | Intended debtor | Recipient | Correct recipe (proposal, not migrated) |
|---|---|---|---|---|
| Merchant disbursement (withdrawal) | platform wallet | the merchant | merchant's own phone / bank | `business:<id>:wallet` → hold → provider out; authority: Kabu staff instruction mapped to J3 `business.treasury` |
| Refund to a Kabu customer | platform wallet | the merchant | the original payer | Refund of a specific partner payment (≤ collected − already refunded): business wallet → provider out to the payer, linked to the payment reference |
| Supplier payment | platform wallet | the merchant | supplier | Supplier on Jokko → J7 PO / invoice payment (B2B transfer); otherwise business wallet → provider out |
| Payroll | platform wallet | the merchant | employee | J5 payroll boundary (`business.pay`) → business wallet → employee wallet or provider out |
| Affiliate / commission | platform wallet | merchant (or platform for platform programs) | affiliate | Merchant-funded: business wallet → affiliate. Platform program: funded incentive budget only |
| Platform incentive | platform wallet | platform | user | `incentives:funded` budget (J2), never a merchant's funds |
| Other / unknown | platform wallet | — | — | Refused until classified |

**Recommendation:**
1. Add `purpose` and `merchant.external_business_id` to `/v1/payouts`. Reject unknown purposes for mapped merchants.
2. Implement one J2 recipe per purpose, starting with merchant disbursement and refunds. A business-held account (`business:<id>:held`) is required for provider outflows from a business wallet.
3. Keep the unmapped generic path legacy and isolated until production inspection. **No migration in J7.**

## 8. Route-to-market and data boundaries (J7.24)

```
manufacturer Product → WholesaleListing (distributor, with commercial rights)
  → eligible merchants (relationship + territory + price list)
  → restock / pre-order (PurchaseOrder)
  → demand aggregates (k-anonymous) → allocation (depot stock reservations)
  → fulfilment (seller / J8) → receivable (TradeInvoice) → reorder suggestions
```

OpportunityOS / Foundry / IAWIC consume only:
- **events:** `CommerceEvent` types `po.*`, `invoice.*`, `return.*`, `listing.*`;
- **aggregates:** `demandAggregates`, `wholesaleDemandAggregates`.

They never read raw rows. None of them is built in J7.

## 9. Group purchasing (J7.17) — DORMANT

No code. Contract for a future build:
- **Pool:** a time-boxed, supplier-approved pool on one `WholesaleListing` with a target quantity and a tier price.
- **Pledges:** each merchant pledges a quantity. **No money is collected at pledge time.**
- **Pool fills:** each member gets its **own** `PurchaseOrder` at the pool price. Each PO uses the member's own terms and credit, and is invoiced to that member only.
- **Pool fails:** nothing moves.

Why it is not built:
- There is no pooled escrow and no shared liability.
- One member's default is never another member's debt.
- A pool with money held in common would be a new financial product (a decision for the founder and BCEAO strategy).

## 10. Demand intelligence privacy (J7.21)

The J5 consumer `demandAggregates` uses k = 5 businesses. J7 wholesale aggregates are stricter.

- **Rule:** a category × region cell is published only with **≥ 10 distinct buyer businesses AND ≥ 3 distinct sellers**.
- **Why stricter:**
  - B2B volumes are commercially sensitive.
  - With one or two sellers in a cell, the aggregate would reveal that supplier's sales to its competitors.
  - Ten buyers keep a single shop's purchasing out of reach.
- **Never in the output:** business, merchant, rep or listing ids, prices, or terms.
- **Access:** internal function only, no route. A future route would be operator-only, `finance_ops`/`risk`, with the same thresholds.

## 11. Neutral infrastructure (J7.23)

No supplier, distributor or Jokko-affiliated distribution company has special access.
- Every supplier uses the same capability checks, relationship gate, pricing function, credit lock and analytics scope.
- No code path is keyed to a specific business id.
- Scale is tested at 2,000 relationships per distributor: cursor pages of 200, index scan.
  - Larger volumes have not been load-tested and are not claimed.

## 12. J7 API map (all under `businesses/:id/b2b/`; `:id` is the acting business)

| Area | Routes |
|---|---|
| Seller catalog | `GET/POST listings`, `POST price-lists`, `POST relationships/:rid/configure` |
| Network | `GET relationships` (cursor), `POST territories/:tid/reps`, `GET rep-summary`, `GET analytics` |
| Depot | `GET/POST depots/:locId/stock`, `GET depots/:locId/movements` |
| Restock (buyer) | `GET suppliers`, `GET suppliers/:sid/catalog`, `GET suppliers/:sid/reorder`, `POST quote` |
| Purchase orders | `GET/POST purchase-orders`, `GET purchase-orders/:po`, `POST purchase-orders/:po/{accept,reject,pay,advance,buyer,resolve,cancel,returns}` |
| Invoices | `GET invoices`, `GET invoices/:inv`, `POST invoices/:inv/pay`, `POST invoices/:inv/credit-memos` |
| Returns | `GET returns`, `POST returns/:ret/{decide,ship,receive,resolve}` |

App: `src/screens/RestockScreen.js` (Business hub → "Réapprovisionner").
