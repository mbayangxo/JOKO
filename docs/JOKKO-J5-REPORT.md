# Jokko J5 gate report: Merchant + Business OS (local)

Branch `claude/jokko-forensic-audit-rprqia`, on the accepted J4 head `e2c42d3`.

**Scope and limits.**
- Built and proven **locally only**; nothing was deployed.
- Production is untouched; no production row was read or changed.
- Vercel branch deployments stay disabled.
- The database deployment step stays inert (`db-migrate-deploy.mjs` exits 3).
- Production migration history is not baselined, and read-only production verification remains a separate, BLOCKED workstream.

**Verdict: the J5 gate is met locally.** No new P0 was found, and no path creates, destroys or misdirects money. There is no cross-business financial access: every attempt in the adversarial suite and both sweeps is refused.

J5 found and fixed four problems in the pre-J5 commerce code:
1. Order and merchant payments landed in the owner's **personal** wallet.
2. Only the owner could operate orders; staff could not.
3. There was no cancellation or refund at all (the "Commerce PARTIAL" finding).
4. Stock could change silently, and analytics counted unpaid and cancelled orders as revenue.

The production-shaped rehearsal also caught a migration-ordering bug before any deploy (§21).

**Architecture boundary.**
- J2 remains the financial authority: every money movement in J5 is a kernel posting, including refunds as compensating entries. There is no second ledger.
- J3 remains the permission authority: business roles are J3 memberships whose roles are capability sets.
- J4 remains the customer money layer: QR charges, intent keys and the refund primitive are reused, not duplicated.

The J4 decisions (fees 0, legacy requests preserved, follow-ups) are recorded as D18–D20 in [`JOKKO-DECISIONS.md`](JOKKO-DECISIONS.md). The J4 follow-up "request UI shows expired/limit states" is done (`b9c04c0`).

**Scope correction (owner instruction, mid-J5).**
- J5 is **Jokko Business Lite + shared business infrastructure + integration contracts**, not a second Kabu Shop.
- Kabu ("Kebu"/"KEBU" in code) stays the full Shopify-class commerce OS and the system of record for its stores, ecommerce orders, merchandising and customers.
- The permanent [`JOKKO-ECONOMIC-OS-ARCHITECTURE.md`](JOKKO-ECONOMIC-OS-ARCHITECTURE.md) records the economic chain, system boundaries, the Kabu ↔ Jokko contract and the system-of-record matrix. It also holds the classification of every existing merchant capability (nothing deleted, no destructive migration) and the DORMANT register.
- J5 additionally delivers the contracts that keep later phases from rebuilding merchant infrastructure (§25).

**Decision taken here, for review (§3):**
- New businesses settle customer payments to the **business wallet**.
- Existing businesses keep owner-personal settlement until their owner switches. The switch is one-way and owner-only.
- So nothing changes, at deploy, for merchants already in production.

---

## 1. Business identity / onboarding map

| Step | Route | Rule |
|---|---|---|
| Create | `POST businesses` | J3 tier + AFRI ID gates. The creator becomes the **owner** (`Business.ownerId`). Creation also opens a business wallet and a **primary location**. |
| Claim existing | none | No self-service claim exists: nobody can attach themselves to an existing business. A future Kebu-linked claim needs a verified contract (R). |
| Profile | `GET/PATCH businesses/:id/os/profile` | Name, category, description, address, phone, image (https or inline image only). Needs `business.profile.manage`. The verification fields cannot be set this way. |
| Owner authority | `Business.ownerId` | Not a member role; `owner` cannot be granted (400). Ownership transfer is **not implemented** (a gap, §22). |
| Verification | `POST …/os/verification` (owner asks), then `POST admin/businesses/:id/verification` (operator decides) | Lifecycle: unverified → pending → verified \| rejected. Only operators with `merchants.verify` (compliance) decide. Support cannot decide. The `verified` badge is kept equal to the status. |
| Locations | `POST/PATCH …/os/locations` | Primary location always exists and cannot be deactivated. |
| Settlement | `POST …/os/settlement` | Owner only, one-way to `business` (§3). |
| Operating access | `GET …/os/access` | The caller's roles and capabilities; drives the UI. |

