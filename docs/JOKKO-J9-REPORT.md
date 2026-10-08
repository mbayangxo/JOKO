# Jokko J9: Work & Opportunity report

**Verdict: J9 is LOCALLY INTERNAL-PILOT READY (code and tests), with J9 money OFF.** This is **not** production approval:
- **The production delivery-dispute P0 remains OPEN** until the emergency patch is deployed on `7d262de` (never `19ac203`) and verified.
- Nothing was deployed. Production was not touched, and Kebu Supabase was not accessed.
- No live J9 money can move: `JOKKO_WORK_MONEY_ENABLED` is unset everywhere, and only the local test ledger was used.

## 1. J8 follow-ups (closed locally)

| # | What | Commit | Evidence |
|---|---|---|---|
| D42 | Role- and action-aware rate limits: per-class budgets for reads, dispatch and custody codes; no account lockout for busy dispatchers; no blanket bypass; batch endpoints. The 40-merchant pilot runs without a block. | `f172eb5` | `tests/j8/rate-limits.test.js` 6/6; pilot test |
| D43 | Read-only legacy delivery inventory: open tasks, held escrow, in-flight couriers, disputes, migration eligibility. Opaque ids only. **Not run against production.** | `f696618` | Local run; rehearsal on the migrated DB |
| D44 | Buyer-side return stock: holds on ship (never on request), quarantine without negative stock, damaged units bounded by receiving, verified courier handover, release once on a cancelled or failed collection, re-ship attempts, DB guard, invariant L9. | `a1a8282` | `tests/j8/return-stock.test.js` 11/11 |

## 2. J9.0 audit (`docs/JOKKO-J9-AUDIT.md`, `2652d17`)
- **Classified:** gigs, jobs, worker profiles, staff, payroll, Kabu payroll, cooperative payouts, reps, affiliate / agent / courier commissions, pickup points, apprenticeships, school, OpportunityOS, Kebu / Kabu Team/Work, trust signals.
- **F1 (P1, live route), fixed locally:** cooperative payouts paid a farmer once **per concurrent request** (4 parallel requests produced 4 transfers). Paying two or more logs failed *after* the money moved. The fix claims logs first, marks them paid inside the money transaction, uses per-log references, and releases the claim on failure (`tests/j9/coop-payout.test.js` 3/3). **Production keeps the defect until a separate authorized deploy (P-J9-10).**
- **F2–F5, reported (owner decisions):**
  - F2: produce payments recorded as wages;
  - F3: "reputation for loans" over-claims;
  - F4: the live affiliate commission (5 %, at purchase, never reversed on refund);
  - F5: gigs as products. Gig listings are now refused (410).

## 3. What J9 delivers
Design: `docs/JOKKO-J9-WORK.md`.

**Lifecycle:**
1. verified-business postings;
2. applications and invitations;
3. structured screening;
4. offers with immutable, hashed terms, **funded before acceptance**;
5. worker acceptance (age rules, explicit role grants);
6. attendance by counterpart codes;
7. evidence;
8. business acceptance or dispute, with auto-accept after the agreed window;
9. a held earning;
10. payout.

**Employment vs contract:** employment goes through the employer's payroll (an obligation recorded, never paid by J9). Job-like contracts are refused.

**Types A–G:**

| Type | How it pays |
|---|---|
| A. own-fleet courier | once per verified J8 delivery, never alongside a J8 earning |
| B. rep | only the merchant's first **received and paid** order; dual-controlled, prefunded rule; self-dealing refused |
| C. pickup-point fee | on a verified release |
| D. staffing | accepted milestones; attendance codes when terms say so |
| E. gigs | accepted milestones |
| F. apprenticeships | stipend on accepted milestones; learning plan; 16–17 allowed (non-hazardous) |
| G. cooperative work | member work payment; never wages, never dividends |

**Disputes:**
- party evidence (append-only);
- a ruling by `work_ops`;
- money executed only by a **second** operator (finance), once;
- no automatic clawback of paid earnings.

**Trust:**
- a worker-owned profile with no protected-attribute fields;
- operator-verified qualifications;
- contestable feedback, shown only from 3 ratings;
- blocks;
- fair discovery.

