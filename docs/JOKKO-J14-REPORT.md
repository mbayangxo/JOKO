# J14: Ecosystem integration (report)

**Status:** local engineering only. **Nothing deployed.** Every J14 capability ships **off** behind its own flag. No production route, webhook endpoint, partner credential or migration was activated. Kebu Supabase was never accessed. The production emergency track (P0-A runtime verification, still INCOMPLETE while Vercel returns 403; P0-B; F1) is separate and is not bundled here.

**Baseline (preserved, unchanged):**
- J13 milestone `86ee972`;
- J13-F17 follow-up `a6adf97`.

**Plan and decisions:** `docs/JOKKO-J14-PLAN.md` §4:
- **D-J14-1 = A:** every partner-initiated business-wallet debit needs explicit in-Jokko approval.
- **D-J14-2 approved:** a minimal event allowlist, signed with replay protection, scoped credentials, minimal PII, 30-day delivery logs.
- **D-J14-3 conditional:** close legacy settlement for new partners only, after reconciliation and migration tests.

## 1. Tested commits and gates

| Slice | Commit | Targeted tests | Full fresh-DB gate |
|---|---|---|---|
| S0 recipient binding (payroll, scheduled payments) | `d45db79` | 10 + E2E j14 (3) | **CLEAN** at `d45db79`: 855/855, E2E J8–J14, lab, rehearsal, schema diff empty, deploy inert |
| S1 signed event delivery | `c95f8d9` | 14 | NOT CLEAN at `c95f8d9`: 869/869 tests and every functional step passed, but `client_matches_schema 1` (schema not `prisma format`-clean; see F2) |
| S1 format fix | `844dbcc` | — | **CLEAN** at `844dbcc` (S1 milestone): 869/869, all checks 0 |
| S6 partner hardening | `9e5cf46` | 10, incl. a sweep over every partner route | covered by the `2ef01f6` gate |
| S3 product mapping | `90833f4` | 8 | covered by the `2ef01f6` gate |
| S2 fulfilment → Logistics | `2ef01f6` | 7 | **CLEAN** at `2ef01f6` (S6 + S3 + S2): 894/894, all checks 0 |
| S5 Mbolo order card | `a535e99` | 9, incl. a 6-round pay/cancel race | covered by the `40b95b9` gate |
| D-J14-3 legacy closure + reconciliation | `40b95b9` | 3 | **CLEAN** at `40b95b9` (S5 + D-J14-3): 906/906, all checks 0 |

Gate checks (each must be 0, or as stated):
- setup, full suite, money / logistics / work / collective invariants after the suite and after everything;
- load, sweeps, web build;
- E2E J8–J14, weak-network lab (J12), migration rehearsal;
- `schema_diff empty`, `audit_critical 0`, `deploy_inert yes` (no new cron);
- `client_matches_schema` / `client_still_matches_schema` 0.

Every targeted suite was mutation-checked: one guard was removed, the test was confirmed to fail, and the guard was restored. Mutations:
- S6: scope check;
- S3: business ownership;
- S2: shipment object-link filter;
- S5: buyer guard, and the lock order.

## 2. What was built

**S0, recipient binding carry-forward.** Payroll enrolment and scheduled-payment creation bind the immutable account confirmed on screen (J13-4 `recipientRef`).
- A handle reclaimed between lookup and save → 409; forged or foreign refs are refused.
- Older clients work only while the handle is stable; after a rename and reclaim → 426.
- The old `OR(handle, userId)` enrolment lookup is gone.
- Legacy pay-by-handle → 426 when the handle changed owner.

