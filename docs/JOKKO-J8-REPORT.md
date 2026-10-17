# Jokko J8 final report: Movement, logistics & fulfilment (internal pilot)

**Branch:** `claude/jokko-forensic-audit-rprqia`.
- **Gate commit:** `1dbb77e` (latest code).
- **After the gate:** `dfefaf0` and this report are documentation-only.
- **Scope:** built and proven **locally**. Nothing was deployed, no PR was opened, production was not read or changed, and the Kebu Supabase project was not touched. The deploy step stays inert (exit 3).

> **The P0 incident remains OPEN. Production is NOT protected.** The delivery-dispute emergency patch is authorized but **not deployed**: Vercel team access still returns 403.
> **New warning (incident §8):** the default branch head `19ac203` renders a blank app (a missing import). The patch must go on **`7d262de`**, never on `19ac203`.

**Verdict: the J8 internal-pilot gate is met locally**, with the honest limits in §6. Every completion criterion was run at the latest HEAD.

| Criterion | Status |
|---|---|
| Backend gates pass at the latest HEAD | ✅ §1 |
| Primary user interfaces work | ✅ 4 screens + browser E2E 12/12 (§3) |
| 40-merchant distribution scenario passes | ✅ §4 |
| Buyer catalogue mapping is safe | ✅ D40 (§2.5) |
| Legacy courier exposure addressed locally | ✅ D41 (§2.6) |
| Financial / custody / privacy guarantees hold | ✅ I1–I21, L1–L8, sweeps (§1) |
| Documentation and decisions updated | ✅ D34–D41, design §17, J9 plan |

---

## 1. Latest-HEAD gate (`1dbb77e`, fresh database `joko_gatefinal`)

| Check | Result |
|---|---|
| `test:db:setup` (schema + guards) | exit 0 |
| `npm test` (unit → J8; 42 J8 test cases) | **616 / 616** |
| `money:check` (J2 I1–I21) after the suite / after load + sweeps | exit 0 / exit 0 |
| Logistics invariants L1–L8 after the suite / after everything | ok / ok |
| `test:load` | 3 / 3 |
| `test:sweep` | **5 / 5** |
| ↳ authorization boundary | 41 critical user routes: 36 authorization reached and refused, 3 accepted (public by design), 2 business-rule refusals (public by design) |
| ↳ operator permission | 61 operator routes, each refused without the permission |
| ↳ data exposure, admin refusal, mutation sweeps | pass |
| Web export at HEAD | ok |
| **Browser E2E at HEAD** (Chromium, the exported app, production-mode API) | **12 / 12**, no page errors, invariants ok after |
| Migrations vs schema (`migrate diff --exit-code`) | exit 0 (no difference) |
| Production-shaped rehearsal | **19 / 19**; the J8 step now includes the pilot migration (`UnmatchedReceipt` guard, courier acceptance) |
| Deploy inert without activation | exit 3 |
| `tsc --noEmit` | the same 5 pre-existing errors, all in `supabase/functions/cron-proxy/index.ts` (Deno) |
| `npm audit --omit=dev` | 44 (13 moderate, 31 high, **0 critical**; critical was 1 before the `shell-quote` override) |

The 40-merchant scenario (§4) is part of `npm test` and passed inside the 616.

## 2. What changed for the pilot

### 2.1 Final decisions (`docs/JOKKO-DECISIONS.md`)
| # | Decision |
|---|---|
| D34 | Seller self-reported delivery is labelled unverified (`seller_self_reported`, `deliveryVerified: false`). Jokko-managed delivery is always tracked. |
| D35 | 150 Kori / 80 % / 24 h is test configuration only. Activation stays off. |
| D36 | COD disabled; no courier or agent shortcut. |
| D37 | Failed-delivery compensation is configurable, funded from the held fee, paid only for a **confirmed** side, and defaults to **0**. |
| D38 | No automatic clawback of settled earnings. |
| D39 | No ordinary mid-route handoff. Emergency reassignment never duplicates custody or earnings. |
| D40 | Supplier product ids never enter a buyer's stock or catalogue. |
| D41 | The legacy open-claim courier marketplace is closed to new usage. |