Personal and business authority stay distinct:
- a person acts for a business only as its owner, or as an **active** member whose role carries the capability;
- invited members have no authority until they accept, and removed members lose it at once.

## 2. Business role / permission matrix

Roles are named capability sets (`lib/authz/catalog.js` `BUSINESS_ROLES`). Job titles never imply authority. Legacy J3 roles keep exactly their authority, proven by a test.

| Capability | owner | manager | cashier | inventory | fulfillment | finance | viewer |
|---|---|---|---|---|---|---|---|
| business.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| profile.manage / locations | ✓ | ✓ | | | | | |
| members.manage (within level) | ✓ | ✓ | | | | | |
| catalog.manage | ✓ | ✓ | | ✓ | | | |
| inventory.adjust | ✓ | ✓ | | ✓ | | | |
| orders.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| orders.fulfill | ✓ | ✓ | | | ✓ | | |
| orders.cancel | ✓ | ✓ | | | | | |
| refund | ✓ | ✓ | | | | ✓ | |
| charges.create (accept payments) | ✓ | ✓ | ✓ | | | | |
| charges.read | ✓ | ✓ | ✓ | | | ✓ | |
| customers.read | ✓ | ✓ | | | ✓ | | |
| activity.read (no salaries) | ✓ | ✓ | | | | ✓ | |
| analytics.read | ✓ | ✓ | | | | ✓ | |
| wallet.read (balance + all lines) | ✓ | | | | | ✓ | |
| treasury (money out) | ✓ | | | | | ✓ | |
| pay / payroll admin / payroll.read | ✓ | | | | | ✓ | |

Grant rules:
- Grants are owner-only for manager, finance and the legacy admin/cfo/ceo roles.
- Nobody grants or changes a role above their own level, and nobody changes their own role.

The lifecycle is invite → accept (invitee only) → active → role change (`POST businesses/:id/members/:subId/role`) → remove.

On a role change, the previous membership row is kept as `removed` (reason `role_changed:<role>`). Every past action therefore stays attributed to the role held at the time. Every step writes an `IdentityAuditEvent`.

The generated route matrix ([`JOKKO-J3-PERMISSION-MATRIX.md`](JOKKO-J3-PERMISSION-MATRIX.md)) covers 446 routes, all with a policy. The J5 contracts add `distribution_rep` (`business.read` + `business.distribution.invite`), plus `business.relationships.manage` and `business.distribution.manage` for owner and manager (§25).

## 3. Business wallet trace

The flow is: customer pays (order, QR charge or direct merchant pay) → kernel posting customer → `business:<id>:wallet` → business money view → refund / owner draw / payroll / transfer out.

**Settlement decision.** `Business.settlementMode` controls where payments land:
- New businesses default to `business`.
- The J5 migration sets **existing** businesses to `owner` (legacy behaviour). Brand and distribution businesses, which already settled to their wallet, keep `business`.
- The owner may switch to `business` (one-way, audited).
- `Order.settledTo` records where each order's money actually went.
- Merchant-pay **undo** (60 s window) now reverses from the business wallet when that is where the money landed. Before this fix, it would have debited the owner's personal wallet.

`GET businesses/:id/os/money` shows money by capability:

| Viewer | Sees |
|---|---|
| `wallet.read` (owner, finance) | Ledger balance plus every movement. |
| `activity.read` (manager) | Sales, refunds and fees with amounts. Payroll, owner draws, transfers and capital appear only as "Mouvement réservé", with **no amount and no reference**. |
| `payroll.read` | Payroll lines with amounts. |

Pending amounts are shown separately and are explicitly "not yet the business's money":
- open QR charges;
- B2B orders awaiting payment.

Held funds: business money is never held. A refund is paid immediately from the balance; if the balance is insufficient, the refund is refused with a clear message.

## 4. Merchant charge / QR evidence

This completes the merchant side of J4:
- **Who:** a cashier, manager or owner (`business.charges.create`) creates a fixed-amount charge, optionally with a description, a merchant reference (`externalRef`) and an order of this business.
- **Display:** the QR is shown in merchant mode.
- **States:** the cashier sees pending, paid, expired and cancelled.
- **Payer privacy:** the payer's identity is not shown in the charge list.

