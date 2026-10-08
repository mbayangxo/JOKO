# Jokko J9 — Work & Opportunity (plan; not started)

**Status:** this is a plan only. **No J9 code is written** until the J8 internal-pilot gate is accepted and the prerequisites below are met.

## 0. Prerequisites (owner decisions or actions, before any J9 money moves)
1. **Deploy the delivery-dispute P0 patch on `7d262de` and verify it.** Never use `19ac203`: its navigator crashes (incident §8). The incident stays OPEN until then.
2. **Read-only production inspections** already owed: D32 (J7 migration), D22 / D30 (legacy settlement and agents). For J8: legacy `DeliveryTask` rows in `open` / accepted states before D41 goes live.
3. **Finance:** J8 pricing and settlement (D35), then any J9 rate. Every J9 rate starts at **0 and inactive**, as in D28.
4. **Decision on role-aware rate limits.** The J3 per-user limiter (80 requests / minute → 15-minute block) can lock out a very busy dispatcher (pilot finding, J8 report).

## 1. What J9 is
J9 lets people earn from **work Jokko can verify**. It reuses what J6–J8 proved.

| Primitive | From | Reuse in J9 |
|---|---|---|
| Counterpart-issued, single-use, bound challenge | J6 cash, J8 custody | proof that a piece of work happened (the receiver of the work confirms) |
| Funded earning: escrow → accrued → hold → releasable → paid, dispute freeze, maker/checker reversal | J8 courier earnings | every J9 earning |
| Separate, explicitly granted roles (D25) | J3 / J5 / J6 | a worker profile grants nothing; each engagement is its own revocable grant |
| Operator rulings with permission, reason, audit, once | J3 / J8 | disputes about work |

## 2. First slices (in order; each is a gate)
1. **Fleet drivers and Jokko couriers, as workers.** Their earnings already exist (J8). J9 adds:
   - a worker home showing earnings, holds and history (the J8 Gains tab, generalised);
   - statements for a period;
   - a worker profile they control: visibility, availability, entered by them and never inferred;
   - **no ratings until there is real volume.**
2. **Pickup-point operators.** A per-parcel fee on a **verified** release or drop:
   - funded from the shipment fee split, configured by finance, default 0;
   - the same accrued → hold → paid path.
3. **Distribution reps.** A commission only on **verified** outcomes:
   - a first order from an onboarded merchant that was **received** (J8 receiving), not merely placed;
   - never on self-reported visits;
   - funded by the distributor under an explicit, maker/checker-approved rule;
   - clawback only before payout, as in D38.
4. **Gigs (Movement → Gigs).** These stay **dormant** until a gig has a verifiable completion (a counterpart challenge) and funded escrow from the requester. No open marketplace without both, for the same reason as D41.

## 3. Hard boundaries
- **Payroll stays J5.** Salaries are the employer's tool. Platform-funded gig earnings use their own ledger accounts and are never mixed with payroll.
- **No invented labour signals:**
  - no "jobs near you" without real, funded demand;
  - no fake availability, ratings or GPS;
  - status-based matching first.
- **No earnings without a funded source.** The kernel refuses unfunded moves. J9 adds an invariant per earning type, in the style of I21.
- **Worker privacy:** a requester sees what the work needs and nothing more. Purpose-limited data, as J8 does for addresses.
- **Neutral infrastructure (D33):** no business-id privileged paths for Jokko's own operations.

## 4. Gate shape (to refine with the owner)
J9 follows the J8 pattern:
- money and custody invariants, with detection tested;
- authorization-boundary gate entries for every new critical route;
- an adversarial lab (fake completion, self-dealing, duplicate claims, colluding requester and worker, farming);
- fresh-DB gate at the latest HEAD, migration rehearsal and browser E2E of the worker flows;
- an honest dormant register.
