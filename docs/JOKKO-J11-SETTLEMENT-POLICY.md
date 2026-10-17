# J11 post-payout termination: rights review and settlement policy (P-J11-8)

**Status:** approved as a LOCAL DESIGN POLICY (2026-10-10). **No production activation.** `JOKKO_COLLECTIVE_ENABLED` stays off.

## 1. Five things kept apart

| Concern | What it is | Where it lives | Who can act |
|---|---|---|---|
| **Member approval** | The members who have not yet received a pot agree, unanimously, to end the group | `CollectiveVote` (topic `cancel`) | Those members. The vote only sets `settlement_pending`; **it never moves money**. The group then accepts no contribution, payout or withdrawal. |
| **Claims and obligations** | Each member's position = received − paid (refunds count as received) | `CollectiveClaim`, immutable, written at close | Nobody edits or erases them. `owes` = received more than paid; `owed` = paid more than received. **Σ owes = Σ owed** (money is conserved). |
| **Money held** | Only the open cycle's pot (rotating) or each saver's own share (goal) | J2 `collective:<g>:pot` / `:share:<user>` | Returned to **exactly** who paid it or owns it. Nothing else moves. |
| **Settlement eligibility** | `settlement_pending`, not frozen, **no open dispute anywhere in the group** | checked at execution | A member may open a dispute while settlement is pending; it blocks settlement until an operator rules it. |
| **Execution** | Refund of the held money, closing of obligations, claims, status `cancelled` | `executeTerminationSettlement` | Only through `collective_termination_settle`: requested by `collective_ops`, executed once by a **different** finance operator; idempotent. |

## 2. What a settlement never does
- **Never forgives debt.** Past `missed` obligations stay `missed` (history is not relabelled). Future obligations close as `terminated`, and their value is carried by the claims.
- **Never creates debt.** Claims are exactly received − paid per member, computed from the append-only money history.
- **Never redistributes.** Nobody is debited. No claim is paid from another member's money. A member who owes is not charged automatically. How (or whether) recoveries reach creditors is **P-J11-3, still pending**. Until then, claims are records only.

## 3. Rights of each member (rotating)

| Member | At termination |
|---|---|
| Already received a pot | Cannot vote to end or exit (they hold others' money). Their claim records what they owe (typically `owes`). Nothing is auto-debited. |
| Not yet received, fully paid | Votes. Their payment in the open cycle (if any) comes back. Their claim records what they paid into earlier pots (`owed`). |
| Missed a contribution | The missed obligation stays on record. Their claim reflects what they actually paid (smaller `owed`, or larger `owes` if they had received). |
| Exited earlier (by vote) | Was not charged after exit. At close their contributions appear as an `owed` claim. |

## 4. Votes never move money (all topics)
- `partial_release`: the vote makes the cycle **eligible**. The payout is executed by the release rule (any member's request or the scheduler), re-checking dispute, freeze, cycle and pot at that moment.
- `exit`: status only. A goal saver withdraws their own share themselves. Leaving during one's own turn (which would need a refund) is refused to votes and handled by a dispute ruling executed by finance.
- `cancel`: `settlement_pending` only (§1), even before any payout.
- `extend_grace`: dates only.

## 5. Evidence
`tests/j11/termination-settlement.test.js` covers:
- a vote moves nothing, even before any payout;
- a partial pot with missed contributions after payouts (exact claims, Σ owes = Σ owed, missed obligations kept);
- frozen → refused;
- open dispute → refused until ruled;
- three simultaneous settlements and retries → one execution;
- an exit vote moves nothing, and leaving on one's own turn is refused to votes;
- completion with an exited member → explicit `owed` claim.

Engine, HTTP and adversarial suites were updated to match. New invariant **C8** (claims only on closed groups, exact, balanced; a closed rotating pot is empty).
