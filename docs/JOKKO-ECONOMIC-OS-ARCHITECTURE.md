# Jokko Economic OS: permanent architecture

**Status:** permanent reference. Every phase (J5 onward) must stay consistent with it. Changing it is a recorded decision, not a side effect of implementation.

**Naming.** "Kabu" (Kabu Business / Kabu Shop) is the full commerce operating system. Existing code and the Partner API spell it **Kebu / KEBU** (`kebuId`, partner id `kebu`, "KEBU wallet"). These are the same system. Code identifiers are not renamed, to keep data and integrations stable.

---

## 1. What Jokko is, and what it must not be reduced to

Jokko is the **economic operating system** of a network of people, businesses and collectives. It is not a wallet app, a marketplace or a POS product, even though it contains all three.

It connects the whole chain below, so that value created anywhere in it can be paid, moved, financed, produced, delivered, owned and reinvested inside the network.

```
Individual → Worker → Business → Merchant → Supplier → Distributor → Manufacturer
→ Cooperative → Tontine / Collective Capital → Project → Investment (IAWIC)
→ Production → Marketplace → Logistics / Fulfilment → Customer → Revenue
→ Ownership / Distribution of returns → Reinvestment
```

| Link | What Jokko provides | Status |
|---|---|---|
| Individual | Identity (J3), wallet (J2/J4), P2P, requests, cash-in/out | ACTIVE |
| Worker | Payroll receipt, worker identity, couriers/agents trust | ACTIVE (payroll, couriers, agents) |
| Business / Merchant | Business identity, staff roles, business wallet, Business Lite operations | ACTIVE (J5) |
| Supplier / Distributor | Distribution mode, territories, reps, merchant relationships, B2B ordering, trade accounts, invoices | Relationships ACTIVE (J5); routes / collections / returns DORMANT (J7/J8) |
| Manufacturer | Same business identity in manufacturer mode; product identity mapping | ARCHITECTED |
| Cooperative | Cooperative business type, member deliveries, payouts | ACTIVE (legacy feature, J2 money) |
| Tontine / Collective capital | Tontines with consent + escrow (J1/J2) | ACTIVE |
| Project → Investment (IAWIC) | Legacy Kebu investments preserved (D7); no new investment flows | PRESERVED / DORMANT |
| Production | Demand intelligence boundary feeding OpportunityOS | ARCHITECTED (aggregates only) |
| Marketplace | Discovery and orders (Askaan/Askoo surfaces); seller of record stays canonical | Jokko marketplace ACTIVE; Askaan adapter DORMANT |
| Logistics / Fulfilment | Order/fulfilment contracts and outbox events; local courier marketplace | Courier marketplace ACTIVE; Jokko Logistics / Fulfilment DORMANT (J8) |
| Customer → Revenue | Payments into business wallets, receipts, refunds | ACTIVE |
| Ownership / Distribution → Reinvestment | Payroll, cooperative payouts, tontine payouts, (future) dividends | Partial ACTIVE; dividends DORMANT |

The rule for every phase: **build the link you need without cutting the chain.** No implementation may hard-code an assumption that blocks a later link. Examples of such assumptions: a business is one shop, money is one person's, an order lives in one system, stock sits in one room.

## 2. Systems and their boundaries

