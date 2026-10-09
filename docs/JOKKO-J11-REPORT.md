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
| J11-F1 | P1, latent | Jekkal gifts go straight to the beneficiary (no escrow) | kept as **DIRECT** (labelled no-refund); protected campaigns are a separate dormant product |
| **J11-F2** | P0-class, latent (branch, flag off, never deployed) | Escrow-v1: organizer forced first in rotation + unilateral cancel after collecting → keeps members' money (reproduced: +2 000 / −1 000 / −1 000) | **fixed** in v1 (cancel refused after any payout) and **replaced** by the J11 engine; regression in the engine suite |
| J11-F3 | P2, latent | Jekkal: any user named as beneficiary without consent | **fixed**: a campaign for someone else opens only on their consent; existing campaigns untouched |
| J11-F4 | P2, latent | v1: members accepted before the rotation was known; one non-payer blocked a cycle forever | replaced by hashed rules + grace/missed/partial/votes |
| Stale-auth | P2 | Courier role and cash-agent status read without a lock inside the money tx (same pattern as the J3 race) | **fixed** with deterministic interleaving tests (fail on old code) |

Full audit: `docs/JOKKO-J11-0-AUDIT.md` (inventory, sources of truth, ledger accounts, authority boundaries, production compatibility, models A–F).

## 3. What J11 delivers

### Model A — rotating tontine, Model B — group goal savings (`lib/collective/engine.js`)
- **Lifecycle:** create → invite (authorizes nothing) → join → organizer proposes rules for the joined members → **every member approves the exact SHA-256 of the rules** (rotation by recorded draw or an order everyone sees; schedule; grace; policies) → active (obligations created; **no money moved**) → contributions → payout by the rules → completed / cancelled.
- **Consent per payment:** each contribution is the member's own action, idempotent on their key, step-up by amount. **Missed payments are recorded, never auto-debited**; reminders are private.
- **Payout eligibility is the members', not a person's:** a cycle pays the accepted recipient only when every live obligation is settled and no dispute is open. Exceptions only by vote: grace extension (majority), partial release (unanimous paid members incl. the recipient), cancel (unanimous members who have not yet received), exit (others unanimous; never after receiving).
- **Organizer has no money power**; rules are **locked by a database trigger** after activation; money history, payouts, ballots and events are **append-only** in the database.
- **Late payments catch up** to the short-paid recipient through the pot; cancellations refund the current pot exactly and record every member's net position (no automatic debit of anyone).
- **Goal savings:** each member's money sits in their **own** J2 account (`collective:<g>:share:<user>`); only they can withdraw it, under the accepted unlock rule; completion/cancel returns every share to its owner.
- **Operators:** `collective_ops` rules disputes (continue / release collected / skip recipient) and freezes groups — **never moves money**; the money consequence executes once on a **different finance operator's** approval. Unfreeze needs a different operator.

### Model C — protected project fund, Model D-protected — protected campaign (`lib/collective/protected.js`, **dormant**)
- Verified recipient (KYC tier ≥ 2 not frozen, or verified active business) who consents; 1–5 **independent** approvers (never organizer or recipient).
- Contributions in J2 `protected:<id>:escrow`, capped at the goal. **Approval never moves money**: each milestone release is a separate maker/checker settlement that re-checks the recipient at that moment (a suspended recipient is never paid).
- Missed deadline → full automatic refund; cancellation → pro-rata refund of what remains (largest remainder, exact to the unit); 3 independent reports freeze; one protected campaign per beneficiary.

### Model D-direct — Jekkal; Model E — coop capital (records only); Model F — not built
- Jekkal stays **direct**, labelled "pas remboursé", beneficiary consent required for new campaigns about someone else.
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

_Filled from the gate run — see below._

## 7. Verdict, risks, J12

_Filled after the gate._
