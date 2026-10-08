# Jokko J8 gate report: Movement, logistics & fulfilment network (local)

This report covers branch `claude/jokko-forensic-audit-rprqia`, built on the accepted J7 gate (`eb7d7cb`, report `afc54bb`, decisions `7998f50`).

**Scope and limits:**
- J8 was built and proven **locally only**. Nothing was deployed and no pull request was opened.
- Nothing in production was read or changed during J8. The Kebu Supabase project was not touched.
- The database deployment step stays inert: `db-migrate-deploy.mjs` exits 3.

> **The P0 incident stays OPEN. Production is NOT protected.** The emergency patch for the legacy delivery-dispute ruling is authorized but **not deployed**: Vercel access for the team scope still returns 403 (§0). Nothing in this report changes that.

**Verdict: the J8 gate is met locally**, with the honest limits in §48.
- **Fresh-database gate** (§42, `c6da928`): 608 / 608 tests, load 3 / 3, sweeps 5 / 5, money and logistics invariants clean.
- **No new P0 was found in J8.**
- **Money:** no tested path creates, destroys or duplicates money or goods.
- **Isolation:** no cross-party shipment, address or earning access succeeded in the lab or the sweeps.

The design and inventory document, `docs/JOKKO-J8-LOGISTICS.md`, is binding.

---

## 0. P0 incident (open)

| State | Status |
|---|---|
| LOCAL CONTAINMENT | **DONE**: `948f2a6`, regression `tests/j8/p0-delivery-dispute.test.js` |
| PRODUCTION EXPOSURE ASSESSED | **DONE (read-only): LIKELY EXPOSED**. The live build `7d262de` contains the fail-open route. |
| PRODUCTION PATCHED | **NO.** Deployment is authorized, but the serving deployment cannot be verified and the patch cannot be applied. The Vercel connector returns 403 for scope `mbayangxos-projects`, and no CLI is available. Package: `docs/incidents/2026-10-p0-delivery-dispute/` (patch `emergency-7d262de.patch`, which applies to `7d262de` and to the default head `19ac203`). |
| HISTORICAL IMPACT ASSESSED | **NO, UNABLE TO DETERMINE.** There is no production database access. The read-only query set is ready (`scripts/forensics/p0-delivery-dispute.sql`). |
| REMEDIATION COMPLETE | **NO** |

**Commits preserved unchanged:**
- `948f2a6` — the fix.
- `87c82ac`, `06b3757`, `d5e886e` — the incident record and deployment log.
- `eaae7e4`, `8329a98`, `862d5d2` — the authorization-boundary gate and its fixes.

**Not attempted:**
- No bypass of permissions.
- No deployment through an unverified branch.
- No automatic reversal or compensation of historical disputes.

## Problems found and fixed during J8

| # | Finding | Severity | Resolution |
|---|---|---|---|
| F1 | **A wrong custody code's attempt counter rolled back with the refusal.** The counter was incremented inside the transaction that then threw, so the 5-attempt lockout never took effect for J8 shipment codes. The space is 8 characters × 31 symbols (~8.5·10¹¹) per 10-minute code, so brute force was still impractical, but the stated control did not exist. This code was new in J8 and never released. | P2 (control not effective; no goods or money moved) | Attempts are now counted outside the act's transaction. `tests/j8/adversarial` proves the lock (423 after 5 attempts). |
| F2 | **The boundary-sweep seed shipment had no custodian.** The logistics invariant L1 caught it on the fresh-DB gate. | test defect | The seed was corrected (`c6da928`). |
| F3 | The data-exposure sweep had no candidate rows for the two J8 read routes. | test gap | Candidates added (`c6da928`). |
| L1–L6 | **The six legacy weaknesses** (from J8.0): auto-release without a receiver, client-set fee, the buyer or seller as courier, hub arrival by any worker, hub release without code limits, and merchant "delivered" after courier custody. | P1–P2 | Fixed in `1fc4f89`: see `docs/JOKKO-J8-LOGISTICS.md` §1 and `tests/j8/legacy-courier.test.js`. |

---

## Gate items

### 1–2. Existing movement inventory and classification
`JOKKO-J8-LOGISTICS.md` §1 inventories every area the brief names and assigns each a class 1–7. No historical delivery data was deleted.

