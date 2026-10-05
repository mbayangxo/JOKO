# Jokko J4 gate report: Money Vertical Slices (local)

Branch `claude/jokko-forensic-audit-rprqia`, on the accepted J3 head `48f7f40` plus the J3 decisions commit `c1af530`.

**Scope and limits.**
- Built and proven **locally only**; nothing was deployed.
- No production database, user, credential, operator or money row was read or changed.
- Branch deployments stay disabled.
- `db-migrate-deploy.mjs` stays inert (exit 3), and production migration history is not baselined (D2/D3).
- Read-only production verification remains a separate, BLOCKED workstream.

**Verdict: the J4 gate is met locally.** No new P0 was found. No path creates, destroys or misdirects money. J4 found and fixed these problems:
- two double-payment hazards (§11);
- four product gaps that made P2P and requests unsafe (blocks ignored, no expiry, no spam cap, raw security reasons shown to users);
- the two root causes of the intermittent J2 "1/1000" concurrent-send failure: an account-creation race, and a lock-order deadlock (§16).

One product decision is still open: **the fee schedule** (§10). Until it is decided, every fee is 0.

J3 decisions 1–7 are recorded as D11–D17 in [`JOKKO-DECISIONS.md`](JOKKO-DECISIONS.md). The diaspora decoupling (D16) is in §12.

---

## 1. Vertical-slice map

Every slice runs in this order:
1. app screen;
2. `src/lib/api-client.js`;
3. the `/api` router (`lib/api-router.js`);
4. J3 enforcement (`lib/authz/enforce.js` + `ROUTE_POLICY`);
5. the handler;
6. the J2 kernel (`lib/money-kernel`) — the only writer of balances;
7. the provider adapter, where there is one;
8. the ledger;
9. the read model (`lib/money/activity.js`, `home.js`);
10. receipts and history, which reload from the server.

| Slice | Screen | API (write) | Read model | Status |
|---|---|---|---|---|
| A. Money home | `WalletScreen` (balance block) | — | `GET money/home` | built |
| B. Cash-in | `CashScreen` (in) | `POST cash/in` + `POST webhooks/julaya` | `money/home`, `money/activity/:ref` | built |
| C. Cash-out | `CashScreen` (out) | `POST cash/out` + webhook | same | built |
| D. P2P | `SendMoneyScreen` | `POST transfers/send`, `POST transfers/:ref/undo` | same | built |
| E. Request money | (existing request UI) | `POST transfers/request`, `…/requests/:id/accept\|deny\|cancel` | `GET transfers/requests` | built (server); UI unchanged |
| F. Merchant pay | `PayMerchantScreen` | `POST merchants/:id/pay` | same | built |
| G. QR charge | `QrScan` → `PayMerchantScreen` | `POST money/charges`, `GET/POST money/charges/:code[/pay\|/cancel]` | same | built (new) |
| H/I. History + receipts | `WalletScreen` (Historique) | — | `GET money/activity`, `GET money/activity/:ref` | built (new) |
| J. Limits/fees preview | (server; screens read `home.limits`) | `POST money/preview` | — | built (new) |
| K. Intent outcome | `useMoneySubmit` (all money screens) | — | `GET money/intents/:key` | built (new) |
| M. Refund primitive | (API only) | `POST money/payments/:ref/refund` | linked in history | built (new) |
| N. Support lookup | (admin API) | — | `GET admin/money/lookup`, `GET admin/money/limits-usage` | built (new) |

Out of scope by the J4 roadmap boundary (§Q): rides, the gig marketplace, merchant OS, full commerce returns and social features. None of these was touched.

## 2. UI → API → J3 → J2 trace per flow