### 2.2 Failed deliveries (D37)
**The model:**
- A courier's reason is a **claim** with a side: receiver, source, courier, safety or platform.
- The side is confirmed by the party on that side (in-app agree / contest) or by an operator ruling (`logistics.exceptions.resolve`, audited).
- When the goods are back, `settleFailedAttemptInTx` pays the configured share (`failedAttemptBps`, receiver / source only, ≤ courier share) and refunds the rest, once.

**Tested:**
- an unconfirmed claim earns nothing;
- a receiver-confirmed claim at the 50 % **test** rate pays 75 and refunds 75;
- a claim contested and then rejected by an operator earns nothing;
- a courier-side reason is never compensated, even "confirmed";
- the courier and the source cannot confirm a receiver-side claim.

### 2.3 Emergency reassignment (D39) and acceptance
- Courier offer → accept / decline. A decline returns the shipment to dispatch, with no residual access.
- **Emergency reassignment** (dispatcher for own fleet, ops for Jokko; reason; audited):
  - the new courier holds nothing until a **bound handoff code** is used;
  - every custody act requires the custodian.

**Tested:**
- before the handoff, the new courier gets `handoff_pending` and the old courier gets 404;
- a third courier cannot use the code;
- exactly one earning goes to the courier who delivered.

### 2.4 Refusals at the door, route reconciliation
- Refused units leave with the same courier on an automatic return shipment.
- The depot receives them per line, once.
- A refusal after the courier has left is refused (`refusal_requires_courier`).
- Reconciliation totals balance to `unaccounted = 0`, and a route is `closed` only when everything is terminal.

### 2.5 Buyer catalogue mapping (D40): the contamination gap is closed
**Before:** J8 receiving credited the **supplier's** product id into a buyer-side depot position. That position was invisible to the merchant's real stock (J5 `Product.inventory`).

**Now:**
- A mapped line goes to the buyer's **own** product (J5 `StockMovement` `receive_purchase`).
- An unmapped line becomes an `UnmatchedReceipt`: in no stock position, resolved once, guarded by a DB trigger.
- Mapping requires `business.inventory.adjust`, and only for supplier products the buyer actually bought.
- Mapping into another business's product is refused (404).
- Transfers accept only the business's own products.
- L5 was rewritten to reconcile both paths.

**Tested:** in the API suite, the browser E2E and the 40-merchant scenario. No supplier product row exists in any other location.

### 2.6 Legacy consumer delivery (D41)
**Audit:** the legacy open-claim marketplace has three weaknesses:
- any approved driver may claim any task;
- pickup is a unilateral courier tap (no source proof);
- the merchant has no proof of handover.

The J8.0 fixes remain: no auto-pay, operator-only disputes, no self-dealing, server fee.

**Change (default off: `LEGACY_CONSUMER_DELIVERY_ENABLED`):**
- **Refused:**
  - new `POST deliveries` (410);
  - claiming an open task (410; no money is held before acceptance);
  - the nearby listing (empty);
  - hub last mile (409, after the ownership check).
- **New consumer delivery orders** are **verified J8 merchant-fulfilled shipments**:
  - the customer's code proves delivery;
  - no courier fee is taken;
  - the merchant cannot mark a carried order delivered;
  - cancelling before pickup cancels the shipment.
- **Preserved:** in-flight accepted tasks complete (tested: the rider is paid the escrowed fee once), and historical rows are untouched.
- The legacy suites now opt in explicitly. `tests/j8/legacy-retired.test.js` proves the default.

### 2.7 Dependency advisory: `shell-quote`
- **Affected package:** `shell-quote@1.9.0`, a dependency of `react-native@0.86.0 → react-devtools-core@6.1.5`.
- **Advisory:** GHSA-pqg4-j6r4-53mv, CVSS 8.1. Command injection in **`quote()`**. Affected `>=1.8.4 <1.11.0`.
- **Reachability:**
  - the only caller is React DevTools' standalone "open in editor" helper (`src/editor.js`, bundled into `standalone.js`);
  - it calls **`parse()`**, not `quote()`, and runs only when a developer launches standalone DevTools;
  - it is not in the `/api` runtime and not in the web bundle;
  - **not reachable in our build or dev workflow as used.** That is still not grounds to dismiss it.