| System | Is | Is not |
|---|---|---|
| **Jokko Money (J2)** | The money kernel: double-entry ledger, the only writer of balances, provider operations, reconciliation. | Not a place where any other system keeps balances. |
| **Jokko Identity & Trust (J3)** | People, sessions, devices, KYC tiers, business memberships and capabilities, operator duties, risk. | Not a CRM. |
| **Jokko Money UX (J4)** | Customer money flows: home, history, receipts, intents, QR charges, refunds. | |
| **Jokko Business Lite (J5)** | A deliberately small operating surface for businesses that don't need Kabu: today, accept payment, simple catalog and stock, simple orders, staff, payroll, business wallet and activity, supplier/B2B ordering, distribution relationships, logistics handoff. | **Not a second Kabu Shop.** No themes, domains, store builder, collections or merchandising, discounts engine, advanced analytics, or full returns workflow. |
| **Kabu Business / Kabu Shop** | The full Shopify-class commerce OS: storefront, website/builder, products/variants/collections, cart/checkout, orders, customers, discounts, analytics, shipping, returns, staff, domains, themes. | Not a money system: it uses Jokko Money through the integration contract. |
| **Askaan / Askoo** | Marketplace and discovery surfaces. | Not a seller's system of record. The seller's own system (Kabu or Business Lite) owns the order. |
| **Mbolo** | Messaging; conversations as an order and payment channel; business customer service. | Not an order or payment store: orders and receipts are Jokko/Kabu objects referenced from messages. |
| **OpportunityOS** | Economic opportunity discovery from aggregated signals. | Never a consumer of individual business data. |
| **IAWIC** | Investment / industrial capital vehicle (future receivables financing and investment). | Not active inside Jokko. Legacy Kebu investments are preserved (D7). |
| **Japalante / Jëm Kanam** | Production / enterprise programmes fed by opportunity discovery. | Not part of Jokko's runtime. They are counterparties through defined interfaces. |
| **Jokko Logistics (J8)** | Pickup, transit, delivery, proof, returns, settlement; later fulfilment centres. | Not inside payment or order handlers. It consumes order events. |

## 3. Kabu ↔ Jokko integration contract

**Principle:** one source of truth per object. Objects cross by **reference**: an `ExternalLink` maps a Kabu id to a Jokko id, and events flow both ways. Jokko never stores a copy of a Kabu order, product or customer because it processed one component of it.

| Capability | Direction | Mechanism | Status |
|---|---|---|---|
| Business link (identity mapping) | Kabu ↔ Jokko | The Jokko business **owner** creates a one-time code. Kabu, authenticated with its partner key, presents the code and its business id (`POST /api/v1/business-links`). The result is an `ExternalLink(system=kebu, objectType=business)`. Revocable by the owner. | ACTIVE (J5) |
| Payment acceptance | Kabu → Jokko → Kabu | Kabu creates a payment intent (`POST /api/v1/checkout/sessions` or `/payments/collect`). The J2 kernel / provider settles it. A signed webhook returns the result to Kabu, and **Kabu updates its own order**. | ACTIVE (Partner API) |
| Settlement into the linked merchant's business wallet | Jokko | Partner collections settle today to one configured wallet (`PARTNER_SETTLEMENT_USER_ID`). Routing them to the linked business wallet is a J2 recipe change (provider cash-in → business account). | DORMANT, migration needed |
| Employee payouts / payroll | Kabu → Jokko | Kabu staff authority → Jokko payout instruction → J3 authorization (the business capability `business.pay`) → J2 posting → the employee is paid. | Payouts ACTIVE (Partner API); payroll instructions DORMANT |
| Supplier payments / B2B purchasing | Kabu business ↔ Jokko distribution | The linked business uses Jokko B2B ordering, trade accounts and invoices. | ARCHITECTED (link exists; ordering via Jokko UI) |
| Trade credit | Supplier → buyer | Supplier-granted terms only (§7). | Supplier credit ACTIVE (B2B); financing DORMANT |
| Jokko Logistics | Kabu → Jokko → Kabu | Kabu fulfilment request → Jokko Logistics → status/proof events → **Kabu updates its fulfilment**. | DORMANT (J8) |
| Jokko Fulfilment | Kabu → Jokko | Inventory placed in Jokko fulfilment centres (§10). | DORMANT |
| Merchant network / distribution participation | Kabu business ↔ Jokko | The linked business can be a merchant or distributor in Jokko relationships. | ARCHITECTED |
| Collective / cooperative systems | Kabu business ↔ Jokko | Through the same business identity. | ARCHITECTED |
| Events / webhooks | Jokko → Kabu | `CommerceEvent` outbox → signed webhooks (same signing as the Partner API). | Outbox ACTIVE; Kabu delivery DORMANT |

