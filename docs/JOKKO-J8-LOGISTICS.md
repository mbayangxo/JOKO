# Jokko J8 — Movement, logistics & fulfilment network (design, binding)

This document extends `JOKKO-ECONOMIC-OS-ARCHITECTURE.md` and `JOKKO-J7-COMMERCE.md`. Changing it is a recorded decision.

**Separation (unchanged from J5/J7):**
- **Commerce** (J5 orders, J7 purchase orders and returns) owns the commercial obligation.
- **Logistics** (J8, `lib/logistics/*`) owns physical movement: who holds the goods, where, and the proof.
- **Money** (J2 kernel) owns every balance: delivery fee escrow, courier earnings, revenue.

J8 reaches commerce through one file only, `lib/logistics/commerce-adapter.js`. It calls named J7 contract functions (`applyShipmentDeliveredInTx`, `applyShipmentReceivingInTx`, `applyShipmentNotDeliveredInTx`, `applyReturnReceivingInTx`). Logistics never edits an order row directly.

---

## 1. J8.0 — inventory of existing movement code

Historical delivery data is never deleted. The J8 migration is additive (§14).

| Area | Existing code / model | Class | Status after J8 |
|---|---|---|---|
| Consumer courier marketplace | `DeliveryTask`, `DeliveryEscrow`, `DeliveryDispute*`, `lib/delivery-service.js`, `deliveries/*` routes | 6 LEGACY/DUPLICATIVE | Kept for consumer orders. The six unsafe primitives were fixed in J8.0 (`1fc4f89`). The dispute ruling is operator-only (P0 fix `948f2a6`). Not used for new B2B movement. |
| Open delivery / courier claim | `deliveries/:id/accept`, `deliveries/:id/claim` | 6 | Open-claim marketplace semantics kept for legacy consumer tasks only. The buyer, seller and seller staff are refused (J8.0 fix 3). J8 shipments are never claimable: assignment is authoritative (§6). |
| Courier approval | `AccountRole(role='driver')`, `admin/couriers/:id/approve / suspend / revoke` (J3) | 5 SHARED | Reused as the **Jokko courier** identity for Jokko Logistics. Suspension takes effect on the next act (checked on every custody act). |
| Rider presence | `DriverProfile.status`, `cron/rider-status` | 6 | Presence only. **Never used as availability or location truth** (no fake availability). |
| Hub parcels (diaspora pickup) | `DeliveryHub`, `HubParcel`, `hubs/parcels/*` | 6 → 5 | J8.0: arrival and release only by the operator of an **approved pickup point** running that hub; release needs the code (5 attempts, constant-time). |
| Marketplace order fulfilment | `merchantTransition` (`out_for_delivery` / `delivered`) | 2 COMMERCE-OWNED | J8.0 fix 6: the merchant cannot mark delivered after a courier took custody. |
| Restaurant delivery | none found | — | — |
| Agent location | `AgentServicePoint` (J6; approximate coordinates only) | 4 AGENT/CASH | Unchanged. **An agent location is not a pickup point** (§9). |
| Depots / stock | `InventoryLocation`, `DepotStock`, `DepotStockMovement` (J7) | 3 BUSINESS-OWNED | J8 moves stock **only** through receiving / transfer / return events (§8). |
| Warehouse / fulfilment centre | `InventoryLocation.kind='jokko_fulfillment_center'` (J5 enum value) | 7 FUTURE/DORMANT | DORMANT (§12). |
| Rides | none (no passenger code; "ride" appears only in comments) | 7 | DORMANT, contract only (§13). |
| COD | legacy marketplace COD orders (J7 trade-locked) | 2 | **J8 COD is DORMANT** (§10). Legacy COD orders keep their J7 behaviour. |
| Delivery fees | legacy `STANDARD_DELIVERY_FEE_NATIONAL = 1500` (server constant since J8.0 fix 2) | 6 | J8 fees come from `lib/logistics/fees.js` server rules (§7). |
| Proof of delivery | legacy: courier "deliver", then buyer confirm, else **auto-release** | 6 | J8.0 fix 1: no auto-payment without receiver confirmation; escalated to review. |
| Returns | J7 `CommercialReturn` | 2 | J8.18 adds tracked physical return movement (§8.4). |
| Delivery incentives | legacy rider fee from the buyer's escrow (not minted) | 6 | No reward or incentive in J8. Earnings are funded fee shares only (§7). |
| Addresses | J5 `Address`; `Business.address`, `arrondissement`, `lat/lng` | 5 | J8 snapshots the destination per shipment, with purpose-limited visibility and retention (§4). |