### 3–4. Fulfilment contract and owners
`lib/logistics/contract.js` and `intake.js`. See `JOKKO-J8-LOGISTICS.md` §2.
- `FulfilmentRequest` references its source by `sourceSystem`, `sourceId`, `purpose` and the unique `sourceKey`. It copies no commercial amounts or customer fields (asserted in the adapter-contract test).
- **Owner status:**
  - MERCHANT_FULFILLED, DISTRIBUTOR_FULFILLED and CUSTOMER_PICKUP are **ACTIVE**.
  - JOKKO_LOGISTICS is **GATED**: code-complete, off unless `JOKKO_LOGISTICS_ENABLED=true`.
  - JOKKO_FULFILLMENT_CENTER is **DORMANT**.

### 5. Address and location privacy
`shipmentView` gives the precise destination only to the **active** assigned courier while the movement is live. Everyone else gets the area only.

**Tests (`adversarial`: privacy; `pickup-transfer-route`):**
- source, receiver, stranger, other business, the seller's own driver and the courier after unassignment each get the area only or 404;
- precise data never appears in business lists or in intake outbox events (transition events carry only status, custody and evidence kind);
- retention redaction runs after 7 days.

### 6. Package and shipment model
- `Shipment` holds one or more `ShipmentPackage` rows.
- Package contents are stored by reference (`productId`, `sku`, `units`) and contain no PII.
- One hand-off attempt creates one shipment.

### 7. State machine
`JOKKO-J8-LOGISTICS.md` §3. The DB trigger enforces status ⇒ custody, final states and no deletes.

**Illegal jumps are refused in tests:**
- cancel after pickup;
- deliver without the receiver's code;
- change after delivered;
- receive while an exception is open;
- re-receive.

### 8. Courier lifecycle
- Jokko couriers use the J3 `driver` approval lifecycle (`admin/couriers/:id/approve | suspend | revoke`).
- Fleet drivers are business members holding `business.fleet.drive`.
- Suspension takes effect on the next act.
- **Tested:** a suspended courier cannot pick up (`courier_inactive`).

### 9. Assignment
- Assignment is authoritative only (ops, or the business dispatcher). There is no claim and no self-assignment.
- One active assignment per shipment is enforced by the DB. With two concurrent dispatchers, exactly one wins.
- The courier is never the receiver.
- Unassignment removes access immediately.

### 10–11. Pickup and delivery proof
Custody challenges (§5 of the design):
- hashed, purpose-bound and courier-bound;
- 10-minute TTL, single-use, 5 attempts.

**Tested:**
- wrong courier, wrong shipment and wrong purpose are refused;
- expired codes, replay, and a pickup code used for delivery are refused;
- the courier cannot issue the source's code;
- the receiver cannot release to itself;
- a courier claim becomes an **exception** that only `logistics_ops` can rule on, with evidence.

### 12–13. Delivery fee and courier earnings (J2)
`lib/logistics/fees.js`; design §7.
- The fee is a server rule snapshot. No route accepts a fee: strict schemas return 400.
- The fee is held in escrow at request time and released only on verified delivery.
- Earnings are funded from that escrow and held 24 h before payout.
- Payout runs once per key. Five concurrent payouts paid exactly once.
- A paid earning cannot be reversed. An unpaid one is reversed only with maker/checker.
- Invariants I20 and I21 are asserted after every J8 test.

### 14. COD
**DORMANT**: `cod_not_activated` (tested). Design §10 lists what activation requires.

### 15–16. Pickup points and customer pickup
- A business enrolls a pickup point. **Only compliance approves it**, and logistics ops gets 403.
- Suspension revokes authority at once.
- The public list contains no operator identity.
- Release requires the receiver's code at the approved point. The source cannot bypass the point.
- **Collection happens once** (replay safe).
- Buyer pickup at the distributor is also tested.

### 17–18. Distributor → merchant delivery, receiving and discrepancies
Tested in `distribution-delivery`:
- PO hand-off → shipment → assignment → two-party pickup → arrival → per-line receiving with **21 received, 2 damaged, 1 missing of 24**.
- **Stock:** only the 21 are credited, once.
- **Commercial:** the PO becomes `disputed` with the discrepancy.
- **Verified delivery:** a courier-code delivery followed by full receiving makes the PO `received`.
- **Seller:** cannot self-record delivery of a carried order.
- **Buyer:** cannot use the J7 receive shortcut.