**Worked examples (binding):**
- **Kabu ecommerce order paid with Jokko.** Kabu owns the order, customer and store workflow. Kabu → Jokko payment intent → J2 → result webhook → Kabu marks its order paid. Jokko keeps the payment (ExternalOperation + ledger) and the partner reference, **not the Kabu order**.
- **Kabu order delivered by Jokko Logistics (J8).** Kabu fulfilment request → Jokko Logistics job referencing the Kabu order id → status/proof events → Kabu updates its fulfilment.
- **Kabu payroll through Jokko.** Kabu staff authorization → Jokko payout instruction → J3 checks the Jokko-side business capability → J2 posting → employee wallet.

## 4. Omnichannel commerce

A business has **one** canonical identity, catalog, inventory, set of orders, customer relationships, payments, financial history, staff/permissions and fulfilment state, within its system of record (Kabu or Business Lite).

Every channel enters through an **adapter** (`lib/commerce/channels.js`) that maps its input into that canonical model. Each order records `sourceChannel`, `sourceSystem` and `externalOrderRef`. No channel gets its own merchant silo.

| Channel | Order owner | Status |
|---|---|---|
| Jokko app (shop catalog) | Jokko (Business Lite) | ACTIVE |
| Jokko QR (charge / merchant QR) | Jokko | ACTIVE |
| Mbolo conversation | Jokko | ACTIVE |
| POS / manual sale | Jokko | ACTIVE (cash recorded off-ledger) |
| Payment link (shareable charge reference) | Jokko | ACTIVE |
| Kabu Shop | Kabu | DORMANT adapter (contract §3) |
| Askaan / Askoo | The seller's system | DORMANT adapter |
| External websites | The seller's system, via the Partner API | Payments ACTIVE; orders DORMANT |
| WhatsApp / business messaging | The seller's system | DORMANT |
| Restaurant ordering | Jokko | DORMANT |
| NFC / device-to-device, SoftPOS | Payment methods, not channels (§5) | DORMANT |

**Marketplace orders.** Askaan/Askoo originate an order for a seller. The **seller's system of record** (Kabu or Business Lite) owns the order. The marketplace keeps a reference and its own discovery and attribution data. Order state is never duplicated across systems; status flows by events.

## 5. Payment acceptance

`lib/commerce/acceptance.js` defines one canonical `PaymentRecord` per accepted payment. Whatever the method, it links to the order, charge or receipt and declares how it settled.

| Method | Settlement | Status |
|---|---|---|
| Jokko wallet | `jokko_ledger` (J2 entry referenced) | ACTIVE |
| Static merchant QR | `jokko_ledger` | ACTIVE |
| Fixed/dynamic charge QR | `jokko_ledger` | ACTIVE |
| Payment link (charge reference shared as a link) | `jokko_ledger` | ACTIVE |
| Cash / manual sale | `off_ledger_cash`: an operational record only; never in the business wallet, never in ledger-based totals | ACTIVE |
| Online checkout (hosted) | `jokko_ledger` | DORMANT for Business Lite (Partner API checkout serves Kabu) |
| Mobile money / bank / provider rail direct to a merchant | `external` → ExternalOperation | DORMANT |
| Device-to-device tap | `jokko_ledger` | DORMANT |
| Contactless card / SoftPOS | `external` | DORMANT. **Only** through a licensed, certified acquirer and SoftPOS provider (PCI scope with them). **No home-made card processing, ever.** |

Every DORMANT method is refused at runtime (`method_not_activated`). `GET /api/commerce/capabilities` lists them as DORMANT, so no UI can present them as available.

## 6. Distribution and merchant acquisition

**Operating mode.** `Business.operatingMode` is one of:
- `retail`, `services`, `restaurant`;
- **`distribution`, `wholesale`, `manufacturer`**;
- `cooperative`.

Only the owner changes it (audited).

