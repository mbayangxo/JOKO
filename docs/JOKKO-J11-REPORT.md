# Jokko J11: Collective Money, Tontines & Community Capital — report

**Verdict: see §7.** J11 is a **LOCAL engineering milestone**. It is not deployed and makes no production claim.
- **Production P0-A (legacy tontine drain) is NOT contained.** The owner authorized the containment deploy and read-only forensics. Both stopped at identity verification because Vercel team-scope access returns 403 (§1). Nothing was deployed; no production database was contacted.
- P0-B (delivery dispute) and F1 (coop double payout) remain separate packages, not deployed. Kebu Supabase was never accessed.
- **Every J11 money switch is off by default:** `JOKKO_COLLECTIVE_ENABLED`, `JOKKO_PROTECTED_FUNDS_ENABLED` (both must be `true`; neither is set anywhere in production). No live tontine was migrated or mutated; all J11 tables are additive.

## 1. Emergency track (separate from J11)

| Item | Status |
|---|---|
| P0-A containment patch (`docs/incidents/2026-10-p0-tontine-drain-live/`) | Ready and tested locally on `7d262de` (122/122). **Not deployed.** |
| Production identity | `GET /v2/user` works; every team-scoped read (project, deployments, deployment detail) returns **403**. Live commit, deployment, runtime and database identity cannot be re-verified → **stopped**, per the authorization's own rule. |
| Read-only forensics | **Not run**: database identity unverifiable; no credentials in the container. |
| Unblock | Reconnect the Vercel connector with access to team `mbayangxos-projects` (claude.ai → Settings → Connectors) and start a new session, or the owner deploys §4 of the incident README and runs `historical-tontine-exposure.sql` read-only. |

## 2. Findings during J11

| # | Severity | Finding | Status |
|---|---|---|---|
| P0-A | **P0, live** | Legacy tontine drain on `7d262de` | containment ready, **blocked** (§1) |
| J11-F1 | P1, latent | Jekkal gifts go straight to the beneficiary (no escrow) | kept as **DIRECT** (disclosed as a direct transfer, P-J11-9); protected campaigns are a separate dormant product |
| **J11-F2** | P0-class, latent (branch, flag off, never deployed) | Escrow-v1: organizer forced first in rotation + unilateral cancel after collecting → keeps members' money (reproduced: +2 000 / −1 000 / −1 000) | **fixed** in v1 (cancel refused after any payout) and **replaced** by the J11 engine; regression in the engine suite |
| J11-F3 | P2, latent | Jekkal: any user named as beneficiary without consent | **fixed**: a campaign for someone else opens only on their consent; existing campaigns untouched |
| J11-F4 | P2, latent | v1: members accepted before the rotation was known; one non-payer blocked a cycle forever | replaced by hashed rules + grace/missed/partial/votes |
| Stale-auth | P2 | Courier role and cash-agent status read without a lock inside the money tx (same pattern as the J3 race) | **fixed** with deterministic interleaving tests (fail on old code) |

Full audit: `docs/JOKKO-J11-0-AUDIT.md` (inventory, sources of truth, ledger accounts, authority boundaries, production compatibility, models A–F).

## 3. What J11 delivers

### Model A — rotating tontine, Model B — group goal savings (`lib/collective/engine.js`)
- **Lifecycle:** create → invite (authorizes nothing) → join → organizer proposes rules for the joined members → **every member approves the exact SHA-256 of the rules** (rotation by recorded draw or an order everyone sees; schedule; grace; policies) → active (obligations created; **no money moved**) → contributions → payout by the rules → completed / cancelled.
- **Consent per payment:** each contribution is the member's own action, idempotent on their key, step-up by amount. **Missed payments are recorded, never auto-debited**; reminders are private.
- **Payout eligibility is the members', not a person's:** a cycle pays the accepted recipient only when every live obligation is settled and no dispute is open. Exceptions only by vote: grace extension (majority), partial release (unanimous paid members incl. the recipient), cancel (unanimous members who have not yet received; after any payout it only opens a controlled settlement executed by a second, finance operator, P-J11-8), exit (others unanimous; never after receiving).
- **Organizer has no money power**; rules are **locked by a database trigger** after activation; money history, payouts, ballots and events are **append-only** in the database.
- **Late payments catch up** to the short-paid recipient through the pot; cancellations refund the current pot exactly and record every member's net position (no automatic debit of anyone).
- **Goal savings:** each member's money sits in their **own** J2 account (`collective:<g>:share:<user>`); only they can withdraw it, under the accepted unlock rule; completion/cancel returns every share to its owner.
- **Operators:** `collective_ops` rules disputes (continue / release collected / skip recipient) and freezes groups — **never moves money**; the money consequence executes once on a **different finance operator's** approval. Unfreeze needs a different operator.