---

## 2. J8.1 / J8.2 — fulfilment contract and owners

`FulfilmentRequest` **references** its source. It never copies it:
- `sourceSystem` + `sourceId` + `purpose` (`outbound` | `return`);
- `sourceKey` (unique; idempotent intake);
- owner, service type, origin and destination (business / user / pickup point);
- payer, fee snapshot, fee status, request status.

Commercial amounts, customer fields and order lines are **not** copied. Packages carry contents by reference (`productId`, `sku`, `units`).

| Owner | Status | Who moves | Jokko fee |
|---|---|---|---|
| `MERCHANT_FULFILLED` | ACTIVE | the merchant's own fleet | none |
| `DISTRIBUTOR_FULFILLED` | ACTIVE | the distributor's own fleet (seller in distribution mode) | none |
| `CUSTOMER_PICKUP` | ACTIVE | the receiver collects at the source, or at an approved pickup point | none |
| `JOKKO_LOGISTICS` | **GATED**: code-complete, **operationally not activated** unless `JOKKO_LOGISTICS_ENABLED=true` | approved Jokko couriers, dispatched by `logistics_ops` | server fee, J2 escrow |
| `JOKKO_FULFILLMENT_CENTER` | DORMANT | — (no such centre exists) | — |

**J7 hand-off** (`fulfillment.requested` outbox event → `processLogisticsOutbox`):
- `jokko_logistics` → always a tracked shipment, and only when enabled.
- `seller_delivery` / `buyer_pickup` → a tracked shipment **only when the seller opts in** (`tracked: true`). Otherwise J7's seller-recorded delivery remains, honestly labelled `deliveryRecordedBy: 'seller'` (proposed decision P-J8-1).
- `third_party` → never a shipment (outside Jokko).

There is one shipment per hand-off attempt (`sourceKey = jokko_po:<po>:outbound:<eventId>`). The outbox consumer is idempotent: it is run inline after the advance, by `cron/logistics`, or both.

A **carried** order cannot be marked delivered by the seller (`delivered_by_shipment`). It cannot be received by the J7 shortcut either (`received_by_shipment`). The order is carried from the moment the event exists, even before the shipment row does.

---

## 3. J8.5 — state machine and custody

```
requested ─accept(ops)→ accepted ─ready(source)→ ready_for_pickup ─assign(dispatcher)→ assigned
assigned ─arrive_pickup→ pickup_arrived ─pickup(courier + SOURCE code)→ picked_up ─depart→ in_transit
… ─arrive_delivery→ delivery_arrived
picked_up | in_transit | delivery_arrived
   ─deliver(courier + RECEIVER code) | receiving(receiver)→ delivered        (final)
   ─fail(courier, reason)→ delivery_failed ─return_start→ return_in_transit
        ─return_complete(courier + SOURCE code)→ returned                    (final)
   ─exception(courier claim)→ delivery_exception ─rule(ops)→ delivered | delivery_failed
ready_for_pickup ─drop(pickup point operator)→ at_pickup_point
ready_for_pickup | at_pickup_point ─collect(desk + RECEIVER code)→ delivered
requested … pickup_arrived ─cancel(source | ops)→ cancelled                  (final)
```

**Custody** follows from the status: `source` → `courier` → `receiver` | `pickup_point` | back to `source`.
- The DB trigger `joko_shipment_guard` refuses a status without its custody.
- It refuses any change out of `delivered` / `returned` / `cancelled`, and it refuses deletes.
- `custodianUserId` is set exactly while the courier holds the goods (L1).
- History (`ShipmentEvent`) is append-only. A partial unique index allows exactly one `delivered` event per shipment.

**Rules:**
- A customer cannot mark pickup.
- A courier cannot confirm delivery alone.
- A merchant cannot mark delivered after losing custody, both on the legacy path and on J8.
- A cancelled shipment never delivers: it is final, and a new hand-off creates a new shipment.