**Model.** Distributor (business in distribution mode) → **Territory** → **reps** (members with the `distribution_rep` role: `business.distribution.invite` only) → **MerchantRelationship** → wholesale catalog (same catalog, B2B prices and MOQ on `Product`) → B2B orders → invoices (`TradeInvoice`) → payment terms (§7) → fulfilment → routes → deliveries → collections → returns.

| Piece | Status |
|---|---|
| Territories, reps, relationships | ACTIVE (J5) |
| B2B orders, trade accounts, invoices, receivables, disputes | ACTIVE (pre-J5, hardened) |
| Routes, collections rounds, returns | DORMANT (J7/J8) |

**Merchant acquisition (binding rule).** Invite / assisted onboarding → merchant verifies and accepts → commercial relationship established.

Every relationship records:
- who introduced the merchant, and for which organization;
- the representative and territory;
- invited and accepted dates;
- status (invited / active / declined / ended);
- assisted onboarding flag;
- **explicit scopes** (`wholesale_catalog`, `wholesale_ordering`).

Invitation and assistance create **no ownership and no membership**. The distributor never gains access to the merchant's wallet, sales, suppliers, payroll, customers, transactions or private information. Any of that would need the merchant to grant a J3 membership, which a relationship never does.

The merchant side accepts or ends the relationship with `business.relationships.manage`. Either side can end it, and history is kept.

Tested adversarially in `tests/j5/economic-contracts.test.js`: the distributor's owner, manager and rep get 403/404 on every merchant route, before and after acceptance.

**Scale target.** Our own physical distribution company is expected to be a major user, potentially reaching tens of thousands of small stores. Independent distributors use the same infrastructure, with the same isolation.

## 7. Trade credit (ready, not activated as lending)

| Concept | Model today | Status |
|---|---|---|
| TradeAccount | `TradeAccount` (supplier ↔ buyer): `paymentTerm`, `creditLimitKori`, `codEnabled`, `trustTier` | ACTIVE |
| CreditLimit | `TradeAccount.creditLimitKori` | ACTIVE |
| PaymentTerms | Due now, Net 7, Net 15, Net 30, Net 60, Net 90, monthly, COD | Values ACTIVE, but each only when **granted by the supplier** |
| Invoice / DueDate | `TradeInvoice` (`dueAt` from `computeDueDate`) | ACTIVE |
| Receivable / OutstandingBalance | Supplier receivables (open/partial invoices) | ACTIVE |
| PastDue state | Invoice status + reminders | ACTIVE |
| Dispute / Settlement | Invoice dispute + resolution; payment through J2 | ACTIVE |
| CreditMemo | — | ARCHITECTED (compensating entry against an invoice) |
| FinancingOffer / FinancedAmount / Repayment | — | DORMANT: requires a licensed partner / IAWIC structure |

**Rules:**
- A buyer **can never self-select credit** because an API accepts `net30` or `cod`. Credit exists only on an active trade account the supplier granted, for the term granted and within its limit.
- **Fix in J5:** before J5, any buyer could select COD and receive a default limit the supplier never granted. COD now also requires a supplier grant.
- **Supplier-provided trade credit** (the supplier carries the receivable) is kept strictly distinct from **future Jokko / IAWIC / partner receivables financing**. Financing will be a separate party buying or lending against invoices, with its own licensing, consent and ledger accounts. No financing, credit approval or repayment is simulated.

## 8. Fulfilment and logistics contracts

**Fulfilment owner.** `Order.fulfillmentOwner`:
- `merchant`: active;
- `jokko`: DORMANT, refused at order creation with `fulfillment_not_activated`.

**Order and inventory facts for future fulfilment:**
- **active today:** inventory owner (business), inventory location (`Order.inventoryLocationId`, `StockMovement.inventoryLocationId`), fulfilment owner;
- **J8:** reserved, picked, packed, dispatched, delivered and returned quantities (a stock-position table per inventory location).