- **Fix:** `package.json` `overrides: { "shell-quote": "1.12.0" }`.
  - Only one package changed in the lockfile.
  - `parse` / `quote` API sanity check passed.
  - The full suite, web export and E2E all pass at HEAD.
- **Remaining risk:** `react-devtools-core` bundles its own copy of `shell-quote` inside `standalone.js`, which the override cannot change. That copy is reachable only through `parse()` in a developer-launched tool. It goes away when React Native ships a newer `react-devtools-core`.

### 2.8 Defects found by browser testing (fixed)
1. **Blank app:** `RootNavigator` used `GiftRevealScreen` without importing it. Present since `494991d` (2026-08-02), on web and native. Also on the default head `19ac203` (incident §8).
2. **Accessibility:** `PressScale`, the shared tappable, silently dropped `accessibilityLabel`. Icon-only buttons (steppers, back arrows) had no accessible name for screen readers. It now forwards label, hint, role, state and testID.

## 3. Interfaces (built, wired, browser-tested)
Every primary action maps to one authorized server transition. No hard-coded success, GPS, ETA, map or simulated coverage.

| Screen | Users | Covered in browser E2E |
|---|---|---|
| `ShipmentScreen` | all parties (server-shaped role) | **covered:**<ul><li>accept</li><li>pickup code issued on the source's screen, then typed by the driver</li><li>wrong code refused</li><li>arrival</li><li>per-line receiving with damage</li><li>customer delivery code</li><li>failure declared, then contested in-app</li><li>commercial order and payment shown separately</li></ul> |
| `CourierWorkScreen` | Jokko courier, fleet driver | **covered:** offered vs active work (no open marketplace); Gains tab shows the held earning and nothing payable<br>**API-tested only:** payout |
| `DeliveriesScreen` | customer, merchant | **covered:** my deliveries; incoming supplier shipments; unmatched receipt mapped to my own product |
| `DispatchScreen` | distributor | **covered:** PO → tracked hand-off; driver assignment; 2-stop route creation; reconciliation view |

**Entry points:**
- Business hub → Dispatch / Réceptions;
- Plus → Mouvement → my assigned deliveries / my receptions.

The legacy "request a courier" button now explains the change and opens Réceptions.

**Run:** `npm run test:e2e:j8`. It needs a web export, `playwright-core` and Chromium. It is local only and not part of `npm test`.

**Manual testing still required (not automated):**
- native iOS / Android (camera, keyboard, offline behaviour on a real device and network);
- screen-reader passes;
- low-end-device performance;
- the pickup-point desk and dispute-evidence screens (API-tested; no browser run);
- emergency reassignment and operator rulings, which are API / ops actions with **no** consumer UI.

## 4. The 40-merchant pilot scenario (`tests/j8/pilot-40-merchants.test.js`)
**Setup:**
- 1 distributor and 1 depot (3,000 units);
- **40 merchants, 40 separate POs:** 30 due-now, paid; 10 net-30, invoiced at verified delivery;
- **1 planned route** of 40 stops (driver 1) and a re-delivery route (driver 2);
- **40 independently verified receiving events**, each by its own merchant, each with receiver proof.

**Outcome mix (all tested):**
- full;
- partial (missing);
- damaged;
- refused entirely;
- partial refusal;
- **wrong-merchant code** (refused);
- **duplicate confirmation** (replayed, never overwrites);
- **network retries** on pickup and delivery (replayed);
- failed (closed) → back to the depot (stock re-credited and re-reserved) → re-delivered;
- mixed missing + damaged.

**Measured result:**
- **Route 1:** 948 dispatched = 700 received + 20 damaged + 13 missing + 107 refused back at the depot + 108 returned for re-delivery. **Unaccounted 0**; both routes closed.
- **Every unit that left the depot is accounted for exactly once:** received (merchant stock or unmatched), damaged, or missing. No stale reservation.
- **Delivered ≠ accepted:** every PO with a discrepancy is `disputed`, never a false `received`.
- **Merchant inventory:** mapped merchants' own products = received units; unmapped merchants hold the same as unmatched receipts. Zero supplier-product rows outside the depot.
- **Money:** the distributor was paid exactly the 30 due-now orders, once each. There are 10 net-30 invoices, one per order, never merged, with principal = order total.
- J2 and custody invariants hold.