| Flow | Client call (intent key) | J3 policy (`ROUTE_POLICY`) | Handler → kernel |
|---|---|---|---|
| Cash-in | `cashIn({…, intentKey})` | `wallet.cash_in` self; idempotent | `cashIn` → `startCashIn` → `createOperation` (ExternalOperation `pending`). **No ledger credit until a signed provider signal**: `settleRailFromWebhook` → `confirmRailInTx` → kernel `post(cash_in)` |
| Cash-out | `cashOut({…, stepUpToken, intentKey})` | `wallet.cash_out` CASH_OUT: tier ≥ 2, step-up, trusted session, not new device / recent recovery, risk engine | `startCashOut` → `transition(authorized)` + hold `post(available → held)` → provider → `confirmCashOutInTx` (held → provider settlement) **or** `refundCashOutInTx` (held → available, once) |
| P2P | `transferSend({…, intentKey})` | `transfer.send` payer→counterparty, OUT(tier 1): step-up at threshold, trust | `transfersSend` → block check → `assertCanSend` → `transferNational` → `move()` → `post(p2p)` |
| Undo | `transferUndo(ref)` | `transfer.undo` party, OUT | `reverse()` (compensating entry, `reversesId`) |
| Request pay | `acceptMoneyRequest` | `transfer.request.pay` party (payer only), OUT(tier 1) | `acceptMoneyRequest` (row lock, expiry, block) → `transferNational` |
| Merchant pay | `merchantPay(id, {…, intentKey})` | `merchant.pay` payer→counterparty, OUT(tier 1) | `merchantPay` → `gateOrExecute` → `spendKoriAtMerchant` → `post` |
| QR charge | `payMerchantCharge(code, {expectedAmountKori, intentKey})` | `merchant.charge.pay` payer, OUT(tier 1); step-up by server amount | `payCharge` (row `FOR UPDATE`, status/expiry/amount/self checks) → `spendKoriToBusinessWallet(kind charge_payment)` |
| Refund | `refundReceivedPayment(ref, …)` | `merchant.refund` payee or business treasury, MONEY | `refundReceivedPayment` (advisory lock per original, cumulative cap) → `post(merchant_refund)` |

The intent key travels as `Idempotency-Key`. `withIdempotency` (`lib/api-idempotency.js`) does two things:
- it runs the handler inside a request context;
- every kernel entry posted in that context carries `metadata.clientKey`.

This is what lets the server answer "did intent X move money?" exactly (§11).

## 3. Cash-in evidence

Source: `tests/j4/journeys-cash.test.js`. It runs real HTTP with `NODE_ENV=production`, real OTP logins, and a fake Julaya over HTTP. J2 invariants are checked after every test.

| Brief case | Result |
|---|---|
| Normal | 202 `pending` → home: `availableKori 0`, `pendingInKori 1000` → signed webhook → `available 1000` → receipt `completed`, channel "Mobile money", no internal ids |
| Pending is never spendable | A send while pending → 400. `availableKori` stays 0. |
| Duplicate callback ×3 + late `pending` | Credited once. |
| Callback before client response (provider timeout) | The op is `pending`. The webhook credits once. The intent reads `accepted_pending`/`completed` with `safeToRetry:false`. |
| Same-key retry | Replay; exactly one ExternalOperation. |
| Provider rejected (HTTP 400) | The op is `failed`. Receipt reads "Échoué". Nothing is credited. |
| Provider unavailable / **missing key** | `home.actions.cashIn.category = provider_unavailable`. `POST` → 503. **Zero rows written.** |
| Delayed success | Pending, then confirmed by the later webhook (same test). |
| App closed / reinstall | A fresh login on a new device sees the same history and status. The intent stays answerable. |
| Network loss / retry | The client classifies it as `checking` and polls the intent (§11). It never sends a new intent. |

## 4. Cash-out evidence

The flow is: eligibility, then PIN step-up (403 `step_up_required` first), then funds held. Held funds are shown separately and are not spendable (`available 1000 / held 2000`).

On provider failure:
- the hold is released once;
- a replayed failure, and a late success after a final failure, are both no-ops;
- the receipt explains "rendu";
- the retry then succeeds.

Blocks and the user-safe categories they return:

| Block | Category | What the user sees |
|---|---|---|
| Tier < 2 | `verify_identity` | "vérifie ton identité" + next step |
| Insufficient funds | `insufficient_funds` | message + "Recharge" |
| New device (24 h hold, D13) | `new_device` | "nouvel appareil… réessaie après 24 h" |
| Recent recovery / contact change | `security_change` | "changement de sécurité récent" |
| Credentials reset pending | `credentials_reset` | — |
| Daily limit | `limit_reached` | remaining amount shown in home |
| Provider outage | `provider_unavailable` | nothing is held (balance unchanged) |
| Risk hold / review | `under_review` | generic. **Which signal fired is never disclosed.** |

No internal reason leaks. Every body is checked against `/velocity|rapid_cash|untrusted_session|recent_recovery|recent_contact|signal|risk|tier_insufficient|reasonCodes/`.

The mechanism: `deny()` in `lib/authz/enforce.js` now returns only `{error, code, category, nextStep}`. Any unknown internal code maps to `under_review` (`lib/money/user-reasons.js`).

## 5. P2P evidence

Source: `tests/j4/journeys-pay.test.js`.

| Case | Result |
|---|---|
| Recipient lookup | Minimal identity only (name, handle, avatar). No phone or KYC data. The public handle is not private identity. |
| Preview → send | Server amount and fee. Both histories show the **same** receipt reference. The receipt is party-only (a stranger gets 404). |
| Duplicate tap / retry, same key | One debit. The replay shows the same reference. The intent reads `completed`. |
| Same key, different payload | 422 `idempotency_key_reuse`; nothing executes. |
| Self-transfer | Refused. |
| Insufficient funds | 400 `insufficient_funds`, with a category and next step. |
| Invalid recipient | 404. |
| Blocked relationship | 403 `recipient_unavailable`. **The block is not disclosed.** Enforced on send and on request, in both directions. |
| Two phones sending simultaneously | The balance never goes negative. Exactly the affordable number of sends succeed. |
| Offline / app restart | Client: `outcome_unknown` → `checking` → intent poll → `safe_to_retry` (same key) or `done` (§11). |
| Undo | Compensating reversal. History links "annulée" ↔ "Envoi annulé". Survives reload. |

## 6. Request-money evidence

A request is **never debit authority**: creating one moves no money. Only the payer's own authenticated, step-up-eligible accept debits, and only once.

| Case | Result |
|---|---|
| Lifecycle | Request → the payer sees it → pays once → both histories. A second accept → 409 (already accepted). |
| Requester tries to accept their own request | 404 (not the payer). |
| Stranger | Cannot read or act on it (404). |
| Decline / cancel | Allowed to payer / requester respectively. |
| Expiry | 7 days (`FLOW_LIMITS.request.expiresAfterDays`). Accepting after expiry → 410 `expired`, and the request is marked expired. |
| Spam | At most 20 pending outgoing requests, and at most 3 to the same payer per 24 h → 429 `request_limit`. |
| Blocked either way | 403 `recipient_unavailable`. |
| Legacy pending requests (no `expiresAt`) | Never auto-expire: no expiry is invented. Proven in the rehearsal (§20). |

## 7. Merchant-pay evidence

- **Pay:** the payment goes through J3 (tier 1, step-up by amount) to the kernel. The receipt sits in both histories.
- **No receipt injection:** a receipt is posted into a conversation only if **both** payer and merchant are active members of it. Otherwise nothing is posted (`tests/http/merchant-agents.test.js`).
- **Charges:** a charge payment posts no chat receipt at all.
- **Staff:** they act only with the business capability (J3 §6). Paying from a business treasury is not a customer flow.

## 8. QR security evidence

Previously a QR carried only `merchant/<id>`, and the payer typed the amount. J4 adds **merchant charges**:
- the QR is `k21://charge/<opaque code>` (16–64 url-safe chars, unguessable);
- merchant and amount are **server state**;
- the client parser keeps only the code, and drops any `?amount=` (`tests/j4/money-ux.test.js`);
- the keypad is locked while paying a charge.