**S1, signed event delivery (`PARTNER_EVENTS_ENABLED`).**
- Per-partner subscriptions: https only, secret shown once and encrypted at rest, rotation with a 24 h dual-signature overlap.
- Signature `v1 = HMAC-SHA256(secret, "ts.eventId.body")`, 300 s replay window, stable event ids.
- Only businesses explicitly linked to the partner, re-checked at send time. Payload field allowlist: ids and amounts only.
- At-least-once delivery:
  - idempotent fan-out whose cursor trails now by 2 min (late-committed events are not lost);
  - atomic claim with a 60 s lease (a dead worker's row is taken over by exactly one worker);
  - backoff, dead-letter after 8 attempts, redirects never followed.
- Operator replay: role `integration_ops`, reason required, audited.
- 30-day purge of delivery logs only. A mapped settlement emits `settlement.completed` / `settlement.held` when its state changes. Delivery never touches money.

**S6, partner hardening (`PARTNER_SCOPED_KEYS_ENABLED`).**
- Database keys are hashed and shown once. They are usable only after a **different** operator approves (maker `integration_ops`, checker `risk`).
- Scopes are the central route-policy permissions, enforced for **every** partner route.
- A sandbox key is refused in live, and a live key never reaches a sandbox route.
- Rotation: the old key expires after the overlap (≤ 24 h). Revocation is immediate.
- Rate limits per partner and per key. Partner audit trail with no bodies and no PII.
- Environment keys keep every scope, so existing partners are untouched.

**S3, product mapping (`PARTNER_PRODUCT_MAPPING_ENABLED`).**
- `ExternalLink(objectType=product)` to a Product **of the linked business**, by id or SKU. Ids only.
- Namespaced per shop, idempotent; re-pointing → 409; concurrent maps serialized.
- The resolver re-checks both the business link and the product link.

**S2, fulfilment → Logistics (`PARTNER_FULFILLMENT_ENABLED`).**
- One J8 request and shipment per partner order. Lines are resolved through S3; any unmapped line → 422.
- **Zero-fee modes only:** `jokko_logistics` → 409 `requires_merchant_approval`. Its fee is a business-wallet debit (D-J14-1).
- Suspended business → 409.
- `shipment.*` status events go back through S1, only for shipments this partner requested.

**S5, Mbolo order-from-conversation (`MBOLO_ORDER_CARD_ENABLED`).**
- In a direct thread, the seller's composed order is the confirmation: server-priced, stock committed, `pending_payment`, bound to a J4 charge shared as the J7.19 card.
- Payment goes **only** through the existing charge flow. Inside the money transaction, only the thread's buyer may pay, the order must be payable and the amounts must match; the order is confirmed in the same transaction.
- Unpaid orders cannot be prepared. Cancelling closes the charge and restores stock. A paid order refunds once through J5. An expired card can be re-shared for the same order.

**D-J14-3, legacy settlement for new partners.**
- Read-only `reconcilePartnerSettlements`: one confirmed operation and one `-CONFIRM` entry to the right account per completed payment; mapped and legacy never mix; totals per target.
- `PARTNER_LEGACY_SETTLEMENT_PARTNERS` (unset = unchanged) names the existing partners that keep the legacy path; new partners must send mapped payments. Decided at creation, so in-flight payments settle as created.

**Not built in J14:** S4 (partner-initiated business-wallet debits). Under D-J14-1 option A, S4 needs a per-instruction in-Jokko approval flow; that design is the next step and is not started.

## 3. Findings and fixes

| # | Finding | Severity | Fix |
|---|---|---|---|
| F1 | Shipment transition events carried `businessId: null`, so no partner could ever receive shipment status | Functional gap | Events are now attributed to the origin business (no consumer read them by business). Data minimization: only shipments the partner requested are sent |
| F2 | S1 schema block hand-aligned. `prisma generate` writes a formatted copy, so the gate's client/schema byte check failed at `c95f8d9` | Gate hygiene | Whitespace-only commit `844dbcc`; `prisma format --check` is now run before every schema commit |
| F3 | The S1 test server didn't receive `DATA_ENCRYPTION_KEY`. Production correctly refuses to store secrets without it (fail closed) | Test fixture | The test supplies the key to both processes, as in production |
| F4 | The harness copied the test process env into the production-mode server, so a dormant flag could leak in and "disabled by default" was untestable | Test validity | Every J14 flag is scrubbed; a flag is enabled only by an explicit override |
| F5 | Delivery `nextAttemptAt` came from the DB clock while the worker used the app clock | Minor correctness | One clock: the worker's |
| F6 | A stuck `sending` row after a crash would never be delivered again | At-least-once defect | Claim lease plus compare-and-set takeover |
| F7 | Events committed after a later event was fanned out could be skipped by the cursor | At-least-once defect | The cursor trails now by 2 min, and re-scans are harmless (unique index) |
| F8 | **Pay versus cancel deadlock** on a card order: `payCharge` locked charge then order, `cancelOrder` locked order then charge. The cancel side got a 500 in 3 of 3 runs | Money-path robustness (atomic, but an unknown outcome to the user) | One lock order, order then charge, everywhere. The race test proves it (0 of 18 rounds failed after the fix) |
| F9 | The first card code was 12 characters; J4's QR format needs 16–64. The tx rolled back and no money moved | Defect caught by tests | Reuse the one J4 generator (`newChargeCode`) |
| F10 | **The owner link-code endpoint was hard-wired to `kebu`.** A new partner could never get a consented business link, so closing legacy settlement would have left it no path | Blocks D-J14-3 | The owner names a configured partner (default `kebu`); unknown → 400; a code is useless to any other partner |
| F11 | Ad-hoc parallel test runs raced on the shared `platform:agent_commission_budget` account (J6) | Not a defect; harness only | The gate and `npm test` run with `--test-concurrency=1`, and all regressions were re-run serially |

## 4. Dependencies between slices

- S2 depends on S3 (line resolution) and S1 (status back).
- S6 is central (`lib/authz/enforce.js`) and applies to the S1, S2 and S3 partner routes.
- S5 changes the J4 `payCharge` and J5 `cancelOrder` / `merchantTransition` / refund lookup. Every change is limited to card orders (`paymentTerm = mbolo_card`), apart from the lock-order step, which only adds an order lock before a bound charge.
- D-J14-3 depends on the J6.0 mapped settlement and on F10.

Activation order, if authorized: S6, then S1, then S3, then S2. S5 is independent. D-J14-3 needs a clean reconciliation report in production first.

## 5. Open items for decision (not decided here)

1. **S4 design** under D-J14-1 option A: the per-instruction approval UX and limits for partner-initiated business debits.
2. **Card-order stock hold:** an unpaid card order holds stock until the seller or buyer cancels. Should unpaid card orders auto-expire, and after how long? This is a product policy.
3. **Partner audit trail retention:** no purge is implemented. It is a security record, not an operational delivery log, so it needs a retention decision.
4. **S6 checker role:** `risk` approves partner keys. Change it if a different checker is wanted.

## 6. Final gate

**`40b95b9` — CLEAN.** It is the final tested J14 code commit.
- 906/906 tests.
- 0 on every check: setup, suite, money / logistics / work / collective invariants (after the suite and after everything), load, sweeps, web, E2E J8–J14, weak-network lab, rehearsal.
- `schema_diff empty`, `audit_critical 0`, `deploy_inert yes` (crons unchanged: daily, scheduled-payments), client matches schema at start and end.

The commit that adds this report is documentation only. It changes no code.