---

## 4. J8.3 / J8.21 — address privacy and tracking

The destination snapshot on `Shipment`:
- `destArea` is shown to the parties.
- `destPrecise`, `destLat`, `destLng` go to the **active assigned courier only**, while the movement is live (`COURIER_ACTIVE`).

**Who sees what:**
- Source, receiver, dispatcher and operators get the area only.
- The courier never gets the receiver's wallet, order, phone or fee.
- An unassigned courier loses access immediately (404).

**Retention:** `redactPreciseDestinations` (in `cron/logistics`) nulls the precise fields 7 days after a terminal state (`PRECISE_RETENTION_DAYS`).

**Tracking** is status-based. The history shows status, time and evidence kind, and no actor ids. **There is no GPS, no moving map and no ETA.** Outbox events (`shipment.<status>`) never carry the precise destination.

---

## 5. J8.8 / J8.9 / J8.14 — proof protocol (custody challenges)

`CustodyChallenge`: the code is 8 characters from a 31-character alphabet. It is stored as `sha256(shipmentId:purpose:code)` only, and it is:
- purpose-bound;
- bound to the counterpart user where one exists;
- valid for 10 minutes;
- single-use;
- limited to 5 attempts, then locked (423).

Failed attempts are counted **outside** the act's transaction (fixed in J8, §F1 of the report). Issuing a new code expires the previous one.

| Act | Issued by | Submitted by | Proof recorded |
|---|---|---|---|
| pickup | source (`business.orders.fulfill`) | assigned courier | `source_code` |
| delivery | receiver (`business.purchasing`, or the destination user) | assigned courier | `receiver_challenge` |
| B2B receiving at the door | — | receiver itself (per-line record) | `receiver_receiving` |
| collection (customer pickup) | receiver | releasing desk (source staff, or the pickup point operator when one is set), never the receiver | `pickup_point_release` |
| return to source | source | courier | `source_code` |
| no receiver evidence | courier files an **exception** (a claim, never a delivery) | `logistics_ops` rules with evidence, audited | `operator_ruling` |

**What Jokko can prove:**
- a party holding the counterpart's account confirmed the handoff at that moment.

**What it cannot prove:**
- physical presence;
- the condition of goods beyond what the receiver records.

**Offline / lost response:** the same actor re-submitting the same code after the act returns the result (`replayed: true`). It never asks for a second physical handoff.

---

## 6. J8.6 / J8.7 — couriers and assignment

**Jokko courier:** an active `driver` application role (J3 approval lifecycle). It is separate from:
- `agent` (cash);
- business roles;
- distribution reps;
- support.

None implies another (tested in J8.33).

**Fleet driver:** an active member of the fulfiller business holding `business.fleet.drive` (`fleet_driver` or `fulfillment` role). Dispatching needs `business.fleet.dispatch` (manager or owner).

**Assignment:**
- Jokko Logistics is assigned by `logistics_ops` (`logistics.dispatch`). Own fleet is assigned by the business dispatcher.
- The DB allows **one active assignment per shipment**. Two concurrent dispatchers → exactly one wins.
- There is no claiming and no self-assignment.
- A courier is never a party to the destination: not the receiver, the receiving business's owner, or its staff. The one exception is movement into the fulfiller itself (transfer, collected return), and that driver still can never sign the receiving.
- Unassignment is allowed only before pickup. Re-assignment after pickup (a handoff) is **not supported** and refused.

---

## 7. J8.10 / J8.11 — fee and earnings (J2 recipes)

| Event | Posting (deterministic reference) |
|---|---|
| request (Jokko Logistics) | sender business wallet → `escrow:shipment_fee:<req>` (`SHF-HOLD-<req>`); `feeStatus=held` |
| verified delivery, or a receiver-side failure once the goods are back | escrow → `courier:<id>:earnings` (`SHF-EARN`), with `CourierEarning` accrued; remainder → `revenue:delivery` (`SHF-REV`); `released` |
| cancel, or an operational failure once the goods are back | escrow → sender (`SHF-REFUND`); `refunded` |
| earning hold (24 h) passed, no open dispute | `accrued → releasable` (cron) |
| courier payout (own, idempotency key) | `courier:<id>:earnings` → courier wallet (`CEP-<user>-<key>`); `paid` |
| dispute upheld with reversal (maker/checker) | earnings → sender (`SHF-REV-EARN`), revenue → sender (`SHF-REV-FEE`); `reversed` |

