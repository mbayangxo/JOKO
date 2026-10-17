# J11 plan: Collective Money, Tontines & Community Capital

**Status:** plan only. Nothing in J11 is built or activated. It starts after J10 is accepted, and it moves money, so the K21 Financial Security spec, J2 (atomic kernel postings, invariants) and J3 (authorization, maker/checker) apply to every step. **J11 money stays OFF in production** until the P0 is closed and the owner, finance and compliance approve (P-J11-*).

## 1. What exists (grounded in the code)

| Capability | Code | State | Gap |
|---|---|---|---|
| **Tontine (natt): consent + dedicated escrow** | `lib/tontine-service.js` (task #2) | branch; money behind `TONTINE_ESCROW_ENABLED` (off in production) | Rotation is fixed at start and payout needs all contributions. Missing: late / default handling, replacement members, an emergency pause by vote, a member's own statement, a group-chat link (J10 added the read-only "dues" item and keeps chat separate from membership). |
| Legacy tontine processor | `lib/cron/tontine-processor.js` (in `7d262de`) | **live in production** | Audited in task #3. It must be migrated or retired before any J11 activation (one tontine model only). |
| **Jekkal (solidarity campaigns)** | `lib/jekkal-service.js` | branch | **Finding J11-F1:** each contribution goes **straight to the beneficiary's wallet**. No escrow, no refund if the goal is not reached, no verification of the beneficiary's story (fake-campaign risk), and anonymous donors make abuse hard to trace. Latent: not in `7d262de`. |
| Group purchase (J7) | `lib/b2b/*` group purchase | branch | B2B merchant pooling. Reuse its "commit, then settle when the threshold is met" pattern. |
| Cooperatives (F1, J9) | `lib/cooperative-service.js` | live (F1 patch pending) | Produce payouts are recorded as wages (P-J9-3). J11 gives member-produce settlement its own kind. |
| Groups with roles (J10) | `lib/community/groups.js` | branch | Chat only. **J11 must never derive money authority from chat roles.** |

## 2. Principles (non-negotiable)
1. **Consent per obligation.** Joining a group is never consent to pay. Each contribution or commitment is an explicit, authenticated act by the payer, with step-up above the J4 thresholds.
2. **Escrow by default.** Collective money sits in a dedicated ledger account per group or campaign (`escrow:tontine:<id>`, `escrow:collective:<id>`) and never in an organizer's wallet. Release only follows the group's rule.
3. **Rules are fixed before money moves.** Rotation order, amounts, dates and default policy are hashed into terms that every member accepts (the J9 offer pattern). Changes need unanimous re-consent.
4. **No silent clawback, no pressure mechanics.** No automatic debits, no public shaming of late payers. Reminders are private and rate-limited.
5. **Organizer ≠ treasurer authority.** Releases above a threshold need a second member's confirmation (maker/checker inside the group). Ops can freeze but not move money; moving money needs a finance approval.
6. **Honest messaging** (`K21-REGULATORY-STRATEGY.md`): Kori is a closed-loop instrument. No promise of interest, returns or credit. "Community capital" means pooled savings and solidarity, **not** investment products; anything resembling investment or lending needs a license decision first.

## 3. Phases

| Phase | Scope | Acceptance |
|---|---|---|
| **J11.0 Inventory & decisions** | Map the live legacy tontine processor vs the escrow model. Plan the migration of production tontines (read-only exposure query first). Fix J11-F1 in design. | Inventory doc; read-only exposure SQL; decisions P-J11-1..6 drafted |
| **J11.1 One tontine model** | Retire or migrate the legacy processor behind a flag. Hashed terms accepted by every member. Statement per member. | Concurrency: the same cycle paid twice → once. Invariant: pot = Σ entries. Legacy rows untouched until a reviewed migration. |
| **J11.2 Late, default, replacement, pause** | Grace period. A late member is visible privately to the organizer only. Default policy chosen at creation (skip turn / replacement / pro-rata refund on cancel). Pause by majority vote, recorded. | Adversarial: organizer absconds (cannot: escrow + 2-person release); a member defaults after receiving the pot (policy outcome only, **no automatic debit**); vote races |
| **J11.3 Jekkal v2 (escrowed solidarity)** | Contributions held in escrow until the goal or the deadline. All-or-nothing or keep-what-you-raise, chosen at creation. Refunds on cancel or a missed all-or-nothing goal. A verified beneficiary is required to publish. Anti-fraud review queue (the J10 moderation pattern) | No contribution reaches the beneficiary before the release rule; refunds exact; reporting a fake campaign freezes its release |
| **J11.4 Collective purchase for households** | Neighbourhood bulk buying with a verified local merchant (J10 neighbourhood). Commitments are escrowed; the order is placed only at the threshold, otherwise everything is refunded. | J7 group-purchase invariants applied to consumers |
| **J11.5 Cooperative member settlement** | Member-produce settlement kind (P-J9-3), the shares ledger as records only (no investment returns), and the F1 fix carried over | Payroll is no longer used for produce; F1 regression suite |
| **J11.6 Gate** | Fresh DB, full regression, J2/J3/J8/J9/J10 + new J11 invariants (C1 escrow = Σ commitments; C2 no release without its rule; C3 no double cycle), adversarial lab, browser E2E, rehearsal, security audit, deploy-inert | Report with exact commit evidence |

## 4. Decisions to take before J11.1 (proposed, not approved)

| # | Proposal |
|---|---|
| P-J11-1 | One tontine model. The legacy processor is retired after a read-only exposure check and a reviewed migration. |
| P-J11-2 | Release threshold for a second member's confirmation (proposal: any payout ≥ 100 000 XOF, or any pot release). |
| P-J11-3 | Default policy menu (skip turn / replacement / pro-rata refund on cancel). **No automatic debit of a defaulter.** |
| P-J11-4 | Jekkal: escrow plus a verified beneficiary before publishing; anonymous donations allowed but traceable to ops. |
| P-J11-5 | Caps per group and per person (Kori limits, tier-based), plus AML review triggers. **Compliance decision.** |
| P-J11-6 | Wording: no "investment", "interest", "returns" or "credit". **Counsel and compliance review.** |

## 5. Links to J10
- Aujourd'hui already shows tontine dues (read-only). Notifications have the money category, which cannot be muted.
- Group chats stay chat. A tontine's chat membership never changes tontine membership (tested in J10).
- J10 moderation and reports cover fraudulent campaigns and groups. A messaging restriction never touches money.