### 19. Inventory transfer
Tested in `pickup-transfer-route`:
- Depot A goes −30 at dispatch. While in transit the units sit in **nobody's position**. Location B goes +28, with 2 damaged recorded.
- Stock is credited once.
- **The driver cannot sign the receiving**, and neither can the owner acting as driver.
- Cancel re-credits once.
- Conservation is invariant L7.

### 20. Reverse logistics
Tested in `distribution-delivery` (J8.18):
- A tracked J7 return: the buyer issues the pickup code and the seller's driver collects.
- The seller records receiving per line (10 received, 2 damaged), and J7 restocks the 10 once.
- **The manual receive shortcut is refused.**
- **Refund / credit stays a separate J7 seller decision.**

### 21. Failed delivery
Design §8.5.

**Tested:**
- Custody stays with the courier until the source's return code.
- An operational failure refunds the fee. A receiver-side failure pays the courier.
- The PO goes back to `ready`, with stock re-credited and re-reserved once. A new hand-off creates a new shipment.
- A failure never becomes a delivery.

### 22. Disputes
Tested in `jokko-logistics-money`:
- Opening: a party opens the dispute (a stranger gets 404), and opening freezes the earning (no payout or promotion while open).
- Evidence is append-only (DB), and parties see roles, not ids.
- Ruling: support gets 403; `logistics_ops` rules once, with a reason, and the ruling is audited.
- `upheld_reverse` files an approval:
  - the same operator cannot approve it;
  - `finance_ops` approves → 150 back to the fee payer;
  - the earning becomes `reversed`, exactly once.
- There is no user route that resolves a dispute.

### 23. Tracking and privacy
- Tracking is status history (from, to, time, evidence kind) with no actor ids.
- **No GPS, no map and no ETA are claimed.**

### 24–25. Routes and consolidation
- One driver serves two merchants on one route. Each shipment keeps its own code, custody and receiving.
- Merchant 1's code cannot deliver merchant 2's goods, and merchant 1 is not a party to merchant 2's shipment.
- **No optimisation is claimed.**

### 26–29. Warehouse, placement intelligence, intercity, rides
| Capability | Status |
|---|---|
| Warehouse | **DORMANT** (primitives only) |
| Placement intelligence | **architecture only**: aggregate signals, never automatic moves |
| Intercity / regional | **DORMANT** (`service_not_available`, tested) |
| Rides | **DORMANT**: there is no passenger code |

### 30–32. Kabu, Askaan / Askoo, Mbolo
- **Kabu:** the service-level contract is tested. It is idempotent on the source key, and its events carry no precise address. There is **no Kabu endpoint yet**.
- **Askaan / Askoo:** no executable code exists; the contract is documented only.
- **Mbolo:** there is no conversational write path to destination, courier, fee, proof, payment or status.

### 33. Distribution-company compatibility (D33)
- No code path is keyed by business id.
- Every primitive is driven by capabilities and relationships, and any approved distributor uses the same routes.

### 34. Scale and load (measured exactly; not a 100,000-store claim)
**`adversarial` scale test:**
- 3,000 shipments for one origin;
- **2,000 distinct merchant destinations**;
- keyset pagination over 15 pages with no duplicates;
- a status filter.

**Authorization under scale:**
- A stranger gets 404.
- One destination owner sees exactly its one inbound shipment.

**Courier list:** 1,000 active assignments, paginated, own only.

**Route:** a 60-stop route lists in order, and the driver cannot read the dispatch plan.

**Query plan:** the plan uses indexes (`EXPLAIN` with sequential scans disabled).

**Timings** (local Postgres 16, one process):
- business list, 15 pages: ~1.1 s;
- courier list, 5 pages: ~0.2 s.

`test:load` (pre-existing money load) is reported in §42.