**Rules:**
- Fee rule: local 150 Kori, courier share 80 % (`LOGISTICS_FEE_JSON`, validated). It is snapshotted on the request, and **no route accepts a fee field** (strict schemas).
- The fee, the earning and the revenue are separate accounts.
- An earning is created only from the held escrow, so it is never unfunded. It is never higher than the fee (DB CHECK), and there is one per shipment (unique).
- Paid earnings are not clawed back (`unrecoverable` is reported).
- Invariants: **I20** (escrow == held fee) and **I21** (earnings account == accrued + releasable).

---

## 8. Goods: receiving, transfers, returns

### 8.1 Receiving (J8.16)
`ReceivingRecord`:
- one per shipment;
- append-only;
- per line: `received / damaged / missing / refused`, and each line must sum to the dispatched units;
- outcome `full | partial | damaged | refused | missing`.

**Stock moves only here**, never from a "delivered" tap:
- received units are credited once (`receive_shipment` / `transfer_in` / `return_restock`);
- damaged, missing and refused units are recorded, not credited.

PO consequence: `full` → `received`; anything else → `disputed`, with the discrepancy as the reason. The resolution (credit memo or return) stays in J7.

### 8.2 Distributor → merchant (J8.15)
The flow is a PO:
1. depot reservation (J7) and dispatch decrement at `fulfilment_requested`;
2. shipment;
3. verified delivery (PO `delivered`, invoice on terms);
4. per-line receiving (PO `received` / `disputed`).

If the delivery fails or is cancelled, J7 re-credits **and re-reserves** its dispatch and returns the PO to `ready`. A new hand-off creates a new shipment.

### 8.3 Transfers (J8.17)
Depot A → in transit → location B:
- `transfer_out` at dispatch;
- **in nobody's position while in transit**;
- `transfer_in` for received units at receiving.

Cancel before pickup → `transfer_cancel` back. Failure → `shipment_return` back. Conservation is invariant L7.

### 8.4 Reverse logistics (J8.18)
J7 return approved → the buyer ships with `tracked: true` → a return shipment: the buyer is the source and issues the pickup code, and the seller's fleet collects.

The seller then records receiving per line, and J7 restocks the received units once. The money resolution (refund / credit memo / none) stays a separate J7 seller decision. **No refund comes from a courier's word.**

### 8.5 Failed delivery (J8.19)

| Reason | Side | Custody | Fee / earning | Order | Stock |
|---|---|---|---|---|---|
| receiver unavailable, address problem, refused, merchant closed | receiver | stays with the courier until returned | released to the courier once back (the work was done) | PO back to `ready` | re-credited at the origin once |
| unsafe, damaged, courier issue, operational | operational | same | refunded to the sender once back | same | same |

Retry = a new hand-off. **A failure is never converted into a delivery.**

### 8.6 Disputes (J8.20)
- A party (source, receiver or courier) opens a dispute within 7 days, once per shipment. Opening freezes the earning (`releasable → accrued`; no payout or promotion while open).
- Evidence is append-only, and parties see roles, not user ids.
- An operator (`logistics.disputes.resolve`) rules `rejected | upheld | upheld_reverse` with a reason; the ruling is audited and happens once.
- `upheld_reverse` files the `shipment_earning_reverse` approval. A **different** operator holding `logistics.disputes.reverse` (finance) executes it once.
- Shipment history is never overwritten.

---

## 9. J8.13 — pickup points
`PickupPoint` holds the operator business, services, hours, capacity and status `applied → active → suspended | closed`.
- Enrolment is by the business (`business.profile.manage`). **Approval is compliance only** (`pickup_points.approve`).
- Being an agent, a merchant, a distributor or a legacy hub operator **never** makes a place a pickup point.
- The public list shows name, services and hours only.
- Suspension removes authority immediately.