**UI:**
- worker *Travail*;
- business *Recruter & missions*;
- the ops console *Work* tab.

## 4. Gate at the latest HEAD (fresh database)

GATE_TABLE

## 5. Commits
- **D42:** `f172eb5`
- **D43:** `f696618`
- **D44:** `a1a8282`
- **J9.0 audit, F1 fix, gig retirement:** `2652d17`
- **J9 core:** `687ae32`
- **Pilots:** `60ca872`
- **Trust and gate entries:** `0899791`
- **UI and E2E:** `b149aec`
- **Rehearsal:** `dd5f568`
- **Docs and load:** `ca4b7ee`
- **This report:** see `git log`

## 6. Unresolved risks (honest)
1. **The production P0 is open.** The F1 cooperative double-payout and the F4 affiliate behaviour are live in production until authorized deploys and decisions happen.
2. **Auto-accept versus the false-completion window.** An auto-accepted milestone becomes payable after the 24 h hold, but the business may contest for 7 days. Once paid, there is no clawback (P-J9-9). For absent businesses this favours the worker by design. Proposal: align the hold with the window for *auto*-accepted work (finance decision under P-J9-1).
3. **Strict rate limits on J9 business money routes.** They use the default class (80/min, then a 15-minute account block, as in D42). A large employer validating many milestones at once could be blocked. A batch-accept endpoint (D42 pattern) is the follow-up.
4. **Evidence is weak.** It is text and references only (`photo_ref` / `document_ref`, no file storage). Strong completion proof for gigs still depends on counterparts (attendance codes) and ops judgement.
5. **Unknown-age workers** self-attest for non-hazardous work. Verified dates of birth exist only from KYC tier 2.
6. **Policy needs counsel:** the employment threshold (P-J9-2) and the minors policy (P-J9-7).
7. **Worker payouts land in the Jokko wallet only.** Off-platform withdrawal uses the existing J4 cash-out rails. No J9-specific mobile-money payout.
8. **The ops console uses browser prompts** for rulings. It works and is escaped, but it is not a polished case tool.
9. **Discovery is newest-first with no ranking.** A fairness review is needed at scale. OpportunityOS stays dormant.
10. **Measured locally only:** 60 concurrent lifecycles, p95 ≈ 1.7 s on one local node. No production capacity claim.

## 7. Proposed decisions
P-J9-1 … P-J9-10 are in `docs/JOKKO-DECISIONS.md`:
- J9 money off and finance hold periods;
- the employment threshold (counsel);
- cooperative reclassification;
- affiliate commission;
- platform fee 0;
- legacy reputation wording;
- minors (counsel);
- rep eligibility;
- no clawback;
- F1 shipped as its own patch after the P0.

## 8. J10 recommendation
**J10 = activation and operations readiness, before any new vertical (J11 collective capital).** J2–J9 built a large surface that is verified locally but **inert or unpatched in production**. The highest-value, lowest-risk next phase is to make what exists safely live:

1. **Close the P0.** Deploy the emergency patch on `7d262de` and verify it in production; record the evidence.
2. **Read-only production inspections** (authorized access only): D32 (J7), D43 (legacy delivery), and an F1 exposure query (cooperative payouts that paid more than their logs).
3. **Small, separate remediation deploys:** the F1 cooperative payout fix, and the F4 affiliate decision.
4. **Finance activation pack:** J8 pricing and holds (D35), J9 holds and window (P-J9-1), rule budgets. Each switch is flipped individually, with reconciliation dashboards and the morning checklist (`K21-QUALITY-CONTROL`).
5. **Operations:**
   - schedule `cron/logistics` and `cron/work`;
   - Sentry / UptimeRobot on the new routes;
   - an ops runbook for work disputes and settlements;
   - a batch-accept endpoint (risk 3).
6. **A controlled internal pilot:** one distributor, a handful of merchants, couriers and workers, with real but capped money, before any public exposure.

J11 (collective capital) should start only when J10 shows that money, custody and work run cleanly in production.