### Model C — protected project fund, Model D-protected — protected campaign (`lib/collective/protected.js`, **dormant**)
- Verified recipient (KYC tier ≥ 2 not frozen, or verified active business) who consents; 1–5 **independent** approvers (never organizer or recipient).
- Contributions in J2 `protected:<id>:escrow`, capped at the goal. **Approval never moves money**: each milestone release is a separate maker/checker settlement that re-checks the recipient at that moment (a suspended recipient is never paid).
- Missed deadline → full automatic refund; cancellation → pro-rata refund of what remains (largest remainder, exact to the unit); 3 independent reports freeze; one protected campaign per beneficiary.

### Model D-direct — Jekkal; Model E — coop capital (records only); Model F — not built
- Jekkal stays **direct**: disclosed as an immediate transfer that is not held or returned automatically, with a K21 support route for fraud or error (no absolute no-refund promise, P-J11-9); beneficiary consent required for new campaigns about someone else.
- Coop register: member capital / gift / loan / wage reference kept apart; **investment returns refused** (no licence); member confirms or disputes; DB-enforced append-only; **no money, shares or dividends**.

### UI (web app + ops console)
Groups list + create, group screen (rules approval with the drawn order, schedule with each cycle's payment status, my dues, contribute with step-up, votes, disputes, history, goal withdrawal), coop register, Natta entry point, Jekkal beneficiary consent, ops console **Collectif** tab (disputes, finance approvals, groups, freeze). No fake balances or opportunities: every figure is read from the ledger or the group's own rows.

## 4. Pilots (local, each backed by an automated test)

| Pilot | Evidence |
|---|---|
| One full-cycle tontine | engine "full rotating cycle", HTTP "full tontine through the API", browser E2E (create → invite → join → approve drawn rules → contribute → payout) |
| One goal-savings group | engine "goal savings … own share only", "`anytime`" |
| A missed payment | engine "missed payment: recorded, never auto-debited; partial release …; late payment catches up" |
| A malicious organizer drain attempt | engine "J11-F2 regression"; adversarial "collusion"; v1 evidence test now asserts the drain is closed |
| A failed project | protected "deadline passes without the goal → everyone refunded in full" |
| A protected milestone with independent approval | protected "approval never moves money; release only via a second operator" |
| A Jekkal direct campaign | "Jekkal DIRECT … opens only with their consent" |
| A coop-capital record with no investment payout | "coop capital: records only … no investment returns"; browser E2E confirmation |

## 5. Adversarial and concurrency coverage
Malicious organizer (early release, unilateral cancel, exit after receiving, rule change → all refused), collusion (a unanimous vote still pays only the rotation recipient), fake beneficiaries (verification, consent, reports → freeze, one campaign per person), replayed payouts and settlements (idempotent), compromised recipient (dispute → skip recipient via maker/checker), compromised device (step-up on large contributions), simultaneous withdrawals, concurrent ballots, racing contributions to a goal, frozen group, outsiders (404 everywhere), dark default (503).

## 6. Gate at the latest code HEAD (fresh database)

**Commit `6a4c0fa`.** Database `joko_gatej11`, built from scratch; isolated worktree with its own `node_modules`; the generated client matched the schema at the start and the end.

| Check | Result |
|---|---|
| Full regression (`npm test`, J1–J11, incl. the J3 race fix and the stale-authorization tests) | **727 / 727** |
| J2 money invariants (after the suite / after load and sweeps) | **OK / OK** (4 149 entries, 8 450 postings) |
| J8 logistics, J9 work, **J11 collective (C1–C7, P1–P4)** invariants, after the suite / after everything | **OK / OK** for all three |
| Load (J4–J10 suites) | **5 / 5**; J10 p95 0.56 s, J9 p95 1.32 s (local) |
| Authorization-boundary gate, mutation sweep, data-exposure sweep, admin sweep (all J11 routes covered) | **5 / 5** |
| Migration rehearsal on the production shape (incl. both J11 migrations) | **20 / 20 steps** |
| Migrations ⇄ `schema.prisma` | **empty diff** |
| Web build | **OK** |
| Browser E2E J8 / J9 / J10 / **J11** | **12 / 12, 11 / 11, 7 / 7, 8 / 8** |
| `npm audit --omit=dev --audit-level=critical` | **0 critical** (20 high / 8 moderate, build tooling, unchanged) |
| Deploy-inert | No deploy, no env change. J11 flags default off; `cron/collective` and `cron/protected` are not in `vercel.json`; both migrations are additive. |

**Honest record:** the first run at `9de9c47` failed **2 / 727**. On a fresh test database (built with `db push` + `prisma/sql/*.sql`, not migrations) the J11 rules-lock and coop append-only triggers were absent, so the database did not refuse the change. The migrations (the production path) already had them. The guards were mirrored into `financial-invariants.sql` (`6a4c0fa`), and the full gate was rerun from scratch: the table above.

## 7. Verdict, risks, J12

**Verdict: J11 is COMPLETE as a local engineering milestone.** Rotating tontines and goal savings work end to end (API, member/organizer UI, ops console, browser E2E) with consent per member, locked rules, member-controlled exceptions, no organizer money power, atomic idempotent J2 money, and database-enforced history. Protected funds exist and are tested but **dormant**. This is **not** production approval, and **production remains exposed to P0-A** until the containment is deployed.

**Unresolved risks**
1. **P0-A live and uncontained** (Vercel 403). Highest priority, ahead of anything in J11.
2. **P0-B and F1** packages not deployed (separate authorizations).
3. **Legacy tontine groups in production** are frozen only once P0-A is deployed; any migration to the J11 engine needs a separately approved plan after the forensics.
4. **Default after receiving** (rotating): a member who received and then stops paying leaves a recorded debt; the members who have not yet received bear it. Disclosed in the rules; Jokko does not guarantee it (P-J11-3).
5. **Disputes and freezes need staffed operators** (`collective_ops` + finance) and an SLA.
6. **Protected funds**: the word "protégé" must pass counsel review (closed-loop Kori, not escrow or insurance); recipient verification relies on KYC tier ≥ 2.
7. **Unexplained J4 P2P failures** (four, one historical batch, logs lost): still unresolved, kept in the risk register; not reproduced in any later run, including both J11 gates.
8. Everything was measured locally on one node; J11 has no dedicated load scenario yet.

**Decisions:** P-J11-7, P-J11-8 and P-J11-9 were **approved on 2026-10-10 as local design policies only** (no production activation) and are applied in code (`docs/JOKKO-DECISIONS.md`). Still pending, exact terms to be reviewed: P-J11-1, P-J11-2, P-J11-3, P-J11-4, P-J11-5 (compliance), P-J11-6 (counsel).

**J12 recommendation: Production readiness & offline/low-bandwidth, gated on the emergency track.**
1. **First, before any J12 feature:** restore Vercel team access; deploy and verify P0-A; run the read-only forensics; decide P0-B and F1 deploys. Then define a **reviewed release path** from the branch (no wholesale default-branch deploy: F4, J10-F1/F2 and the J11 findings must ship together or not at all).
2. **Controlled J11 pilot** behind the flags for a small invited cohort, after P-J11 decisions, counsel wording and operator staffing; legacy-tontine migration plan from the forensics.
3. **J12 scope:** offline-tolerant money journeys (queued intents with server idempotency), low-data UI, SMS/USSD fallbacks for dues and receipts, a J11 load scenario, and a production observability baseline (Sentry, uptime, the morning admin checklist from `K21-QUALITY-CONTROL.md`).