Tested in `tests/j5/business-ops.test.js`:
- a changed amount is refused (409);
- the payer's replay is idempotent;
- another payer's screenshot or replay is refused (409);
- an order of another business is refused (404);
- another business's cashier cannot list (403) or cancel (403);
- a double tap by the same payer with two keys debits once.

The J4 forged / changed / expired / self-pay cases still pass (`tests/j4`).

## 5. Catalog model

`lib/commerce/catalog.js`, routes `…/os/catalog`:
- `kind`: product or service (a service never tracks stock);
- title, description, image (https or inline image only);
- **SKU, unique per business**;
- category, unit label, price in ₭ (integer, > 0, capped);
- active / inactive;
- track-inventory flag, backorder flag, low-stock threshold.

Prices are server-authoritative: an order has no price or total field, and every line is re-priced from the catalog. Client-sent `unitPrice` and `totalAmount` are ignored (test).

**Variants/options are not modelled.** One product per variant for now; this is not faked.

## 6. Inventory model and concurrency evidence

`lib/commerce/inventory.js`.

Every stock change is **one conditional `UPDATE … RETURNING`** plus an **append-only `StockMovement`** row, in the same transaction:
- reasons: `sale`, `cancel_restore`, `refund_restore`, `adjustment`, `initial`;
- each row records the actor, a note, the order, and the balance after.

The database refuses UPDATE/DELETE on stock history (same guard as the ledgers). Legacy writes now go through this layer too: the old product PATCH and opening stock on product creation.

Negative stock happens only when the product (or the business) explicitly accepts backorders, and is then shown as "N en commande". Before J5, such orders silently stopped tracking stock.

Manual adjustment:
- needs `business.inventory.adjust` and a reason;
- authority is re-checked inside the transaction;
- the row is locked `FOR UPDATE`.

| Concurrency case | Result |
|---|---|
| Two customers, last unit, simultaneously | Exactly one order; the loser is not charged; stock is 0; one `sale` movement. |
| 4 sales + 3 adjustments concurrently | Final stock = Σ movements. |
| Second line out of stock after the payment step | Whole transaction rolled back: no money, no order, no stock change. |

## 7. Order state machine

`lib/commerce/orders.js`:

```
pending_payment (B2B credit / COD only)
confirmed (paid, awaiting the merchant)
  → preparing (merchant accepted)
     → ready_for_pickup → completed
     → out_for_delivery → delivered → completed
exceptions: cancelled (before dispatch, full refund + stock back)
            refunded  (after delivery/completion, full refund)
```

Who may do what:
- **Merchant moves** (`business.orders.fulfill`): only the listed transitions, and pickup vs delivery must match.
- **Customer:** may complete only after delivered / ready, and may cancel only before the merchant starts.
- **Merchant cancel:** up to ready/pending-delivery.
- **Refund:** only after delivered/completed.

Every transition locks the order `FOR UPDATE` and writes conditionally on the old state. A stale or offline device therefore gets 409 and is never applied twice.

New paid orders start as `confirmed` (pre-J5 pickup orders jumped straight to "ready"). The legacy `PATCH marketplace/orders/:id/status` now uses the same locked machine, by capability, not owner-only.

## 8. Cancellation / refund evidence

Refunds are J2 **compensating entries** (`merchant_refund`) from the account that actually received the payment:
- the reference is `order-refund:<orderId>`, which is deterministic, so a retry, a duplicate request or a concurrent second click can **never refund twice**;
- the original payment is never edited;
- the refund links to the original in the customer's history.

| Case | Result |
|---|---|
| Customer cancels before preparation | Full refund (system-authorized policy `buyer_cancellation_before_fulfilment`) and stock restored from the order's own `sale` movements. Replay is a no-op. |
| Merchant cancel | Needs `orders.cancel`. Cashier and fulfilment are refused. Full refund and stock back. |
| Refund after completion | Needs `business.refund`. Two concurrent refunds → paid once. Restock only when `restock: true` (goods came back). |
| Over-refund through the J4 payment primitive after a full order refund | 409. |
| Another merchant refunds or cancels the order | 404 (both via its own path and by guessing ours). |
| Delivery already taken by a rider | 409 `delivery_in_progress`. Nothing changes; it goes through delivery/dispute instead. |
| Legacy owner-personal settlement | Staff cannot debit the owner's personal wallet (403); the owner can. |
| Split payment (affiliate commission) | Refused as `refund_unsupported` rather than refunding wrongly. |
| B2B credit / invoice | Refused as `refund_unsupported`. |
| Refund response lost | Same-key retry replays; a fresh key replays too (deterministic reference). |

