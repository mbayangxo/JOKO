# Jokko: unfinished product areas (documented, not faked)

Status as of 2026-10-03, HEAD of `claude/jokko-forensic-audit-rprqia`. The table records what the code does today. Where a capability is missing, it says so.

| Area | Classification | Gate |
|---|---|---|
| Commerce (marketplace orders) | **PARTIAL**: ordering, stock, server pricing and the merchant fulfilment state machine are REAL. **Cancel / refund / return: NOT IMPLEMENTED.** | PARTIAL |
| Rides | **NOT IMPLEMENTED** | N/A (roadmap) |
| Gigs / work | **PARTIAL**: post and list only | PARTIAL (lifecycle NOT IMPLEMENTED) |

---

## 1. Commerce: cancel / refund lifecycle

### What exists (REAL, tested in `tests/http/commerce-delivery.test.js`)

**Order and payment:**
- `POST marketplace/orders`: the server-side price wins. Concurrent checkout of the last unit sells it once.
- b2c is pay-now only. b2b net terms need an agreed trade account and a credit limit.

**Merchant transitions** (`lib/order-fulfillment-service.js` `MERCHANT_TRANSITIONS`):

```
confirmed → preparing → ready_for_pickup → completed
                     ↘ out_for_delivery → delivered → completed
```

**Other routes:**
- `POST marketplace/orders/:id/confirm`: buyer confirmation, which settles COD.
- Delivery orders create a `DeliveryTask`. Only the **courier fee** is escrowed (`DeliveryEscrow`); it is released on confirmation and refunded on dispute.

### What is missing (NOT IMPLEMENTED)

| Need | Today |
|---|---|
| Buyer cancel before preparation | No route, no state |
| Merchant cancel or reject (out of stock, closed) | No route, no state. The merchant can only move the order forward. |
| Refund of the order amount | None. **b2c pays the merchant's wallet directly at checkout (no escrow)**, so a refund would be a new transfer from the merchant, which may not have the funds. |
| Partial refund / return | None |
| Stock restoration on cancel | None |
| Dispute of goods (not delivery) | None. Delivery disputes cover the courier fee only. |
| Admin refund | `POST admin/refunds` pays from a **platform float wallet** (`ADMIN_FLOAT_USER_ID`). The merchant is never debited, so the platform absorbs every refund. There is no link to the order. |

### Interaction with the J2 ledger (design input, not built)

A correct refund lifecycle needs the J2 kernel. Without it, money has no place to sit between "buyer paid" and "merchant earned". Proposal:

1. **Checkout:** debit `customer:{buyer}` and credit `escrow:order:{orderId}`. The merchant is not paid yet.
2. **Fulfilment** (`delivered` + buyer confirm, or an auto-release timer like delivery escrow): debit `escrow:order` and credit `merchant:{business}`, minus `fees:marketplace`.
3. **Cancel before release:** debit `escrow:order` and credit `customer:{buyer}`, once, keyed on the order. Stock is restored in the same transaction.
4. **Refund after release:** debit `merchant:{business}` and credit `customer:{buyer}` (a `refund` entry referencing the original). If the merchant balance is insufficient, either debit `receivable:merchant:{business}` (a debt) or fall back to `platform:loss` under an explicit policy. It never fails silently.
5. **Dispute:** escrow stays held (`escrow:order` → `escrow:dispute`) until resolution. The ruling moves funds once.

This needs product decisions on:
- the auto-release delay;
- who can cancel at which status;
- the merchant-debt policy;
- the platform-loss cap.

---

## 2. Rides: NOT IMPLEMENTED

- No ride request, matching, pricing, trip state, driver location, safety or payment for passengers exists.
- "Movement" in the app (`MovementScreen`) means **deliveries** (courier jobs, escrowed fee) plus **gig listings**.
- `DriverProfile` / the `driver` role is the **courier** role. It carries no passenger-transport capability, licensing or insurance data.
- Nothing in the UI claims rides exist. Keep it that way until built.
- Any future ride payment must use the same escrow pattern: fare held at request, released at completion, refund or cancellation fee by rule.

---

## 3. Gigs / work: PARTIAL

### What exists
- A gig is a `Product` with `category: 'gig'`, posted from `MovementScreen` (`category: 'gig'` at creation).
- Listed via `getProducts('gig')` in `DiscoverScreen` and `MovementScreen`.
- `WorkerProfile` (modes, credit summary) and `WorkerReceipt` exist for the **worker identity/receipt** side.

### Lifecycle

| Step | Status |
|---|---|
| Post | REAL (as a product listing) |
| Discover | REAL (list) |
| Apply | **NOT IMPLEMENTED** |
| Accept (poster picks a worker) | **NOT IMPLEMENTED** |
| Perform / check-in | **NOT IMPLEMENTED** |
| Confirm completion | **NOT IMPLEMENTED** |
| Dispute | **NOT IMPLEMENTED** |
| Pay (escrowed) | **NOT IMPLEMENTED**: no escrow, no payout tied to a gig |
| Review | **NOT IMPLEMENTED** for gigs (`Review` exists for businesses only) |

The gig rows in the app have no action. They are a listing, not a marketplace for work.

### Minimum design for a real lifecycle (needs the J2 ledger)

1. `Gig` table (not a product row) with states `open → assigned → in_progress → submitted → completed | disputed | cancelled`.
2. Applications: `GigApplication(gigId, workerId, status)`. One accepted application.
3. **Pay escrowed at accept:** debit `customer:{poster}`, credit `escrow:gig:{id}`.
4. Completion confirmed by the poster, or auto-released after a timer. Funds move `escrow:gig` → `customer:{worker}` (minus fee).
5. Dispute holds the escrow. A ruling moves it once.
6. Reviews both ways after completion. Messaging between poster and accepted worker uses the message-request model; acceptance counts as a deliberate relationship.