**Pilot finding (not weakened):** the scripted loading is faster than any human, and the J3 per-user limiter (80 requests / minute → 15-minute block) blocked the distributor. The test clears the limiter's window between steps to simulate real time. A very busy dispatcher on one account could hit this limit in real life. **Decision needed:** role-aware limits.

## 5. Dormant / not activated
| Capability | Status |
|---|---|
| Jokko Logistics (operated by Jokko) | **GATED**, off; the fee is test configuration only (D35) |
| COD | DORMANT (D36) |
| Failed-attempt compensation | configurable, **0 by default** (D37) |
| Intercity / regional, fulfilment centre, rides, placement intelligence | DORMANT / architecture only |
| Legacy open-claim courier marketplace | closed to new usage (D41) |
| Hub last mile | closed (no verified last mile yet) |
| GPS / ETA / route optimisation | not built, not claimed |

## 6. Unresolved risks
1. **The P0 is unpatched in production.** Deploy on `7d262de` only.
2. **Proof limits:** a code proves that the counterpart's account confirmed the handoff, not physical presence. Collusion between receiver and courier is undetectable by design.
3. **Rate limiter vs. dispatch volume** (§4), pending a decision.
4. **J7 returns from buyer stock:** when a buyer returns goods, its mapped product stock is not auto-decremented. The buyer adjusts manually. This is documented, not faked.
5. **Native / manual / screen-reader testing** is still required (§3).
6. **The bundled `shell-quote` copy inside `react-devtools-core`** (dev-only, `parse()` only) remains until upstream updates.
7. **Scale evidence:** 3,000 shipments, 2,000 destinations, 1,000 assignments, and one 40-stop route on local Postgres. This is not national-scale evidence.
8. **Legacy open tasks** from before D41 remain `open` with nothing held. A read-only production inspection should count them before go-live.

## 7. Commits since the J7 decisions (`7998f50`)
**Before this phase:**

| Commit(s) | What |
|---|---|
| `948f2a6` | P0 fix |
| `87c82ac`, `06b3757`, `d5e886e` | P0 incident record and deployment log |
| `eaae7e4`, `8329a98`, `862d5d2` | authorization-boundary gate and its fixes |
| `59ec419` | J8 schema |
| `1fc4f89` | J8.0 legacy fixes |
| `c4cd657`, `6256a4d`, `e4ed40a`, `4f92784`, `0ba6867`, `c6da928`, `c3f41d0`, `9160ec2` | J8 backend |
| `7a69abf`, `fa01818` | J8 backend report |

**This phase:**

| Commit | What |
|---|---|
| `f01485a` | decisions D34–D40 and pilot backend: failure evidence, reassignment, refusals, reconciliation, mapping |
| `5e0bb89` | D41 legacy closure, consumer orders onto J8, `shell-quote` override |
| `297f045` | four J8 screens |
| `5e33c3e` | browser E2E, blank-app fix, accessibility fix |
| `a5cd3f5` | E2E routes and failure |
| `256ba42` | 40-merchant pilot |
| `1dbb77e` | rehearsal for the pilot migration (**gate commit**) |
| `dfefaf0` | design doc §17 and J9 plan (documentation only) |

## 8. J9 — Work & Opportunity
The plan is in `docs/JOKKO-J9-PLAN.md`. **It is not started.**

**Prerequisites:**
- deploy and verify the P0 patch on `7d262de`;
- the owed read-only inspections;
- finance approval of rates (all J9 rates start at 0 and inactive);
- a decision on the rate limiter.

**First slices, in order:**
1. Couriers and drivers as workers (the J8 earnings already exist).
2. Pickup-point fees on verified releases.
3. Distribution-rep commission only on **received** first orders.
4. Gigs stay dormant until completion is verifiable and escrow is funded.
