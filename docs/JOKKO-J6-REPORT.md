# Jokko J6 gate report: Agents & cash network (local)

Branch `claude/jokko-forensic-audit-rprqia`, on the accepted J5 head (`fa0700c` code, `025654a` report; decisions D21–D27 recorded in `e9ed548`'s parent).

**Scope and limits.**
- Built and proven **locally only**; nothing was deployed and no pull request was opened.
- Production is untouched; no production row was read or changed. The Kebu Supabase project was not touched.
- Vercel branch deployments stay disabled; the database deployment step stays inert (`db-migrate-deploy.mjs` exits 3).

**Verdict: the J6 gate is met locally** (gate run §25–29, commit in §32).
- No new P0 is open.
- No tested path creates, destroys or duplicates money.
- No cross-agent, cross-business or cross-role financial access succeeded in the adversarial lab or the sweeps.

The audit of the existing agent code (§0) found **one theft-class weakness in the pre-J6 design** (the bearer withdrawal QR) and several trust gaps. All are fixed by replacement, not patched over.

Two problems were found and fixed **during** J6, both before any commit was accepted:
1. **Invariant I15 caught a float-history bug** in the first version of the new hold/release recipes. Available float moved without its history row. Fixed in the recipe; I15 now holds after every test.
2. **A route-name collision.** The new customer endpoints were first named `POST cash/in|out`, the same names as the existing mobile-money routes. A duplicate key in the route object silently replaced both the provider handlers and their J3 policies, and the full suite exposed it (provider cash tests failed). The cash network now lives under `agent-cash/*`, and a new static test fails on any duplicate route or policy key (`tests/j6/routes-static.test.js`).

---

## 0. Audit of the existing agent code (before building)

| # | Finding (pre-J6) | Severity | J6 resolution |
|---|---|---|---|
| A1 | **Withdrawal QR was a bearer token for cash.** Whoever held the customer's QR (screenshot, forwarded image, shoulder-surfing) could collect the cash at any agent. The agent's confirmation debited the victim. | **P1 (theft)** | Retired (`410 cash_flow_retired`). A cash-out now needs the customer's **own PIN authorization of the specific bound agent + amount** (§8). |
| A2 | Cash-out funds were not held at request; balance checked only at creation, so two QRs could be created on the same ₭ (the second failed at confirmation, which was a 500 before J5). | P2 | ₭ are **held** in the request transaction (`customer:<id>:held`). |
| A3 | Admin-created agents were `active` immediately; schema default `status = active`. `approveAgentProfile` recorded no approver, time or reason and activated in one step. | P2 | Lifecycle with attributed transitions; default `applied`; activation maker-checker (§2). |
| A4 | `patchAgentProfile` accepted any `status` (handler blocked it, function did not). | P3 | Function no longer takes a status. |
| A5 | `agents/nearby`: ordering by float, `openNow` derived from float, ~100 m coordinates, liquidity inferred from the `canServe` filter. | P2 (privacy / fake availability) | Replaced by service-point discovery (§17). |
| A6 | Commission = monthly **off-ledger** "accrued" estimate from cash-in volume, with no funding source; farmable with self-deposits. | P2 | Per-transaction funded ledger commissions (§9). The monthly cron is LEGACY and accrues nothing new (no legacy deposits are created any more). |
| A7 | No organization / service-point model; agent location was a free text label plus precise lat/lng. | P3 | AgentOrganization → AgentServicePoint (§4). |
| A8 | Agent reconciliation reported `impliedCashHeldXof` as if it were a fact. | P3 | Physical cash is labelled self-reported and non-authoritative (§10). |
| A9 | `agentCode` generated from `count + 1` (race → unique violation). | P4 | Random code. |

The legacy models (`AgentDeposit`, `AgentWithdrawal`, `AgentFloatEntry`, `AgentPayout`) and their history routes are kept and readable. Only the unsafe write routes are retired.

---

## 1. Kabu settlement (J6.0) — design and evidence

**Recipe.**
1. Partner key authenticates the partner. The request carries `merchant.external_business_id`.
2. The id is resolved through the **calling partner's** `ExternalLink(objectType=business)`, which must be **active**. A Jokko business id is an assertion only (`409 mapping_mismatch`). Nothing resolves by name, phone or `Business.kebuId`.
3. The merchant must be active (`Business.status`, new, compliance-managed).
4. The authoritative amount and reference come from the partner request, with `partnerId + reference` idempotent; a different amount or merchant is `409`.
5. The J2 ExternalOperation is created with `accountCode = business:<id>:wallet`. The kernel now credits **the account the operation was created for** (`cashInTarget`), never one re-derived at confirmation.
6. At confirmation the link row is re-locked (`FOR UPDATE`) and the business share-locked. If the link was revoked or re-pointed, or the merchant suspended, the funds go to `partner:<id>:unallocated` with a `ReconciliationException(partner_settlement_held)`. The bound business is never silently replaced.
7. Release is a **constrained maker/checker adjustment**. It goes only to the business bound at creation, only while that link and business are active again. The generic approve route refuses it (`constrained_request`).
8. The response and the signed webhook carry `settlement { target, legacy, external_business_id, status, ledger_reference }`.

**Legacy path (D23).** Unmapped payments keep the platform wallet and are labelled `legacy_platform`. `PARTNER_LEGACY_PLATFORM_SETTLEMENT=false` refuses them. A legacy payment with no configured settlement wallet is now **held for review instead of being completed unbooked** (it was unbooked before). Historical rows are not rewritten (column default `legacy_platform`).

**Tests** (`tests/j6/kabu-settlement.test.js`, 10):
- valid mapping;
- missing, revoked and foreign-partner mappings;
- wrong Jokko business, and a Jokko id used alone;
- inactive merchant at creation;
- idempotency: same request, conflicting amount, conflicting merchant, 5 concurrent creates;
- mapping revoked during payment, followed by release (support refused, release while revoked refused, relink, maker ≠ checker, generic approve refused, released once);
- mapping re-pointed during payment (never follows the new mapping);
- merchant suspended during payment, then reactivation and release;
- 6 concurrent provider confirmations; 4 revoke-vs-confirm races (always exactly one destination);
- response lost and retry; stale and replayed webhooks;
- amount-mismatch webhook;
- legacy path labelled, and the legacy switch-off;
- the platform wallet is unchanged in every mapped case.

Invariants pass after every test, and the rehearsal step passes (§27).

## 2. Agent lifecycle (J6.1)

`applied → under_review (identity verified) → approved → active ⇄ suspended → terminated`; `rejected` from any pre-active state. Legacy values: `pending` ≡ applied, `revoked` ≡ terminated (never rewritten).

- **Identity:** the applicant's own J3 KYC, tier ≥ 2. The operator records the check and cannot override it. A business agent additionally needs an **owned**, verified, active J5 Business. A manager cannot enrol the business.
- **Separation:**
  - the identity verifier ≠ the approver;
  - activation is the approval action `agent_activation` (request `agents.onboard`, approve `agents.activate`, different operators);
  - the activator ≠ the approver of the review.
- **Activation needs** an approved service point of the agent's organization. Float, an application, a service point or a business role never activates anyone.
- **Records:** every transition is an append-only `AgentStatusEvent` (DB trigger) plus an identity audit event naming operator, time and reason. Suspension reason, reactivation (maker-checker again) and termination (final) are all recorded.
- **Legacy agents** keep their status and float and are **fail-closed** until compliance adopts them (`POST admin/agents/:id/adopt`). Adoption creates an organization and a pending point and activates nothing; then the point is approved (rehearsal §27).

Tests: `tests/j6/lifecycle.test.js` (5), `tests/unit/agent-approval.test.js` (2).

## 3. Agent / role permission matrix

| Actor | May | May not |
|---|---|---|
| Customer | create a cash-in intent / cash-out request for **own** account; confirm/authorize/cancel **own** transaction; read own; discover public points | read or touch any other transaction (404); bind; complete |
| Applicant (no role) | read own lifecycle; propose service points of own organization | any cash operation, float, commissions |
| Financial agent (active role + active profile + active assigned point + active org) | scan → bind; complete / decline **bound** transactions with PIN; list own; report cash on hand; request float; settle own commissions | serve own account; touch other agents' transactions; merchant wallets, payroll, distributor data, wholesale relationships (403/404) |
| Distribution rep (business capability `business.distribution.invite`) | start assisted onboarding for its distributor | any agent route (403); merchant ownership |
| Merchant staff | J5 capabilities only | any agent route (403) |
| Support | read-only: overview, liquidity, reconciliation report | float, status, resolution, budget, rules (403) |
| Risk | suspend; risk-hold decisions; request review resolution and clawback | approve its own request |
| Compliance | identity, review, activation request/approval (different operators), service points, merchant-assist permission, termination, legacy adoption, business status | money |
| Finance ops | float (existing caps + maker-checker), propose commission rules, request budget funding, run reconciliation | approve own requests; identity actions |
| Finance approver | approve review resolutions, rule activation, budget funding, clawbacks | request them |

Full generated matrix: `docs/JOKKO-J3-PERMISSION-MATRIX.md` (492 routes).

## 4. Organizations and service points (J6.2)

- `AgentOrganization` (`individual` | `business`; a business kind is backed by a verified J5 Business, never its wallet) → `AgentServicePoint` → agents (`AgentProfile.servicePointId`).
- A service point has: name, **public** service address (private/home words refused), area, coordinates rounded to ~1 km, declared weekly hours (validated), cash-in / cash-out flags, and active state.
- **Merchant assistance** needs the separate compliance flag `merchantAssistPermitted`.
- Points are created `pending`; only compliance activates them.
- Deactivating a point cuts its agents off immediately. Another organization's point cannot be assigned.

## 5. Float model (J6.3)

- **Available:** `agent:<id>:float` (XOF, liability, non-negative, projected to `AgentProfile.floatBalance` by the DB).
- **Held/reserved:** `agent:<id>:float_held`, reserved at cash-in binding.
- **Pending obligations:** bound cash-ins (held) and bound cash-outs (capacity: `float + in-flight cash-outs + amount ≤ floatLimit`).
- **Commission balance:** `agent:<id>:commission` (₭).
- **Transaction limits:** §11.

There is no direct edit: projection writes are refused by the database (adversarial lab), and there is no "set float" route (static check). Float can never be negative, because the liability accounts refuse it and no credit facility exists (dormant). I15 (float = opening + float-entry history) holds after every test. Every float movement has a ledger entry and a float-entry row.

## 6. Cash-in slice (J6.4)

`created → agent_bound → customer_confirmed → completed`.
- **created:** customer intent, Idempotency-Key, tier cap and daily limits.
- **agent_bound:** agent scan; binds agent and point, reserves e-float, checks limits, caps and self-dealing.
- **customer_confirmed:** the customer sees the point and amount and confirms in the app.
- **completed:** agent completes with PIN; one `agent_cash_in` posting (held float → ₭ via the peg); receipts on both sides.

The customer is **never credited because a screen says cash was received**. Completion before customer confirmation is `409 not_completable`.

`tests/j6/cash-in.test.js` (8) covers:
- duplicate submit (5 concurrent, same key), duplicate confirm, 5 concurrent completes;
- wrong customer, wrong agent, forged binding; amount, parties and agent immutable (DB trigger), rows undeletable;
- insufficient float, tier balance cap, per-point max, odd amounts;
- unscanned expiry, cancel ×3, bound expiry swept twice concurrently (released once), cancel after confirm refused, agent decline;
- suspended / terminated agent mid-flow (bound → declined + released; confirmed → needs_review → maker-checker release);
- response lost, retry, app restart (list + new QR, old QR dead);
- 6 concurrent cash-ins against 50 000 float (exactly 2 bind; float never negative).

## 7. Cash-out slice (J6.5)

`funds_held | risk_hold → agent_bound → customer_authorized → completed`.
- **Request:** CASH_OUT policy (risk deny/hold, PIN step-up, tier), daily caps, J6 limits. The ₭ are **held** in the same transaction.
- **Scan:** agent capacity, business-agent threshold (> 500 000), circular-cash hold.
- **Authorization:** the customer authorizes **with PIN**, bound to that agent and amount.
- **Completion:** the agent pays cash and completes with PIN; one `agent_cash_out` posting (held ₭ → agent float grows by the peg value); daily usage recorded once.

`tests/j6/cash-out.test.js` (10) covers:
- the happy path and 3 completion replays;
- tier 1, recent recovery, insufficient funds;
- held funds unspendable by a second cash-out or P2P;
- 5 simultaneous withdrawals (only the funded ones);
- same key ×3;
- agent capacity and the business threshold;
- **screenshot/forwarded QR at a thief's agent** (binds, can never complete, the victim sees the point and cancels);
- substitution of transaction, agent or amount;
- cancel before authorization vs decline after;
- stale, customer offline, agent offline (needs_review → late completion pays once);
- agent suspended after authorization (maker-checker "complete on evidence", approved twice concurrently, paid once);
- risk_hold → resume / cancel.

A failed cash-out never destroys funds: every non-completed exit releases exactly once. A completed one is never paid twice.

## 8. Handoff protocol (J6.6)

- **Challenge:** 144-bit random token; only `sha256("cash:"+token)` is stored. The QR is `jokko://cash/<24 chars>`: no amount, name, phone or id.
- **Expiry:** 15 min to bind.
- **Re-issue** is allowed only while unbound and kills the old QR. Binding is single and write-once (DB trigger).
- **Binding hash:** `sha256(tx, kind, customer, agent, point, amount, expiry)`, computed at binding. Customer confirmation and agent completion must both present it.
- **Brute force / enumeration:** 5 invalid scans in 10 min lock the agent's scanner (`429`). Phone numbers, references and internal ids are not codes.
- **Reuse:** an old QR is refused after completion or cancellation by other agents; the bound agent only sees the current state.

`tests/j6/handoff-limits-risk.test.js`.

## 9. Commission accounting (J6.7)

- **Rule:** proposed by finance ops; activated by approval `agent_commission_rule_activate` with a different approver; one active rule per purpose; bps ≤ 200.
- **Funding:** `platform:agent_commission_budget`, funded from treasury by maker-checker.
- **Accrual:** in the completion transaction, one `AgentCommission` per transaction (`txId` unique). States: `accrued`; `unfunded` (0 posted, nothing minted); or `ineligible` (no rule, below minimum, risk-flagged, resolved by review).
- **Settlement:** to the agent's own wallet (idempotent receipt).
- **Clawback:** unsettled only, maker-checker.

The customer fee stays 0 (D18) and is never the funding source: customers are credited the full amount. Agents cannot set commissions. The reconciliation check is commission account = Σ accrued, with one decision per completed transaction.

Tests cover farming: replays accrue once, and repeated pairs or circular cash earn nothing (`tests/j6/commission-ops.test.js`).

## 10. Liquidity (J6.8)

`GET admin/agents/liquidity` shows, per agent:
- available, held and limit (source: ledger);
- pending cash-in/out counts and amounts;
- cash-out capacity;
- low-float flag;
- 7-day demand;
- replenishment hints, labelled "ledger float only — physical cash is not observed";
- last **self-reported** physical cash (`authoritative: false`; `AgentCashReport` is append-only).

Rebalancing is `ARCHITECTED-DORMANT`; cash prediction is `NOT IMPLEMENTED`.

## 11. Limits (J6.9)

One table, `lib/agents/limits.js` (overridable by validated `AGENT_CASH_LIMITS_JSON`):
- min 500 XOF, step 10 XOF (exact ₭);
- per transaction by kind and agent tier;
- customer daily amount and count by kind;
- agent daily volume by kind and tier;
- large cash-out threshold, low-float threshold, challenge TTL, completion window, scan-failure lock.

Customer KYC tier caps and the J3 risk engine apply on top.

## 12. Risk / fraud (J6.9)

All signals are behaviour-only.
- **Customer side, in the J3 cash_out rule table (review → risk_hold):**
  - rapid cash-in→cash-out (now includes agent cash-ins);
  - ≥ 3 cancelled / declined / expired in 24 h;
  - near-limit repetition;
  - one device requesting cash-outs for several accounts.
- **Agent side:**
  - circular cash at the same point within 2 h (cash-out → risk_hold at binding);
  - same customer ≥ 5 times in 24 h;
  - ≥ 5 declines in 24 h;
  - velocity.

  Flags remove commission eligibility. Self-service by an agent on its own account is refused.

A static fairness test covers `lib/agents/risk.js`, `limits.js` and the engine: no country, nationality, language, name, area/neighbourhood, address or diaspora field. Internal signal names never reach the client.

## 13. Reconciliation (J6.10, hard gate)

`reconcileAgents()` checks:
- ledger float = projection;
- held float = open bound cash-ins;
- commission account = Σ accrued;
- every transaction's postings match its state (HOLD / COMPLETE / RELEASE: completed ⇒ hold + complete, no release; terminal ⇒ release iff held, never complete; open ⇒ held, never complete or release);
- one commission decision per completed transaction and none otherwise; accrual postings exist;
- terminated agents still owed float or commission.

GET is a read-only report. POST (finance) records `ReconciliationException(provider=agent_network)`. There is **no "make it match" route** (static check). Corrections are maker-checker review resolutions or adjustments. A tampered state is detected in the tests.

## 14. Support tooling (J6.11)

`GET admin/agents/:id/overview` (support) returns:
- lifecycle with actors;
- organization and point;
- ledger float;
- limits;
- commissions;
- the last 30 transactions (masked customer, no phone or balance);
- risk holds;
- open exceptions;
- self-reported cash.

Support gets 403 on float, suspend, terminate, resolve and budget. Finance gets 403 on identity actions. Maker-checker applies to activation, review resolution, rules, budget and clawback.

## 15. Assisted onboarding (J6.12)

Reusable by distributors (`business.distribution.invite`, distribution mode) and by service points permitted for merchant assistance.
1. The rep starts. Introducer, organization, rep, territory, date and status are recorded.
2. The merchant opens the code on **their own** account and must be KYC tier 2.
3. The merchant confirms authority (`confirmAuthority: true`) and accepts.
4. The business is created with the **merchant as owner** (settlement: business wallet).

The rep and the introducer get **no membership, capability or money access**. The rep cannot accept for the merchant. The rep's list shows status, not the merchant's account. Removed reps and non-permitted points cannot start.

## 16. Strict role separation (J6.13)

`tests/j6/roles-onboarding-discovery.test.js`:
- rep → cash-in / cash-out / float / commissions: refused;
- financial agent → merchant wallet / payroll (valid body) / distributor relationships / territories / customers: refused;
- cashier → agent operations: refused;
- onboarding rep → merchant ownership: refused;
- removed rep: refused;
- suspended agent: refused.

**One person in three networks** (agent + merchant owner + distribution rep): each authority is independent. Suspending the agent leaves merchant and rep authority intact, and vice versa.

## 17. Discovery / privacy (J6.14)

`GET agent-cash/points` (and `agents/nearby`, same safe shape) lists only **active points with an active organization and at least one agent with an active role and profile**. Each point shows:
- name, public address, area, services;
- `largeCashOut`;
- declared hours, and `openNow` **only from declared hours** (`openNowSource: declared_hours`, null otherwise);
- distance from rounded coordinates.

Points are sorted by distance and never by float. A zero-float point is listed: there are no liquidity claims. It returns no phone, user id, float or precise location. A suspended agent's point disappears.

## 18. Offline / retry matrix (J6.15)

| Situation | Server | App (`AgentCashScreen`, `AgentHomeScreen`) |
|---|---|---|
| Timeout on create | Idempotency-Key per attempt; `(customer, key)` unique → same transaction | Same key reused; on mount an **open** transaction of the same kind/amount is resumed, never re-created |
| Server completed, response lost | Completion is idempotent (`completed` returned again, no second posting) | Polls `GET agent-cash/tx/:id`; shows the receipt |
| App killed | State lives server-side; clocks applied on every read + cron sweep | `GET agent-cash/tx` lists `open`; resumes; new QR only while unbound |
| Network switch / reconnect | — | Keeps last known state while offline; never "try again" |
| Duplicate retry (any step) | Every transition is idempotent under row locks | Buttons disabled while busy |
| Customer committed, agent vanished | `needs_review` after the window; funds stay held; agent may still complete; ops maker-checker | "Vérification en cours … ne refais pas l'opération" |

States shown: `pending` / `checking` / `completed` / `failed_cancelled`. No `nextStep` text tells anyone to repeat a physical cash handoff (asserted in the tests).

## 19. Adversarial lab

`tests/j6/adversarial-lab.test.js` (7) plus the attacks proven in the slice suites:

| Attack | Result |
|---|---|
| Fake agent (forged profile / role without point), self-activation, user token on operator routes | refused |
| Impersonation, cross-agent access, enumeration of ids / phones / references | 404 / invalid_code / scanner lock |
| Unauthorized service point, private address, another organization's point | refused |
| Fake float, direct float / ledger edit | refused by the DB; top-up request moves nothing |
| Double cash-in/out, stale QR, screenshot replay, brute force | one outcome / refused |
| Amount / customer / agent substitution | binding mismatch; immutable columns |
| Simultaneous withdrawals, insufficient funds / float, pending-funds spend | only funded ones; nothing spendable before completion |
| Commission farming, duplicate commission, circular transactions | 0 commission / one accrual / risk_hold |
| Suspended / terminated agent, recovery / new-device bypass | cut off / 403–423 |
| Timeout after settlement, response loss, duplicate retry | idempotent |
| Operator abuse (no role, self-approval, single-operator activation/resolution/funding) | refused |
| Customer balance/history leakage to agents, private location leakage | none (asserted) |

## 20. Concurrency / destruction

- 16 transactions over 8 customers, mixed concurrently: cancels, declines, triple completes and two sweeps, all at once.
- Every transaction ends in exactly one terminal state.
- Agent float = start − completed cash-ins + completed cash-outs.
- Customers = start + cash-ins − cash-outs, to the ₭.
- No hold remains, and reconciliation is clean.

Also proven:
- 6 parallel cash-ins on limited float;
- 5 parallel withdrawals;
- parallel provider confirmations and revoke races (J6.0);
- parallel review approvals;
- the torture-suite race of an agent cash-out against a provider cash-out on the same ₭ (only one is funded).

## 21. J2 invariants

`assertInvariants` runs after **every** test in every J6 file. `npm run money:check` is clean before and after load and sweep in the gate (§25).

## 22. J3 sweeps

Both sweeps now include `agent-cash/tx/:id`, `agent/cash/:id/*`, `agent/service-points/:id` and `agent-cash/points` (results §25). Static guard: no duplicate route or policy key.

## 23. J4 regressions

The J4 suites pass unchanged. The provider `cash/in|out` routes and their policies are intact (§0, collision fixed). The J3 matrix test pins the exact cash-out class: `agent-cash/out` was added, CASH_OUT, step-up always.

## 24. J5 regressions

The J5 suites pass. The only J5 expectation changed is the Kabu contract `perMerchantSettlement` (DORMANT → ACTIVE, per D24).

## 25. Full fresh-DB gate

Fresh database `joko_j6_gate`, code commit **`9af5009`** (`scratchpad/gate6.sh`, same steps as J5):

| Step | Result |
|---|---|
| `npm run test:db:setup` | ok |
| `npm test` | **538 / 538 pass** (J5: 479; +59 J6 tests across 9 files) |
| `money:check` before / after load + sweep | ok / ok (13 243 entries, 26 637 postings, 6 821 accounts) |
| load | 3 / 3 |
| sweeps | 3 / 3 — 141 GET routes; 118 mutating id-routes, 230 calls |
| soak 5 × 1000 sends, no retry | 0 failures, invariants ok, p99 ≤ 315 ms |
| migration dry-run (mbolo) | ok |
| migrations == schema diff | exit 0 |
| production-shaped rehearsal | **17 / 17** |
| migrate-deploy without activation | exit 3 (inert) |
| tsc | the same 5 pre-existing Deno cron-proxy errors as J5, nothing new |
| web export | ok |
| npm audit | 42 (13 moderate, 29 high) — unchanged from J5, no new dependency |

An earlier gate run (`e292479`) failed only the sweeps. The cause was coverage, not a leak: no flow creates legacy agent sessions any more, so the sweeps had no foreign legacy row to attack. Both sweeps now seed one (`8083211`).

## 26. Migration vs schema

Two additive migrations: `20261010000000_j6_partner_settlement` and `20261011000000_j6_cash_network` (tables plus append-only and immutability triggers, mirrored in `prisma/sql/financial-invariants.sql`). Migrate diff from migrations to schema: exit 0 (§25).

## 27. Production-shaped rehearsal

17/17 steps. The new step uses the baseline legacy agent (120 000 XOF float, active role, no point):
- both J6 migrations applied; status and float unchanged; guards present;
- fail-closed (`service_point_inactive`) before adoption, and again before point approval;
- adoption, then approval, then a **real J6 cash-in on migrated data**: completed, float 110 000;
- invariants ok.

## 28. Deploy-inert check

`db-migrate-deploy.mjs` without activation exits 3 (§25).

## 29. Web build / typecheck / audit

§25. tsc: the same pre-existing Deno cron-proxy errors only. Web export ok. Audit as in J5 (no new dependency).

## 30. Dormant register (J6.16)

| Capability | Classification |
|---|---|
| Agent lifecycle, organizations, service points, secure cash-in/out, funded commissions, liquidity view, reconciliation, support overview, assisted onboarding, discovery | ACTIVE |
| Kabu per-merchant settlement | ACTIVE (J6.0) |
| Legacy platform partner settlement; legacy monthly agent prime (off-ledger estimate) | LEGACY (isolated, labelled) |
| Agent-to-agent rebalancing | ARCHITECTED-DORMANT (labelled in liquidity view) |
| Agent credit lines | NOT IMPLEMENTED (float can never go negative) |
| Cash prediction | NOT IMPLEMENTED (labelled) |
| Armored logistics, bank cash settlement | NOT IMPLEMENTED (physical cash self-reported only) |
| Cross-border agents | NOT IMPLEMENTED |
| Franchise / multi-level hierarchies | NOT IMPLEMENTED (one level: organization → points → agents) |
| Per-merchant Kabu payouts, Kabu payroll instructions | ARCHITECTED-DORMANT |

The economic-OS architecture document §3, §15 and §17 are updated (binding, D27).

**Economic-OS compatibility (J6.17).** The agent network is a separate authority domain (D25):
- Its organization may be backed by a J5 Business, but never uses that business's wallet or staff roles.
- Assisted onboarding feeds merchants into J5 without coupling permissions.
- Kabu merchants settle to their own business wallets.
- Pickup points, logistics, cooperatives, tontines and IAWIC are untouched. Service points are a separate model that a later pickup-point network can reference.

## 31. Unresolved risks

1. **Legacy active agents in production** are fail-closed after deploy until each is adopted and its point approved. The count and float need read-only production inspection first (as D22). No bulk migration.
2. **Pending legacy QR sessions** at deploy simply stop working. They never held funds, so no money is at risk.
3. **Physical cash is unobserved.** An agent's till shortage or theft is between the agent and its network; Jokko sees only ledger float and self-reports.
4. **Kabu platform wallet funding.** Mapped merchants' collections now go to their business wallets, while payouts still debit the platform settlement wallet (per-merchant payouts are dormant). Before switching Kabu to mapped settlement, a product decision is needed on how Kabu payouts are funded.
5. **Commission rates are not set.** No rule is active by default and the budget is 0, so agents earn nothing until finance proposes, approves and funds a rule. This is a business decision, not invented here.
6. **`Business.status` is enforced** for partner settlement and business agents only. In-app payments to a suspended business are not yet blocked (proposed for J7).
7. **Binding DoS.** Binding a victim's QR to a colluding agent blocks that transaction until the victim cancels. No money moves; the victim sees which point holds it.
8. **Risk rules are a heuristic foundation,** not a fraud model. Thresholds need calibration on real data.
9. **Assisted onboarding** verifies the merchant's personal identity (KYC). Business documents go through the separate J5 verification.
10. **Cron.** The sweep runs in the daily job and the pending resolver, and lazily on every read. A dedicated frequent schedule (`cron/agent-cash-sweep`, mapped in the cron proxy) is a deploy-time configuration item.
11. **Customer daily caps** are checked before the money transaction, so concurrent requests can exceed the *count* slightly. Amounts stay bounded by held funds and the tier cap.

## 32. Exact commits

| Commit | Content |
|---|---|
| `5cd0c91` | D21–D27 recorded |
| `e9ed548` | J6.0 Kabu mapped-merchant settlement |
| `15ff14a` | Lifecycle, service points, cash state machine, commissions, ops, onboarding |
| `698afd5` | Cash-out, lifecycle, handoff/limits/risk, commissions/ops, roles/onboarding/discovery, adversarial suites |
| `2949920` | `agent-cash/*` namespace (route-collision fix), app wiring, legacy tests ported |
| `e292479` | Legacy agent adoption, rehearsal step, sweeps, permission matrix, architecture doc |
| `07fcac6` | Report draft, proposed J6 decisions |
| `8083211` | Sweeps seed legacy agent sessions |
| **`9af5009`** | **Code gate**: risk_hold cancel by owner, cash sweep on existing crons |

## 33. J7 Commerce recommendation

Proceed to J7 on top of J6, in this order:
1. **Enforce `Business.status` everywhere money reaches a business** (closes risk 6).
2. **Distribution operations** (§17 phase map): wholesale catalogue UI, restocking orders between J5 merchants and distributors, collections. Agents' assisted onboarding is the merchant acquisition funnel.
3. **Decide the Kabu payout funding model** (risk 4), then activate mapped settlement for Kabu.
4. **Commission policy** (rates, budget) with finance, using the J6 rule machinery.
5. **Adopt legacy agents** after read-only production inspection.

Keep the J6 rules: no money outside J2, no authority outside J3, no implicit permission coupling across networks.