**Partial order refunds: NOT implemented.** Full refunds only for orders. The J4 amount-only payment refund remains for payments.

The J4 refund primitive now uses `business.refund` instead of `business.treasury`. A manager can refund a customer without gaining the power to move money out.

## 9. Customer / privacy evidence

- **Merchant order view:** the customer's name and handle only. The delivery address is shown only to roles that fulfil. No buyer id, phone, email, date of birth, ID number or balance (test regex).
- **`…/os/customers`** (`customers.read`): name, handle, and order and payment counts and totals **with this business only**.
- **Charge lists:** do not show who paid.
- **Support lookup:** no customer or owner PII (owner handle only).

The data-exposure sweep covers every new GET route with other businesses' ids (§18).

## 10. Payroll boundary / status

Payroll already operated (J3-hardened). The J5 boundary:

| Aspect | Status |
|---|---|
| Who | Only roles with `business.pay` / `business.admin` / `business.payroll.read` (owner, finance; legacy hr_admin/admin/cfo/ceo). Cashier, manager, inventory and fulfilment are refused (tested). |
| Employee identity | A K21 user by handle. Being on payroll grants **no** business authority (J3). |
| Amount and schedule | `PayrollEmployee`. |
| Posting | Kernel `payroll_payment` from the business wallet, with risk gate and idempotency. |
| Run record | **Now written in the same transaction** as the payment. Before, it was written afterwards, so a crash could leave a payment with no run record. |
| Visibility | Salaries are hidden from `activity.read`-only roles (tested). |

No HR suite was built.

## 11. Analytics reconciliation

`GET …/os/analytics?period=today|7d|30d|90d` (`analytics.read`) reports:
- sales gross / refunds / net from the **ledger**;
- sales by source (orders / QR charges / direct payments);
- order counts by status, paid count and average order value from orders;
- top products from paid, non-cancelled orders;
- inventory movement by reason.

The reconciliation block maps **every** ledger sale to its source (an order or a charge with the same amount, or a direct payment) and reports `ok` only when nothing is unmatched.

The test case:
- 4 orders (600) + 1 QR (250) − 1 cancellation (100);
- result: gross 850, refunds 100, net 750, by source 600 / 250 / 0;
- the business wallet ledger balance equals net (750);
- reconciliation `ok: true`.

Orders settled to an owner's personal wallet (legacy) are reported separately (`ownerSettledOrdersKori`), not mixed into the business ledger figures.

There is no trending or fake data.

## 12. Multi-location architecture / status

- `BusinessLocation` with exactly one primary per business; more can be added.
- `Order.locationId` and `MerchantCharge.locationId` record where things happen.
- `StockMovement.locationId` is reserved for per-location stock.