| Attack | Result |
|---|---|
| Forged code | 404. |
| Changed amount (client sends a different `expectedAmountKori`) | 409 `amount_mismatch`. Nothing is paid. |
| Changed merchant | Impossible: the code resolves server-side. Another merchant cannot cancel the charge (403). |
| Replay by the same payer | Idempotent replay; one payment. |
| Replay or screenshot by another payer | 409 `already_paid`. |
| Expired (30 min) | 410. |
| Cancelled / wrong order | Paying a cancelled charge → 409. Cancelling a paid charge → refused. |
| Self-payment (owner or staff paying their own business) | 400. |
| High amount | Step-up is computed from the **server** amount. |

## 9. History / receipt evidence

There is one coherent history (`GET money/activity`), built from ledger postings on the user's `available`/`held` accounts plus their ExternalOperations.

**Plain states:**
- En cours / Terminé / Échoué / En vérification;
- Annulé / Remboursé / Partiellement remboursé.

**Links:**
- reversals: `reverses` ↔ `reversedBy`;
- refunds: `refundOf` ↔ `refundedBy` + `refundedKori`.

**Durability:** history and receipts come from the server ledger. They survive reinstall and a new device; this was proven by logging in on a new device.

**Receipts are immutable:**
- They are derived from append-only journal entries, which DB triggers make un-updatable (J2).
- A refund or reversal is a new linked entry; the original never changes.
- They are party-only: someone else's reference → 404 (data-exposure sweep, §18).

## 10. Limits / fee model

Everything lives in `lib/money/policy.js` and is server-authoritative. `POST money/preview` returns all of the following, and executes nothing:
- amount and fee;
- `payerPaysKori`;
- `availableAfterKori`;
- `requiresPin`;
- `allowed`;
- user-safe `restriction` and `problems`.

**Limits:**
- tier limits come from `lib/tier-service.js` (unchanged);
- per-flow limits are in `FLOW_LIMITS`:
  - cash-in min 500 / max 1 000 000 XOF equivalent;
  - cash-out min 500 XOF equivalent;
  - request caps (§6);
  - charge max 2 000 000 XOF equivalent, 30-minute expiry;
  - step-up at the J3 high-value threshold.
- `GET money/home` shows the remaining daily send and cash-out allowance.

**Fees: 0 everywhere — DECISION NEEDED.**
- No flow charged a fee before J4. A fee schedule is a product and financial decision.
- So `feeScheduleBps()` defaults to 0.
- It accepts a non-zero rate **only** for `cash_out`: the only flow where a fee line is wired into the kernel posting. Any other non-zero setting is ignored.
- The preview shows `feeBasis: 'no_fee'`.

**D15 thresholds** (5 000 ₭ adjustment / 10 000 ₭ refund / 500 000 XOF agent float):
- they are configurable defaults;
- their usage is instrumented by `GET admin/money/limits-usage`, which counts single vs dual approvals and near-ceiling use per window.

## 11. Offline / retry evidence

**Two double-payment hazards were found and fixed.**

1. **Client.**
   - Before: a timed-out money request told the user "réessaie", and a new tap generated a new key. The result was a real second payment.
   - Now: one intent key per attempt (`useMoneySubmit`), reused for PIN re-submit and retries. A lost response throws `outcome_unknown`. The screen shows "Vérification…" and polls `GET money/intents/:key` (every 2 s, up to 15 times).
   - It **never offers a new payment while the outcome is unknown**. Only `not_found` (nothing reached the server) or `refused` allows another attempt, and `not_found` reuses the **same** key.
2. **Server.**
   - Before: `withIdempotency` deleted the idempotency row on any 5xx, even when the money had already committed. A same-key retry then paid again.
   - Now: on a 5xx or a crash it checks for ledger entries carrying the request's `clientKey`.
     - If money moved, the row is kept as `completed_response_lost`, and a retry replays "completed" with the references.
     - Otherwise the row is released.

Evidence:

| Test file | What it proves |
|---|---|
| `tests/j4/intents.test.js` | 5xx after commit → replay completed, no second run. Crash after commit → same. 5xx before money → `not_found`, then a same-key retry runs once. 4xx → `refused`. 202 → `accepted_pending`. In flight → `in_progress`. Intents are per user. |
| `tests/j4/money-ux.test.js` | Every unknown outcome (timeout, network, app kill, 5xx, 409 in-progress) → `checking`, with no new intent and never "réessaie". PIN → same key. Refusals show the server's text and next step. |

## 12. Trust / tier / device UX evidence

- `GET money/home` returns every action (`receive`, `request`, `send`, `merchantPay`, `cashIn`, `cashOut`) as either allowed or `{category, message, nextStep}`.
- `WalletScreen` shows these reasons under the balance.
- Tier 0 stays receive-only (D14).
- **D16 (diaspora):**
  - `lib/device-session.js` no longer reads `isDiaspora` or foreign-IP status.
  - A login from a country this account has never used is treated like a new device, identically for everyone.
  - Regression tests (`tests/unit/fraud-rules.test.js`):
    - identical outcomes for diaspora and local users;
    - a source scan proves that no security module (`device-session`, `risk/engine`, `risk-engine`, `authz/enforce`, `step-up`, `identity/sessions`) references diaspora status, nationality, language, arrondissement or ethnicity.
- The new-device 24 h cash-out hold, the 60-day session and the rule that "a 60-day session alone is never sufficient" (step-up plus trust) are unchanged (D12/D13).

## 13. Refund primitive evidence

`POST money/payments/:reference/refund` refunds a payment the caller received, as a **compensating entry** of kind `merchant_refund`, reference `refund:<orig>:<n>`, with `metadata.originalReference`. Rules:
- only the payee (or a member with business treasury authority) may refund;
- the payer gets 403; a stranger gets 403;
- refunds are partial and cumulative, **never above the original** (409);
- concurrent refunds are serialized per original by an advisory lock; the total never exceeds the original;
- history links the original ("Partiellement remboursé / Remboursé", `refundedKori`) and the refund.

This is **not** a commerce-returns system. There is no RMA, no stock and no dispute workflow.

## 14. Supportability evidence

`GET admin/money/lookup?reference=` takes any reference: an op, an entry, a charge code or a refund. It returns:
- the stage: `pending_at_jokko`, `submitted_to_provider`, `confirmed`, `settled`, `failed`, `reversed`, `refunded`, `in_review`, `reconciliation_exception` or `completed`;
- operation details and ledger lines;
- linked refunds, exceptions and the charge;
- `canSupportChangeBalance: false`.

Access:
- a role without `money.transactions.read` gets 403;
- a user token gets 401/403.

There is **no** support route that changes a balance. Adjustments remain the D10 maker-checker path.

## 15. UX failure-state matrix

Each cell shows what the user sees.

| Flow | Before submit | Submitting | Timeout / offline | Success | Failure | Restart / other device | History / receipt |
|---|---|---|---|---|---|---|---|
| Cash-in | Action enabled, or a reason (provider down) | Spinner, button locked | "Vérification…" → pending | Pending (not spendable) → available on confirm | "Échoué", nothing credited | Intent + history | "En cours" → "Terminé"/"Échoué" |
| Cash-out | Reason if blocked (tier/device/security/limit/provider/review) | PIN → held | "Vérification…" | Held → "Terminé" | Hold released once, "rendu" | Same | Explanation per state |
| P2P | Preview: fee, total, after-balance, PIN needed | Locked | "Vérification…", never "réessaie" | Reference + receipt | Category message + next step | Same | Same reference both sides |
| Request | Spam/block reasons | — | — | Paid once | 410 expired / 403 / 429 | Same | Linked |
| Merchant / charge | Server amount, keypad locked | Locked | "Vérification…" | Receipt | 409/410/404 with message | Same | Linked refunds |

Cell sources:
- pure client rules: `tests/j4/money-ux.test.js`;
- server cells: the journey tests (§3–9).