### 35. Authorization and privacy attacks (J8.33)
Each J8.33 pair is tested:
- courier → unrelated delivery / wallet / order / address;
- customer → another shipment;
- merchant → another merchant's shipment;
- distributor → unrelated shipment;
- pickup point → unrelated parcel (another approved point's operator: 404);
- support → logistics money actions;
- agent → courier;
- distribution rep → dispatch or drive;
- courier → agent cash (`agent/cash/scan` 403).

### 36. Offline / retry matrix
| Situation | Behaviour (tested) |
|---|---|
| pickup confirmed, response lost | same courier + same code → `replayed: true`; one `picked_up` event |
| delivery confirmed, response lost | same → `replayed`; one `delivered` event; one earning |
| return confirmed, response lost | same → `replayed` |
| collection released, response lost | same desk + code → `replayed` |
| receiving submitted twice / 6× in parallel | one record; stock once |
| duplicate step taps | idempotent (`replayed`), one event |
| payout retried with the same key / 5 keys in parallel | same result / paid once |
| courier offline, then unassigned | loses access; no stale act succeeds |
| uncertain network | **no actor is ever asked to repeat a physical handoff** |

### 37. Adversarial lab
Each listed attack maps to a test:
- `adversarial`: 11 tests;
- `jokko-logistics-money`: 6;
- `distribution-delivery`: 5;
- `pickup-transfer-route`: 4;
- `legacy-courier`: 4;
- `p0-delivery-dispute`: 2.

Two attacks need COD or a fulfilment centre, and both are **dormant and refused**:
- COD by an unauthorized courier, double COD, fake cash collection: refused by `cod_not_activated`.
- Inventory in a non-existent centre: refused.

### 38. Logistics and custody invariants
`lib/logistics/invariants.js`, L1–L8. They are asserted after every J8 test, and detection is proven on tampered data inside a rolled-back transaction (L2, L5).

### 39. J2 financial invariants
I1–I21 are asserted after every money test. `money:check` results are in §42.

### 40. J3 authorization sweeps
- The authorization-boundary gate now covers the J8 critical routes (deliver, return/complete, cancel). The static check requires a valid body for every critical route.
- The operator-permission sweep covers the 7 new mutating admin routes.
- The data-exposure sweep covers the J8 read routes.
- Permission matrix: 569 routes (`docs/JOKKO-J3-PERMISSION-MATRIX.md`).

### 41–46. Regressions, fresh-DB gate, migrations, rehearsal, deploy, build
See §42.

### 42. Fresh-database gate

Fresh database `joko_regj8`, gate script at **`c6da928`**. The two later test-only commits (`c3f41d0`, `9160ec2`) were then run on the same database at HEAD: `tests/j8` **34 / 34**, logistics invariants ok, `money:check` exit 0.

| Check | Result |
|---|---|
| `test:db:setup` | exit 0 |
| `npm test` (unit → J8) | **608 / 608** |
| `money:check` after the suite / after load + sweeps | exit 0 / exit 0 |
| `test:load` | 3 / 3 |
| `test:sweep` (boundary: 41 critical user routes, 58 operator routes; data exposure; admin refusal; mutation) | **5 / 5** |
| logistics invariants L1–L8 after everything | ok (no violations) |
| Migrations vs schema (`migrate diff --exit-code`) | **exit 0** (no difference) |
| Production-shaped rehearsal | **19 / 19** (new J8 step: legacy courier task untouched, 4 guards + 2 indexes, custody rules and idempotent intake on migrated data) |
| Deploy inert without activation | **exit 3** (as required) |
| `tsc --noEmit` | the same 5 pre-existing errors, all in `supabase/functions/cron-proxy/index.ts` (Deno) |
| Web export (`expo export --platform web`) | ok |
| `npm audit --omit=dev` | 45 (13 moderate, 31 high, **1 critical**) |

**Audit, 45 vs 44 at J7:**
- **No dependency changed.**
- The new critical is `shell-quote` 1.9.0 (GHSA-pqg4-j6r4-53mv, command injection in `quote()`). It is transitive via `react-native → react-devtools-core` (developer tooling), is not in the `/api` runtime, and is not called by Jokko code.
- **Recommended fix:** an `overrides` entry pinning a patched `shell-quote`, in a reviewed dependency change. It was not made here.

### 47. Dormant capability register
| Capability | Status |
|---|---|
| Jokko Logistics (fulfilment owner) | **GATED**: code-complete; `JOKKO_LOGISTICS_ENABLED` unset ⇒ refused |
| Jokko fulfilment centre / warehouse ops | DORMANT |
| COD (courier cash collection) | DORMANT |
| Intercity / regional Jokko service | DORMANT |
| Rides | DORMANT (no code) |
| Courier handoff after pickup | not supported (refused) |
| Placement intelligence | architecture only |
| Kabu logistics endpoint | contract only (service level) |
| Askaan / Askoo | contract only |
| GPS / ETA / route optimisation | **not built, not claimed** |
| Group purchasing (J7) | DORMANT (unchanged) |

### 48. Unresolved risks
1. **The P0 is unpatched in production** (§0). The emergency patch is ready. Vercel team access must be restored by the owner.
2. **Proof limits:** Jokko proves that the counterpart's *account* confirmed a handoff, not physical presence. A colluding receiver and courier can fake a delivery between themselves (no third-party loss). An exception ruling depends on operator diligence.
3. **Paid earnings are unrecoverable** by a dispute ruling (P-J8-5). Reversal applies only before payout, which is why the 24 h hold and the dispute freeze exist.
4. **Receiver stock uses the seller's product id** at the receiving location. A buyer-side catalogue mapping (seller SKU → buyer product) is not built, so positions are correct per product id but not merged with the buyer's own catalogue.
5. **Outbox intake is best-effort inline plus cron.** A carried PO is protected even before its shipment exists. If the cron is not scheduled and the inline call fails, the shipment is created late (never twice).
6. **Fee rule and hold are placeholders** (P-J8-2). Finance must set them before activation.
7. **Scale evidence** is 3,000 shipments, 2,000 destinations and 1,000 assignments on a local single-node DB. That is **not** evidence for national scale.
8. **No user interface for J8 yet** (backend only; `src/` untouched per AGENTS.md). The courier, dispatcher, receiving and pickup-point screens remain to build.
9. **Audit:** `shell-quote` critical (developer tooling; §42).
10. **Legacy consumer courier marketplace** (`DeliveryTask`) still runs beside J8 for consumer orders. Its open-claim model is weaker than J8 assignment, and migrating consumer delivery onto J8 is a product decision.

### 49. Exact commits (J8, after the J7 decisions `7998f50`)
| Commit | What |
|---|---|
| `948f2a6` | P0 fix: delivery dispute rulings operator-only |
| `87c82ac`, `06b3757`, `d5e886e` | P0 incident record, exposure assessment, emergency package, deployment log (blocked) |
| `eaae7e4`, `8329a98`, `862d5d2` | authorization-boundary gate and the three authority-ordering fixes it found |
| `59ec419` | J8 schema (additive), custody guards, ledger accounts, I20/I21 |
| `1fc4f89` | J8.0: six legacy courier / hub weaknesses fixed; pickup points |
| `c4cd657` | J8 core: intake, custody protocol, own-fleet distributor → merchant, receiving, disputes, transfers, routes, 38 routes |
| `6256a4d` | Jokko Logistics money, pickup points, transfers, routes, L1–L8, adversarial lab, F1 fix |
| `e4ed40a` | J8.18 tracked returns |
| `4f92784` | rehearsal J8 step |
| `0ba6867` | design doc, P-J8-1..6, role-combination and adapter tests |
| `c6da928` | sweep coverage for J8 reads; seed custodian (F2, F3) |
| `c3f41d0` | J8.32 scale (destinations, courier assignments, route stops) |

### 50. Recommendation for J9 — Work & Opportunity
J8 leaves a reusable **verified-work primitive**: a counterpart-issued, single-use, bound challenge, followed by a funded earning (escrow → accrued → hold → releasable → paid, with dispute freeze and maker/checker reversal). J9 should build on it rather than start over.

1. **Start with the work that J7 and J8 already create:**
   - delivery drivers;
   - distribution reps (commission on verified orders, never on self-reported visits);
   - pickup-point operators (a per-parcel fee on verified release).

   Every earning must be funded before it is promised, the same rule as J8 and D28.
2. **Identity and roles stay separate (D25):**
   - a worker profile does not grant courier, agent or business authority;
   - each engagement is an explicit, revocable grant;
   - reuse the J3 approval lifecycle.
3. **Payroll boundary:** J5 payroll stays the employer's tool. J9 gig earnings are platform-funded obligations with their own ledger accounts, never mixed with salaries.
4. **Do not fake labour-market signals:**
   - no invented availability, ratings or "jobs near you" without real demand;
   - status-based matching first, as in J8 tracking.
5. **Prerequisites before any J9 money moves:**
   - deploy the P0 patch and verify it;
   - perform the read-only production inspections (D32, P-J8-1);
   - decide P-J8-1..6.