---

## 10. J8.12 — COD: **DORMANT**
`createRequestInTx({ cod: true })` → `cod_not_activated`. No courier collects Jokko-authorized cash.

Activating COD needs, as a separate capability:
- a separately authorized cash-collection role (not every courier);
- J6 cash-network primitives (challenge, binding, reconciliation);
- seller COD policy;
- collection evidence;
- double-collection protection;
- settlement and reconciliation;
- cancel / return-after-collection rules.

None of these is faked. Legacy marketplace COD orders keep their J7 behaviour (cash outside Jokko, recorded by the seller).

## 11. J8.22 / J8.23 — routes and consolidation
`DeliveryRoute` (date, driver, depot) plus ordered `RouteStop`s of the business's own ready shipments.
- The order is the dispatcher's. **There is no optimisation and no ETA.**
- Each stop goes through the same assignment path.
- Consolidation never merges proofs, custody, invoices or payments: each merchant's shipment, code, receiving and PO stay separate. A code from merchant 1 cannot deliver merchant 2's goods.

## 12. J8.24 / J8.25 — warehouse and placement intelligence
**Warehouse / fulfilment centre: DORMANT.** The primitives exist:
- locations;
- receiving;
- transfers;
- per-line positions;
- shipments.

Allocation, pick and pack are not built, and no Jokko centre exists.

**Placement intelligence: architecture only.** The signals are the existing outbox events (`shipment.*`, `fulfillment.requested`, `return.*`) and aggregate J7 demand. Any future planner must:
- aggregate across merchants (no single merchant's confidential data);
- suggest only, never move stock automatically.

## 13. J8.26 / J8.27 — intercity and rides
**Service types:**
- `local`: ACTIVE.
- `intercity`, `regional`: DORMANT, refused with `service_not_available` for Jokko Logistics.

Own fleets may move goods anywhere they choose, and Jokko claims no coverage for them. **There is no nationwide claim.**

**Rides: DORMANT.** There is no passenger code. A future passenger phase may reuse identity (J3 roles) and approval, but **never** shipments, custody or fees.

## 14. J8.28–J8.31 — adapters and neutrality
- **Kabu:** a Kabu order becomes `createRequestInTx({ sourceSystem: 'kabu', sourceId })`, idempotent on the source key. Kabu consumes `shipment.<status>` outbox events (aggregate = shipment; it maps them via the request) to update its fulfilment. Jokko stores no Kabu customer or order data beyond the destination snapshot needed for the move. There is **no Kabu endpoint yet**: the contract is tested at service level.
- **Askaan / Askoo:** no executable code exists. A future order uses the same contract (`sourceSystem: 'askaan'`). Nothing is fabricated.
- **Mbolo:** a conversation may lead to an order. Destination, courier, fee, proof, payment and status change **only** through the authoritative routes above; there is no conversational write path.
- **Distribution company (D33):** every primitive is keyed by capability and relationship, never by a business id. Any approved distributor uses the same routes.

## 15. Invariants
- **Goods (`lib/logistics/invariants.js`), L1–L8:**
  - custody ⇔ custodian;
  - one active assignment, only while a courier is involved;
  - delivered ⇔ exactly one delivered event, with a recognised proof and time;
  - receiving accounts for every unit, only on delivered shipments;
  - stock credited == received;
  - fee settlement ⇔ earning;
  - transfer conservation;
  - courier never the receiver or the receiving business.
- **Money:** I20 and I21 (J2 checker).
- **DB-enforced:**
  - status ⇒ custody;
  - final states;
  - no deletes;
  - append-only history, receiving and evidence;
  - one delivery event;
  - one active assignment;
  - earning ≤ fee, earning > 0.

## 16. Operations
- **`cron/logistics`** runs:
  - the outbox intake (PO hand-offs, tracked returns);
  - earning promotion after the hold;
  - precise-address redaction.
- **Operator roles:**
  - `logistics_ops`: dispatch, rule exceptions, resolve disputes; no money authority.
  - `compliance`: pickup point decisions.
  - `finance_ops`: approve earning reversals.
  - Conflicts: `sysadmin`/`logistics_ops` and `logistics_ops`/`finance_ops`.