## 16. Soak / concurrency result (item P)

**Harness:** `scripts/soak-concurrent-send.mjs`.
- It repeats the J2 load workload: 1 000 funded senders → 1 **fresh** recipient, concurrency 10.
- It runs with **no retries**, to measure the raw failure rate.
- It records the error class, Prisma and Postgres codes, meta and stack, and checks money after every round.

| Question | Answer |
|---|---|
| Exception | `PrismaClientKnownRequestError` **P2010** (raw query failed), Postgres **23505** unique violation on `LedgerAccount ("projTable","projId")`. |
| Cause | **Neither** contention timeout, serialization failure nor connection exhaustion. It is a **creation race**: the first credits to a brand-new recipient race to open its ledger account. `ensureAccount` used `INSERT … ON CONFLICT ("code") DO NOTHING`, and Postgres arbitrates only the named index. The losing transaction waited for the winner, then failed on the *second* unique index instead of being absorbed. |
| Frequency (before the fix) | 2 failures in 5 000 sends (0.04 %): at most one per round, only while the recipient's account does not yet exist. A test with 25 trials × 8 concurrent first credits reproduces it on most runs. |
| Money impact | None. The whole transaction rolled back (the failed sender's balance is unchanged, there is no entry, and invariants hold). |
| Client response | HTTP 500. `withIdempotency` found no committed entries for the key and released it. The client shows "Vérification…" and polls the intent: `not_found` → `safe_to_retry` with the **same** key → the retry succeeds once. Proven by `tests/j4/intents.test.js` case 3. |
| Fix | `ON CONFLICT DO NOTHING` (no target): any unique conflict means "already opened", and the row is then re-read by `code`. If a *different* account owns that projection, it still fails closed (`LedgerInvariantError`). |
| Regression | `tests/j4/account-open-race.test.js`: **fails on the old clause, passes on the fix**. |

**Second, rarer cause: lock-order inversion (40P01 deadlock).** The Postgres server log shows it in earlier J3 gate runs, and a deterministic test reproduces it.
- The kernel locks `LedgerAccount` rows, then its trigger updates the legacy projection row (`Wallet`, `AgentProfile`, `TontineGroup`, `PaymentFund`, `MerchantVoucher`, `BusinessWallet`).
- Legacy flows (tontine contribution, agent cash-in/out, scheduled payments, vouchers, business wallets) locked the projection row **first**, then posted.
- A concurrent kernel transfer **into** the same wallet then deadlocked against them. Postgres aborted one transaction within about 1 s. It rolled back fully, and the client got a 500.

**Fix:** a single `lockProjections()` helper (`lib/wallet-atomic.js`) takes locks in kernel order: the projection's ledger accounts (sorted), then the projection rows. Every projection-row lock now goes through it.

**Regression:** `tests/j4/lock-order.test.js` fails with 40P01 on the old code and passes on the fix.

**Soak results:**

| Run | Sends | Failures | Notes |
|---|---|---|---|
| Before the fixes (no retry) | 5 000 | 2 (23505) | money ok |
| After fix 1, concurrent with a sweep run | 25 000 | 1 (40P01) | The deadlock was against the sweep's own bulk `UPDATE "User"` (test interference: the sweep was run against the same DB at the same time). It is excluded as a product finding, but disclosed. |
| After both fixes, clean (run A) | 19 000 | **0** | Harness stopped in round 20 *setup*: its random test-phone generator collided (P2002 on `User.phone`). Fixed in the harness (`8523cba`); not a product issue. |
| After both fixes, clean (run B) | **25 000** | **0** | Money ok every round; invariants ok; p99 ≤ 226 ms, max 380 ms; 278 s. |

**Residual risk, not reproduced in the product:**
- A transaction that pre-locks *some* accounts and then posts to others can still invert against a transaction locking the same pair in the opposite order.
- The real pre-locking callers lock an entity mutex first (tontine group / agent), which serializes them.
- If it ever happens, Postgres aborts one transaction and nothing commits. The client resolves it through the intent (`not_found` → retry with the same key).

The tests were not weakened. `tests/load/concurrent.test.js` is unchanged, and the soak runs with retries disabled.

## 17. J2 invariant results

Every J4 test asserts `assertInvariants` after each scenario. Other results:
- `npm run money:check` on the gate DB: ⟨MC⟩;
- after load, sweep and soak: ⟨MC2⟩;
- in the rehearsal, after migration, flows and J4 legacy-request payment: ok.

## 18. J3 authorization sweep results

- `tests/sweep/data-exposure.test.js` now covers the new routes:
  - `money/activity/:reference`, using other users' journal and op references;
  - `money/intents/:id`, using other users' keys, which must read as `not_found` with no references;
  - `money/charges/:id`, which is public by design to code holders: merchant name and amount only.
- `tests/sweep/j3-mutation-sweep.test.js` adds:
  - `money/charges/:id/pay` (public by design: paying a merchant);
  - `money/charges/:id/cancel` (must be refused);
  - `money/payments/:reference/refund` (must be refused for non-payees).
- The permission matrix was regenerated: 400 routes, all with policies.

Result: ⟨SWEEP⟩

## 19. Full fresh-DB gate

Fresh database `joko_j4_gate`, commit ⟨COMMIT⟩:

⟨GATE⟩

## 20. Production-shaped rehearsal (schema changed)

Migration `20261006000000_j4_money` is **additive only**:
- a nullable `MoneyRequest.expiresAt`;
- a new `MerchantCharge` table.

`scripts/rehearse-migration.mjs` gained a J4 step. On the 2026-08-17 production shape it shows:
- the J4 migration is applied;
- a legacy pending request is preserved (amount, status, **no invented expiry**) and still payable through the J4 service;
- `MerchantCharge` is empty;
- invariants are ok.

Result: ⟨REH⟩

## 21. Unresolved risks

1. **The fee schedule is undecided** (all fees are 0). Revenue and tariff decisions are needed before any fee is enabled. Only cash-out can carry a fee today.
2. **The request UI is not reworked.** The server enforces expiry, spam and block rules, but the existing request screens do not yet show the new states (`expired`, `request_limit`) beyond the server message.
3. **Intent polling is bounded** (about 30 s), then shows "Toujours en vérification — consulte ton historique". The user may then need to open history. The app never invites a second payment.
4. **Legacy pending requests never expire.** No expiry is invented for rows created before J4. A one-off product decision could expire them, but it is a data change and needs approval.
5. **Charge codes are bearer references.** Whoever sees the QR sees the merchant name and amount. This is by design and nothing more is exposed; codes expire in 30 minutes.
6. **Refund is a primitive, not commerce returns.** There is no dispute or chargeback workflow.
7. **Residual lock-order risk** (§16): partial pre-locks followed by postings to other accounts. Detected by Postgres, fully rolled back, and retried safely by the client. No real caller pair was found that triggers it.
8. **Pre-existing:** 5 `tsc` errors and 42 `npm audit` advisories, both unchanged since J3.
9. **The production state is unknown.** Verification is still BLOCKED. Nothing here has been deployed or rehearsed against real data.

## 22. Exact commits

⟨COMMITS⟩

## 23. J5 recommendation

Proceed to **J5 only after** the fee decision (§21.1) and with production verification still a parallel workstream. Recommended J5 focus, in this order:
1. **Production readiness of money:**
   - read-only production verification, once unblocked;
   - then the D2/D3 baselining plan;
   - a reconciliation run against real provider statements;
   - the morning admin checklist wired to `admin/money/lookup` and `limits-usage`.
2. **Finish the request UI** and a merchant-side charge screen (create / show QR / cancel). The server for both exists.
3. **Observability for the money paths:**
   - Sentry breadcrumbs on intent states;
   - alerts on `completed_response_lost`, which should be rare, and on reconciliation exceptions.
4. **Keep the roadmap boundary:** no rides, gig marketplace, merchant OS, full returns or social features until the money slices have run in production.