**Status:**
- **Stock:** still single-location (`Product.inventory` is the primary location's stock).
- **Staff:** permissions are business-wide.

Location-scoped stock and staff need no redesign: add `locationId` to stock balances and to memberships. They are deferred to J6+.

## 13. Support tooling / status

`GET admin/businesses/lookup?q=` takes a business id, Kebu id, name, order id or reference, or a charge code. It needs `businesses.read` (support, risk, compliance) and returns:
- verification and settlement mode;
- staff with roles and lifecycle dates;
- authority history (identity events);
- order counts by state;
- refunds with references;
- charge states;
- wallet balance, with a settlement-integrity check (ledger = projection);
- `canSupportChangeAnything: false`.

Routes that are refused:
- sysadmin: 403;
- user token: 401/403.

A precise payment reference goes to the existing `GET admin/money/lookup`. Verification decisions are a separate, permissioned, audited operator action. No raw database access is needed for routine support.

## 14. Merchant security / adversarial results

| Attack | Result |
|---|---|
| Claim someone else's business / invite oneself / edit their profile / switch their settlement | 403 everywhere. |
| Forge a staff invitation (accept another person's invite) | 404; the row stays `invited`. |
| Grant yourself owner / role above own level / own role change | 400 / 403 / 403. |
| Removed employee acts (sequential and racing the removal) | Refused after removal. Each committed cancellation refunded exactly once; refused ones moved no money. |
| Cashier accesses payroll / money / analytics / customers / catalog / stock | 403. |
| Employee of business A acts on business B (orders, refund, charges, catalog, stock) | 403/404. |
| Price manipulation (client `unitPrice`/`totalAmount`) | Ignored; server price. |
| Quantity manipulation (0, −1, 21, 1.5) | 400. |
| Oversell race | One order (§6). |
| Duplicate order (same key ×3 concurrent + replay) | One order, one debit, one decrement; replay names the same order; the intent reads `completed`. |
| Duplicate payment / duplicate refund / refund > paid | Once / once / 409. |
| Refund another merchant's order | 404. |
| QR replay / forged QR | 409 / 404 (J4 + J5). |
| Order state jump; customer drives merchant state; merchant does the customer's confirmation | 409; 403/404; 403/404. |
| Media/attachment hijack (`javascript:`, `data:text/html`, bare private storage path, plain http) | 400 on catalog and profile. Private media are only reachable through short-lived signed URLs. |
| Business-wallet enumeration | 403/404 with no balance in any body. |
| Salary leakage | Restricted lines carry no amount or reference; payroll routes 403. |
| Customer PII leakage | None (§9, sweep). |

Sources: `tests/j5/business-roles.test.js`, `commerce-loop.test.js`, `business-ops.test.js` and `failure-concurrency.test.js`. J2 invariants are checked after every test.

## 15. Failure / concurrency results

| Brief case | Result |
|---|---|
| Two customers buy the final item | One order (§6). |
| Payment succeeds but the response fails | Same-key retry replays the order (J4 idempotency keeps the row once money moved). |
| Order creation retries | One order. |
| Refund response is lost | Replay, one refund. |
| Inventory update collides | Σ movements = stock. |
| Employee removed while processing | In-transaction authority check (`FOR SHARE` on the active membership vs the removal's UPDATE). |
| Merchant device offline / stale | 409; never re-applied. |
| Duplicate webhook | Orders and charges involve no provider callbacks (closed loop). Provider duplicates stay covered by J4 cash-in/out tests. |
| Service restart mid-order | A single transaction: all or nothing (mid-order failure test). |

## 16. Mobile merchant UX evidence

`src/screens/BusinessOSScreen.js` ("Mode commerce", from the business hub) has these sections:

| Section | What it does |
|---|---|
| Aujourd'hui | Tiles: new / preparing / ready orders, pending QR, low stock, today's sales. |
| Encaisser | Amount + description + reference → QR; states; recent QR. |
| Commandes | Next-step buttons, cancel/refund with required reason and one intent key per attempt. |
| Produits | Add a product/service; activate/deactivate. |
| Stock | Adjust with a reason. |
| Clients | Customer list. |
| Équipe | Invite, change role, remove. |
| Activité | Balance if allowed, net sales by period, reconciliation badge, movements with "réservé" lines. |
| Réglages | Verification, settlement switch, locations. |

**What each role sees:** sections and buttons appear only for the caller's capabilities (`src/lib/business-ux.js`, unit-tested):
- a cashier sees Today / Encaisser / Commandes only;
- a viewer sees Today only.

**Phone layout:** 44 px minimum touch targets, 16 px inputs, French copy, horizontally scrolling section chips.

**Fix:** the hub's "Encaisser" button used to open *pay a merchant*; it now opens merchant charges.

**Not built (by the boundary):** catalog bulk import, photos upload flow beyond the existing picker, printing. Kebu's store builder and advanced analytics are not duplicated (R).

## 17. J2 invariant results

`assertInvariants` runs after every J5 test. Further results:
- `money:check` on the gate DB: OK (995 entries, 2 047 postings, 650 accounts after the full suite);
- after load, sweep and soak: OK;
- rehearsal: ok after the J4 and J5 flows on migrated data.

## 18. J3 authorization sweep results

The sweeps now resolve J5 sub-objects to other businesses' own rows:
- `os/orders/:subId` → foreign orders;
- `os/stock|catalog/:subId` → foreign products;
- `os/locations/:subId` → foreign locations.

All new GET routes are in the data-exposure sweep. Result: **3/3 pass** on the final gate DB, after the full suite:
- 134 authenticated GET routes probed by an unrelated multi-role attacker: no PII, balance, secret or raw-row leak; no foreign 2xx (someone else's address only at area precision); no 5xx.
- Every admin route refuses a user token.
- **112 mutating id-routes / 217 calls** on other people's objects (orders, products, stock, locations, relationships, integrations, invitations, charges, refunds…): all refused; money invariants intact.

An earlier gate run surfaced one pre-existing 500 in agent withdrawal confirmation; it is fixed (`ccd8310`).

## 19. J4 money regression results

All J4 suites run in the gate: journeys (cash, pay), intents, money-UX, account-open race and lock order. All pass in the gate (the 26 tests in `tests/j4`).

Pre-J5 tests updated to the **decided** behaviour (not weakened):
- merchant pay and marketplace orders settle to the business wallet;
- a paid pickup order starts `confirmed`;
- a buyer driving merchant states gets a non-disclosing 404;
- `owner` is not a grantable role (400).

## 20. Full fresh-database gate

Fresh database `joko_j5_gate`, **commit `fa0700c`**:

| Step | Result |
|---|---|
| Fresh DB + `test:db:setup` | exit 0 |
| `npm test` (unit, integration, security, http, money, j3, j4, **j5**) | **479 / 479 pass**, 0 skipped (J4 gate: 440) |
| `money:check` | OK |
| `test:load` | 3 / 3 |
| `test:sweep` | 3 / 3 (134 GET routes; 112 mutating id-routes, 217 calls) |
| Soak 5 × 1 000, no retries (J2/J4 money regression) | 5 000 sends, **0 failures**, invariants ok, p99 ≤ 340 ms |
| Message-request migration dry run | exit 0 |
| `prisma migrate diff` migrations ⇄ schema | no drift |
| `money:check` after load / sweep / soak | OK |
| Production-shaped rehearsal | **16 / 16** (J4 + J5 steps) |
| `db-migrate-deploy.mjs` without activation | inert, exit 3 |
| `tsc --noEmit` | 5 errors, all pre-existing in `supabase/functions/cron-proxy/index.ts`; none from J5 |
| `expo export --platform web` | exit 0 |
| `npm audit --omit=dev` | 42 (13 moderate, 29 high, 0 critical), unchanged |

Earlier gate runs, disclosed:
- `1a0a49c` found the new-business wallet race (fixed in `2b3e3f1`);
- `2b3e3f1` found the agent-withdrawal 500 (fixed in `ccd8310`).

This final run is on the head that includes the economic-OS contracts.

## 21. Production-shaped migration rehearsal

Migration `20261008000000_j5_business` changes the schema additively:
- new tables `BusinessLocation` and `StockMovement` (append-only);
- nullable or defaulted columns on Business, Product, Order and MerchantCharge;
- a unique index on `(businessId, sku)`. It only affects new SKUs, because every existing SKU is NULL.

It also makes **behaviour-preserving data updates**:
- existing non-brand businesses get `settlementMode = 'owner'`;
- `verified = true` maps to `verificationStatus = 'verified'`.

**Bug found by the rehearsal:**
- The migration referenced `joko_ledger_append_only()`. That function is installed by the guard SQL the deploy step runs **after** migrations, so `migrate deploy` failed on the production shape.
- Fixed: the migration defines it (`CREATE OR REPLACE`, same body).

The J5 rehearsal step shows, on migrated data:
- the existing shop keeps owner settlement;
- verification is mapped;
- the stock guard exists;
- a real order + customer cancellation pays 400 / refunds 400 with stock 6 → 4 → 6;
- invariants are ok.

Result: **16 / 16 ok.** The J5 step, on the 2026-08-17 production shape after both J5 migrations:
- the existing shop keeps `owner` settlement;
- `verified` maps to `verificationStatus = verified`;
- the stock guard is present;
- a real order + customer cancellation pays 400 / refunds 400, with stock 6 → 4 → 6;
- invariants are ok.

The J5-contracts migration is additive. Existing distribution/brand businesses get `operatingMode = distribution`; nothing else changes.

## 22. Unresolved risks / product gaps

1. **Settlement of existing merchants.** They keep owner-personal settlement until the owner switches. Moving them by default is a product decision; it should come after read-only production inspection.
2. **Not implemented:**
   - partial order refunds;
   - variants/options;
   - business ownership transfer;
   - self-service claim of an existing (e.g. Kebu-registered) business;
   - per-location stock and location-scoped staff;
   - expenses (no expense model exists; activity shows sales / refunds / fees / payroll / payouts / adjustments only).
3. **Refunds that need people:** split-payment (affiliate) and B2B credit refunds are refused and need support.
4. **Funds can run short:** a business wallet without enough balance cannot refund. The refund is refused with a clear message; there is no negative balance or credit line.
5. **Fees** remain 0 (D18).
6. **Pre-existing:** 5 `tsc` errors (Deno `cron-proxy`) and 42 `npm audit` advisories. Both unchanged since J3.
7. **Production** is still unverified (BLOCKED workstream).
8. **Partner (Kabu) collections settle to one configured wallet**, not to the selling merchant's business wallet. This is classified "migration needed" (architecture §3, §14). Fixing it is a J2 recipe change (provider cash-in → business account) plus a decision on existing partner settlement.
9. **Catalog surfaces overlap:** the legacy merchant catalog screen and the Business Lite catalog both exist. They should converge on `lib/commerce/catalog.js`, without destructive migration (classified LEGACY/DUPLICATIVE).
10. **Kabu adapters are contracts only:** order mirroring, payroll instructions, logistics and webhooks to Kabu need the Kabu-side build. None is faked.

## 23. Exact commits

All on `claude/jokko-forensic-audit-rprqia` (pushed; no PR; nothing deployed):

| Commit | Content |
|---|---|
| `b9c04c0` | D18–D20 recorded; request UI shows expiry / limit states; fees fail closed |
| `f32e290` | J5 core: capability roles, identity, settlement, catalog, inventory, order state machine, cancellations / refunds, business money / analytics / customers, support tooling; migration `20261008000000_j5_business` |
| `2a8419b` | Merchant mode UI; failure / concurrency + adversarial suites; safe media references |
| `1a0a49c` | Sweeps cover business-OS sub-objects; rehearsal J5 step; migration guard-function fix |
| `2b3e3f1` | Race-safe first wallet / primary location (gate finding) |
| `ccd8310` | Agent withdrawal customer-funds refusal is 400, not 500 (sweep finding) |
| `b1a9083` | Economic-OS architecture + contracts; migration `20261009000000_j5_economic_contracts` |
| `fa0700c` | Permission matrix regenerated (446 routes) — **gate commit** |
| `314c7fc` + this commit | Report |

## 24. Recommendation for J6

Proceed to J6 only with production verification still a parallel workstream. Recommended focus, in order:
1. **Production readiness of J2–J5:**
   - unblock read-only production verification;
   - inventory existing merchants;
   - decide their settlement move;
   - only then plan baselining (D2/D3) and the first deploy.
2. **Commerce completion that needs no new architecture:**
   - partial refunds (line-level, with stock);
   - variants as separate stock-keeping units;
   - ownership transfer with dual confirmation;
   - per-location stock (`locationId` on stock balances).
3. **Operational quality:**
   - Sentry/alerts on refund failures, `completed_response_lost` and reconciliation `ok: false`;
   - the morning admin checklist wired to `admin/businesses/lookup`.
4. **Kabu ↔ Jokko activation:**
   - use the business link that now exists;
   - decide and build per-merchant settlement of partner collections (J2);
   - deliver signed outbox webhooks to Kabu.
5. **Keep the boundary:** no rides, logistics network, gig marketplace, B2B wholesale network, social product or ERP. The Kebu → Jokko business link waits for a real contract.

## 25. Economic-OS contracts added to J5 (no restart, no premature J8)

Additive migration `20261009000000_j5_economic_contracts`.

| Requirement | What exists now | Status | Evidence |
|---|---|---|---|
| Omnichannel | `Order.sourceChannel / sourceSystem / externalOrderRef`; channel registry with adapters (`lib/commerce/channels.js`) | Jokko app, QR, Mbolo, POS, payment link ACTIVE; Kabu, Askaan, web, WhatsApp, restaurant DORMANT (refused) | outbox test |
| Payment acceptance | One `PaymentRecord` per accepted payment, with `settlement` = `jokko_ledger` (J2 entry referenced) \| `off_ledger_cash` \| `external`. Written in the same transaction for QR charges, orders and direct merchant pay. | Cash/manual sales recorded, **never Jokko money** (not in wallet, not in ledger totals). SoftPOS / device tap / provider rail / online checkout DORMANT (refused; listed as such by `GET commerce/capabilities`). Payment link ACTIVE: same opaque charge reference, https `payUrl`, deep link. | `economic-contracts` "one payment model" |
| Distribution business type | `Business.operatingMode` (owner-only, audited); `Territory`; `distribution_rep` role; B2B orders, trade accounts and invoices reused | Relationships ACTIVE; routes / collections / returns DORMANT (J7/J8) | |
| Merchant acquisition | `MerchantRelationship`: introducer, organization, rep, territory, dates, status, assisted flag, explicit scopes. The merchant accepts with `business.relationships.manage`; assisted onboarding attaches only a business the person owns. | Invitation = **no ownership, no membership, no access**. Distributor owner / manager / rep get 403/404 on every merchant route before **and** after acceptance; reps see only their own introductions; rival distributors see nothing. | `economic-contracts` distribution + assisted onboarding |
| Trade-credit-ready | Net 7 / 15 / 30 / 60 / 90 / monthly / COD as **supplier-granted** terms only; full concept map in architecture §7 | **Fix:** COD was self-selectable with a default limit; it now needs a supplier grant. Financing (IAWIC / partners) DORMANT; nothing simulated. | `economic-contracts` credit test (all terms refused without a grant) |
| Address | `Address` with West-African structure, purposes, visibility, verification state | Homes never public; a customer's delivery address is visible only to that business's **fulfilment** roles while the order is active; others get the area only | `economic-contracts` address test + data-exposure sweep |
| Fulfilment contract | `Order.fulfillmentOwner` (merchant \| jokko), `inventoryLocationId` | Jokko Fulfilment DORMANT (refused `fulfillment_not_activated`) | |
| Logistics contract | `CommerceEvent` outbox written in the same transaction (order.paid / accepted / ready_for_fulfillment / out_for_delivery / delivered / completed / cancelled / refunded, payment.recorded, relationship.*); payloads are ids and amounts only | J8 consumer DORMANT; no logistics logic in payment handlers | outbox test |
| Inventory locations | `InventoryLocation` (store / warehouse / distributor_depot / jokko_fulfillment_center / pickup_hub); primary created race-safely; every movement and order records it | Per-location stock positions DORMANT (additive later) | |
| Demand intelligence | `demandAggregates()`: category × region, k ≥ 5 distinct businesses, small cells suppressed, no business identity | OpportunityOS consumer DORMANT; no route | k-anonymity test |
| Kabu ↔ Jokko | `ExternalLink` + `BusinessLinkCode`: owner one-time code + partner key; single-use, unique, revocable; versioned contract (`KABU_CONTRACT`) | Payments / payouts ACTIVE (Partner API). Per-merchant settlement of partner collections is **classified "migration needed"**: today they settle to one configured wallet, and routing them to the linked business wallet is a J2 recipe change outside J5. | Kabu link test |
| Business Lite scope | Settings explain Lite vs Kabu Shop; no Kabu-class features added | Guard in architecture §16 | |

Other fixes made while integrating:
- The customer's "order received" confirmation now uses the locked, evented transition (it used an unlocked legacy update).
- Agent withdrawal confirmation maps a customer-funds refusal to 400 (it was a 500, found by the sweep).
