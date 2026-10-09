# J11.0 forensic audit: collective money

**Scope:** every object in the code (branch `claude/jokko-forensic-audit-rprqia`) and the production base (`7d262de`) that pools, holds, schedules or pays out money for more than one person: tontines, pots, schedules and rotations, Jekkal, donations, savings goals, cooperatives, pooled funds, project funding, investments, payouts, refunds, ownership and dividends.

**Status:** local audit, read-only. **Nothing was deployed.** No live tontine was touched, replaced or migrated, and no production database was queried. The production P0 (legacy tontine drain) is **open**: see `docs/incidents/2026-10-p0-tontine-drain-live/`.

## 1. Inventory

| Object | Tables | Code | In production `7d262de`? | Money path today | Source of truth |
|---|---|---|---|---|---|
| **Legacy tontine (auto-collect)** | `TontineGroup`, `TontineMembership`; legacy rows in table `TontineContribution` (Prisma `LegacyTontineContribution`) | `7d262de:lib/tontine-service.js` `processTontineGroup`, `lib/cron/tontine-processor.js` | **YES, LIVE** | Debits every listed member's wallet into the **creator's personal wallet**, with no consent; the daily cron does the same | `LedgerEntry` (`tontine_contribution` / `tontine_pot_in` / `tontine_payout` / `tontine_receive`) |
| Tontine consent + escrow (task #2) | `TontineGroup` (+status, cycle), `TontineMembership` (+status), `TontineCycleContribution`, `TontinePayout`, `TontinePotEntry` | `lib/tontine-service.js`, `lib/tontine-handlers.js` | no (branch) | Member wallet → J2 `tontinePot` escrow → rotation recipient. Flag: `TONTINE_ESCROW_ENABLED` (production default off) | J2 ledger; `potBalance` = Σ `TontinePotEntry` |
| **Jekkal** solidarity campaigns | `SolidarityCampaign`, `SolidarityContribution` | `lib/jekkal-service.js`, `lib/jekkal-handlers.js` | no (branch) | Donor wallet → **beneficiary wallet directly**, per contribution | `LedgerEntry` (`solidarity_donate` / `solidarity_receive`) |
| Personal payment funds (earmarked pots) | `PaymentFund`, `ScheduledPayment` | `lib/scheduled-payment-service.js` | no (branch) | Owner wallet ↔ J2 `fund:<id>` liability account; single owner | J2 ledger |
| Cooperative produce payout | `FarmerDeliveryLog`, `PayrollEmployee` | `lib/cooperative-service.js` (payroll rail) | **YES** (F1 double-payout patch ready, not deployed) | Business wallet → farmer, recorded as wages (P-J9-3) | ledger + `FarmerDeliveryLog.status` |
| Group purchase (B2B, J7) | J7 group-purchase tables | `lib/b2b/*` | no | Commit, then settle at threshold | J2 |
| Legacy Kebu investments | `KebuInvestment`, `KebuInvestmentOffering` (`dividendBps` default 500 = "5 %"), `KebuInvestmentPayout` | **none** (schema only, D7 preserve) | tables exist in the production-shaped baseline (1 row / 2 500 in rehearsal data) | none: no writer anywhere | the rows themselves; never backfilled as live balances |
| Legacy Ñu Lekk bill split | `NuLekkSplit`, `NuLekkShare` | **none** (schema only) | baseline tables | none | rows (D7) |
| J10 group chats | `MboloThread` / `MboloMember` | `lib/community/groups.js` | no | **none: chat roles never grant money authority** (tested in J10) | — |
| Cooperative member capital, shares, dividends | — | — | — | **does not exist** | — |
| Protected projects / milestones for collective funds | — | J9 milestones exist for **work** only | — | — | — |
| Group goal savings | — | — | — | **does not exist** (only personal `PaymentFund`) | — |

**Ledger accounts in use:** `tontinePot(groupId)` (escrow), `paymentFund(fundId)`, customer and business wallets. No account exists for campaign escrow, project escrow, group savings or member capital.

**Authorization boundaries today:**
- Legacy tontine: the creator alone, at will (P0).
- Escrow tontine: the organizer starts, cancels, invites and removes (while forming). Any participant may trigger a release, but the destination is fixed by the rotation.
- Jekkal: anyone creates a campaign for any handle. Anyone with tier ≥ 1 donates. There is no operator control.

## 2. Findings

| # | Severity | Where | Finding | Evidence | Disposition |
|---|---|---|---|---|---|
| **P0-A** | **P0, LIVE** | production `7d262de` | Legacy tontine: no consent, debit at will and by cron into the creator's personal wallet | `docs/incidents/2026-10-p0-tontine-drain-live/` (repro: −20 000 each, creator +40 000) | Containment patch ready; deploy **blocked (Vercel 403)**. Live groups are not migrated without an approved plan. |
| **J11-F1** | P1 (latent) | branch Jekkal | Each contribution goes **straight to the beneficiary**: no escrow, no refund if the goal fails, no verification | code review | Jekkal is split into DIRECT CONTRIBUTION (honest labelling, existing history preserved) and PROTECTED CAMPAIGN (new, disabled) |
| **J11-F2** | **P0-class design defect, latent** (branch, flag off, never deployed) | branch escrow tontine | The organizer is **forced to rotation position 1** (`startTontine`), and `cancelTontine` (organizer alone, any time) refunds **only the current cycle**. Collect cycle 1, cancel in cycle 2: everyone else's cycle-1 money stays with the organizer. This is an organizer drain through the "safe" model | `docs/j11-evidence/repro-organizer-collect-then-cancel.test.js`: organizer **+2 000**, members **−1 000 each** (balanced: a transfer, not minting) | The J11 engine replaces it: the rotation is fixed in the rules members accept; no unilateral cancel after money moves; prior recipients stay obligated. **The escrow model must not be enabled anywhere as it stands.** |
| **J11-F3** | P2 (latent) | branch Jekkal | A campaign may name **any user as beneficiary without their consent**. Campaigns never close or expire and cannot be cancelled. The public list shows the beneficiary's name and handle. | code review | The protected model requires beneficiary acceptance and verification. The direct model also requires beneficiary consent for new campaigns; existing campaigns are not touched. |
| **J11-F4** | P2 (latent) | branch escrow tontine | Members accept **before the rotation order is known**: it is fixed at start by acceptance time, with the organizer first. No terms hash. One non-payer blocks a cycle indefinitely, with no grace, late, partial or default policy. | code review | J11 engine: hashed rules accepted by every member, a schedule, and obligations with missed, late and partial states |
| **J11-F5** | P2 (legal) | baseline tables | Legacy `KebuInvestmentOffering.dividendBps` defaults to "5 %": a returns promise | schema | Preserved as records only (D7). It is never revived. Model F stays dormant until licensed. |
| **J11-F6** | P2 | cooperative | Produce is paid as wages. No member-capital record. F1 double payout on production (patch pending). | J9 / F1 package | Coop capital = records only (model E); produce settlement keeps its own kind (P-J9-3) |

**Tontine-drain history (for context):** P0-15 was found and proven on `19ac203` in the forensic audit. It was contained on the branch and then replaced by the escrow model (task #2). That containment was **never deployed**, and `7d262de` predates it. J11.0 found that the drain is live in production (P0-A). The escrow replacement itself has the organizer collect-then-cancel defect (J11-F2). The J11 engine fixes both: rules members accept, protected schedule, no unilateral cancel or withdrawal.

## 3. Product models (separate, never mixed)

"Escrow" below means a **dedicated J2 ledger account inside Jokko's closed-loop Kori system**. It is **not** a regulated escrow, trust or insured deposit, and the UI never claims one. No model promises returns, interest, protected principal or insurance.

| | A. Rotating tontine | B. Goal savings (group) | C. Protected project fund | D. Donations / crowdfunding (Jekkal) | E. Cooperative member capital | F. Regulated investments |
|---|---|---|---|---|---|---|
| **Ownership** | Each contribution belongs to its payer until the cycle pays out to the rotation's recipient | Each member owns **their own contributions** (per-member sub-balance in the group account) | Contributors own unreleased funds. A released milestone belongs to the verified recipient. | DIRECT: the beneficiary on receipt. PROTECTED: the donor until release. | The member's recorded capital claim on the coop (record only) | n/a |
| **Who contributes** | Each accepted member, by explicit action, per cycle | Each member, by explicit action | Accepted contributors, by explicit action | Any donor, by explicit action | The coop records what members paid **off-platform or by a separate transfer** | — |
| **Withdrawal** | None mid-cycle. A recipient receives a full pot only on their turn | Only **one's own** balance, under the group's locked exit rule; never other members' | None. Release is per milestone. | DIRECT: none needed. PROTECTED: refund rules. | Per coop statutes, recorded; no automatic payout | — |
| **Disbursement authority** | The **rules** (rotation), once every obligation of the cycle is met. No person chooses the destination. | The member alone, for their own share; a group goal release requires the members' own approvals | Independent approver(s) (J3 maker/checker), **plus** J2 settlement to a verified recipient. Approval alone moves nothing. | DIRECT: n/a. PROTECTED: the goal or deadline rule, plus ops verification of the beneficiary | None: records only | — |
| **Goal failure** | n/a (cycle-based) | Each member keeps or withdraws their own share | Unreleased funds are refunded pro-rata to contributors | DIRECT: no refund (labelled before paying). PROTECTED: all-or-nothing refund. | n/a | — |
| **Exit, death, incapacity** | Before money moves: free exit. After: a member who has **not yet received** may exit with a refund of the current cycle only and is skipped. A member who **has received** stays obligated (recorded debt, **no automatic debit**). Death or incapacity: frozen, then ops case review with the estate or representative. | Own share is withdrawable by the member or, after case review, their estate | Pro-rata claim on unreleased funds | n/a | Recorded claim, settled per statutes off-platform | — |
| **Organizer disappears** | Nothing to drain: the organizer has no money power. The schedule continues; members may vote a replacement facilitator. | Same | Approvers are independent; ops can freeze | PROTECTED: ops can freeze and refund | — | — |
| **Loss bearer** | A member who defaults **after receiving** is a recorded debt. Members who did not yet receive bear that shortfall, **disclosed before joining**. Jokko does not guarantee it. | Nobody: no lending inside the group | Contributors, for funds already released to a recipient who then fails | DIRECT: donors. PROTECTED: none before release. | Members per statutes | — |
| **Refunds** | Exact, from escrow, idempotent: cancellation before payout, refused rules, or a dispute outcome | Own share | Pro-rata, unreleased funds | PROTECTED: exact | — | — |
| **Disputes** | Freeze the cycle's payout; ops review; outcome = release, refund or skip, per the rules | Freeze withdrawals of the disputed share | Freeze the next milestone | Report → freeze release (J10 moderation) | Off-platform | — |
| **Status in J11** | Build (flag off in production) | Build (flag off) | Build **dormant** (separate flag, off) | DIRECT: keep and relabel. PROTECTED: build, **disabled** | Records only | **Not built** (license decision) |

## 4. Production compatibility

- **Live legacy tontines** (`TontineGroup` rows with the old shape, `active = true`) are **not migrated, replaced or mutated** by J11. They stay contained by P0-A once deployed. A **separately approved migration plan** is required: the forensics come first (`historical-tontine-exposure.sql`), then case review.
- New J11 tables are **additive**. J11 does not alter the legacy table `TontineContribution` or the legacy groups.
- Every J11 money path sits behind its own flag, **off in production** (`isProduction()` → env `true` required), in addition to the tontine containment.

## 5. Decisions needed (proposed, not approved)

| # | Decision | Proposal |
|---|---|---|
| P-J11-1 | One tontine model | The J11 engine replaces both legacy and escrow-v1. Legacy groups stay frozen until a reviewed migration plan. |
| P-J11-3 | Default after receiving | A recorded obligation, private reminders, **no automatic debit**, no public shaming. Disclosed as the members' risk. |
| P-J11-7 (new) | Rotation order | Chosen at creation (fixed list, or a seeded random draw recorded in the rules hash). Never "organizer first" by default. |
| P-J11-8 (new) | Cancellation after the first payout | Not unilateral. Unanimous vote of members who have not yet received, or an ops dispute outcome. Prior recipients remain obligated. |
| P-J11-9 (new) | Jekkal DIRECT | Keep it, labelled "direct gift: no refund". New campaigns require beneficiary consent. Existing campaigns are untouched. |
| P-J11-5 | Caps and AML triggers | Compliance |
| P-J11-6 | Wording | Counsel |