**Logistics contract (J8 consumes it).** The order lifecycle emits events through the `CommerceEvent` outbox (`lib/commerce/events.js`). Events are written in the same transaction as the change, and payloads carry ids and amounts only:

```
order.paid → order.accepted → order.ready_for_fulfillment → (fulfillment.requested — J8)
→ pickup → in_transit → order.out_for_delivery → order.delivered (+ proof) → order.completed
exceptions: order.cancelled · order.refunded · return.* (J8) · settlement/reconciliation (J8 via J2)
```

Logistics logic never lives in payment or order handlers. Today's local courier marketplace (`DeliveryTask`, escrow) remains ACTIVE and is the merchant-arranged delivery path.

## 9. Address foundation

`Address` (`lib/geo/address.js`) is a reusable, first-class object structured for how places are found in West Africa:
- country / region / department / city / commune / neighborhood;
- street / building / landmark / entrance instructions / map pin;
- verification state: unverified, self_declared, agent_verified or courier_verified.

**Purposes:** home, business, store, warehouse, pickup point, delivery destination, farm, factory, fulfilment centre.

**Privacy (binding):**
- A **home is never public**.
- A person's address is shared with a business only for a purpose: an **active delivery order**, and only with that business's fulfilment roles. It stops being visible when the order ends.
- Everyone else gets the coarse area (city / commune) at most.
- Transacting commercially never exposes a person's precise location.

## 10. Inventory locations

```
Business → BusinessLocation → InventoryLocation → SKU (Product) → stock position
```

- **`InventoryLocation.kind`:** store, warehouse, distributor_depot, jokko_fulfillment_center (DORMANT), pickup_hub (DORMANT).
- **Stock today:** `Product.inventory` is the stock of the business's primary inventory location.
- **Movements:** every `StockMovement` and order records which inventory location it concerns.
- **Next step:** per-location stock positions (on hand / reserved) are additive, and nothing has to be rewritten to add them.

## 11. Product identity across systems

There is no single global product-creation application:

| Origin | System of record | Crossing |
|---|---|---|
| Full ecommerce product | Kabu | `ExternalLink(objectType=product)` when sold through Jokko distribution or a marketplace |
| Neighbourhood merchant item | Jokko Business Lite (`Product`) | Exportable to Kabu through the same link |
| Distributor / manufacturer SKU | Jokko distribution (the distributor's `Product`, `sku` unique per business) | The merchant's restock order references the distributor's SKU; the merchant's own item may map to it |

Mapping is by reference and explicit. Data is never silently duplicated in both directions.

## 12. Demand intelligence (governed, aggregated)

`lib/intelligence/demand.js` is the **only** interface through which commerce data may leave a business towards the economic graph:
- category × region × period aggregates of demand and shortages;
- **k-anonymity k ≥ 5** distinct businesses per cell; smaller cells are suppressed;
- no business id, name, customer, price list or individual figure.

The consumer (OpportunityOS → industrial opportunity discovery → IAWIC / Foundry / Japalante / Jëm Kanam → African production → distribution back through Jokko) is DORMANT. Any new signal needs the same aggregation and governance review.

## 13. System-of-record matrix

Key: **K** = Kabu, **J** = Jokko, **M** = Marketplace, **S** = Shared service, **F** = Future service.

| Object | Authoritative | Others hold | Sync direction | Notes |
|---|---|---|---|---|
| Business identity | J for the legal/money identity; K for the Kabu shop profile | The other side: ExternalLink only | Consented link (owner code + partner key) | One Jokko business per Kabu business (unique link) |
| Ecommerce store (storefront, domain, theme) | K | — | — | Never in Jokko |
| Product merchandising (variants, collections, media) | K | — | — | Business Lite has simple items only |
| Operational SKU | K for Kabu merchants; J for Business Lite and distributor SKUs | ExternalLink(product) | Origin → consumer, by event | |
| Inventory | The seller's system (K or J); J for Jokko fulfilment centres (F) | — | Fulfilment events (F) | Movements are append-only in J |
| Ecommerce order | K | J: payment / logistics references | K → J requests; J → K results (webhooks) | No Kabu order copied into Jokko |
| Business Lite order | J | — | — | `lib/commerce/orders.js` |
| Marketplace order | The seller's system (K or J) | M: reference + attribution | M → seller (create); seller → M (status) | No duplicated state |
| Payment | J (PaymentRecord + J2) | K: payment status on its order | J → K webhook | |
| Ledger (money) | **J2 only** | Nobody | — | Kabu never keeps Jokko balances |
| Employee / staff identity | J3 for Jokko authority; K for Kabu staff accounts | ExternalLink (F) | K → J payout instruction with Jokko-side authorization | Being on payroll ≠ authority |
| Payroll instruction | K (Kabu payroll) or J (Business Lite payroll) | — | K → J (F) | |
| Payroll payment | **J2** | K: result | J → K | Same transaction as the run record |
| Distributor relationship | J | — | — | MerchantRelationship |
| B2B purchase order | J (distribution) | K: reference when a Kabu business buys (F) | J → K events | |
| Trade credit (supplier) | J (TradeAccount / TradeInvoice) | — | — | Supplier-granted only |
| Receivables financing | F (licensed partner / IAWIC) | J: ledger postings when active | — | DORMANT |
| Delivery | J local couriers today; F Jokko Logistics (J8) | K: status | J → K events | |
| Fulfilment | The seller (merchant-fulfilled); F Jokko Fulfilment | — | Events | DORMANT for Jokko |
| Customer profile | K for Kabu store customers; J3 for Jokko people | Business Lite: name/handle and history **with that business** only | — | No CRM copy across systems |
| Analytics | The system owning the facts (K for store analytics; J for money and Business Lite) | J: k-anonymous aggregates only | J → OpportunityOS (F) | No individual data leaves |

## 14. Classification of existing Jokko merchant capabilities

Classes: 1 JOKKO-NATIVE · 2 KABU-OWNED · 3 SHARED INFRASTRUCTURE · 4 INTEGRATION / ADAPTER · 5 LEGACY / DUPLICATIVE (migration needed) · 6 FUTURE / DORMANT.

Nothing is deleted, and no user data is migrated destructively.

| Capability (routes / modules) | Class | Notes |
|---|---|---|
| Business create / identity / members / role changes (`businesses`, J3/J5) | 3 | Shared identity and authority for Kabu-linked and Lite businesses |
| Business wallet, treasury transfer, owner draw (`businesses/:id/wallet`, `/transfer`) | 3 | J2 money; Kabu uses it via the contract |
| Payroll (`businesses/:id/payroll/*`) | 1 → 3 | Business Lite payroll; settlement service for Kabu (instructions DORMANT) |
| Merchant QR pay, charges, payment links, refunds (`merchants/:id/pay`, `money/charges*`, `money/payments/:ref/refund`) | 3 | Payment acceptance for every channel |
| Business Lite operations (`businesses/:id/os/*`: today, catalog, stock, orders, customers, money, analytics, settings) | 1 | Deliberately small; no Kabu-class features |
| Marketplace catalog / shops / search / orders (`marketplace/*`, `products`) | 1 + 5 | Lite selling surface. The merchant product editor (`MerchantCatalogScreen`) and Business Lite catalog overlap: converge on `lib/commerce/catalog.js` (non-destructive) |
| Merchant analytics (`marketplace/analytics`) | 5 | Superseded by `os/analytics` (reconciled to the ledger); keep until the client migrates |
| Order status (`marketplace/orders/:id/status`) | 1 | Now the J5 state machine |
| Distribution: brand register, buyer portal, trade accounts, invoices, receivables, disputes (`distribution/*`) | 1 + 3 | Jokko distribution network infrastructure |
| Merchant relationships, territories (J5) | 1 | Distribution network |
| Affiliate links / commissions | 3 | Shared growth infrastructure; split payments need support to refund |
| Merchant vouchers | 1 | Lite loyalty; not a Kabu discounts engine |
| Courier deliveries + escrow (`deliveries/*`) | 1 → 6 | Merchant-arranged delivery today; Jokko Logistics (J8) succeeds it via events |
| Hubs / parcels (`hubs/*`, `marketplace/hubs`) | 6 / 1 | Pickup hub precursor; inventory kind `pickup_hub` is DORMANT |
| Partner API: checkout, collect, POS sessions, payouts, messaging, support (`v1/*`) | 4 | The Kabu ↔ Jokko adapter. Per-merchant settlement: **5** (migration needed, §3) |
| Business link (`v1/business-links`, `os/integrations`) | 4 | J5 |
| Kebu score (`businesses/:id/kebu-score`) | 4 | Trust signal shared with Kabu |
| School fees, cooperative deliveries / payouts | 1 | Vertical business modes on the shared identity |
| Community status, reviews | 1 | Social proof; not commerce state |
| Legacy KebuInvestment, KoriRedemption, MerchantPromo, Ñu Lekk | 5 / 6 | Preserved (D7); IAWIC-era successors are DORMANT |
| SoftPOS, device tap, Jokko Fulfilment, receivables financing, routes, freight, predictive placement | 6 | DORMANT register (§15) |

## 15. Dormant register

Each item is DORMANT / ARCHITECTED / NOT ACTIVATED until it can be operated safely and legally. None may show success, approval or availability in production.

| Capability | Interface / data that exists now | What activation requires |
|---|---|---|
| SoftPOS / contactless card | Payment method `softpos_card` (refused) | A licensed acquirer and a certified SoftPOS partner; PCI scope stays with them |
| Device-to-device tap | Method `device_tap` (refused) | Secure-element / NFC design and risk review |
| Online checkout for Business Lite | Method `online_checkout` (refused) | Hosted checkout reuse + receipt flow |
| Provider rail direct to merchant | Method `provider_rail` (refused) | Provider contracts + reconciliation |
| Receivables financing | Concepts §7 | Licence / partner, consent, separate ledger accounts |
| Jokko Fulfilment | `fulfillmentOwner=jokko` (refused); inventory kinds | Facilities, operations, stock positions |
| Jokko Logistics | Outbox events | J8 |
| Advanced routing / freight / predictive placement | Territories, inventory locations, aggregates | J8+ |
| Kabu per-merchant settlement, payroll instructions, product mapping, webhooks | ExternalLink, contract | Kabu-side build + J2 recipe for business settlement |
| Marketplace / WhatsApp / restaurant channels | Channel registry (refused) | Adapters |
| OpportunityOS feed | `demandAggregates` | Governance approval + consumer |

## 16. Jokko Business Lite: scope guard

**In:**
- today / sales summary;
- accept payment (wallet, QR, charge, payment link; cash recorded off-ledger);
- basic catalog (products/services, SKU, price, active);
- basic stock with history;
- basic orders with cancellation and full refunds;
- staff roles, payroll;
- business wallet / activity / reconciled analytics;
- supplier / B2B ordering, distribution relationships;
- logistics handoff via events.

**Out (use Kabu):**
- storefront / website / themes / domains;
- variants / collections / merchandising;
- discount engine;
- advanced analytics;
- shipping rules;
- full returns (RMA) workflow;
- multi-store ecommerce operations.

A feature request that falls in "Out" goes to Kabu, or to a contract between the two systems.

## 17. Phase map

| Phase | Builds on this architecture |
|---|---|
| J5 | Business Lite + shared business infrastructure + contracts (this document) |
| J6 | Production readiness of J2–J5; merchant settlement migration decision; Kabu link activation |
| J7 | Distribution network operations (wholesale catalog UI, restocking, collections) |
| J8 | Jokko Logistics (consumes the outbox), then fulfilment |
| Later | Licensed card acceptance, receivables financing (IAWIC / partners), OpportunityOS feed |
