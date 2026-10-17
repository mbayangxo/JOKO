# J14 follow-ups F1–F4 (report)

**Status:** local engineering only. **Nothing deployed.** No production money route was modified; every addition is off by default. Kebu Supabase was never accessed. The production P0-A / P0-B / F1 track stays separate (P0-A runtime verification still INCOMPLETE while Vercel returns 403).

**Baseline preserved:** J14 accepted at the fully clean gate `40b95b9`. Its code is unchanged; every change below is a follow-up commit on top.

## 1. Tested commits and gate

| Follow-up | Commit | Targeted tests | Notes |
|---|---|---|---|
| F4 partner keys: strict creator / approver separation | `8c69b10` | 4 (+ S6, J3 roles 31/31) | mutation-checked |
| F3 partner audit retention | `752cf44` | 6 (+ J14, sweeps, J3 matrix 86/86) | — |
| F2 chat orders: 30-min reservation, safe expiry | `31c8761` | 7 (+ S5, J4, J5, J7, sweeps, J3 matrix 133/133) | mutation-checked × 2 |
| F1 S4 partner debit instructions | `d99a1d1` | 12 | mutation-checked × 3. The combined serial regression had 1 sweep finding (missing sweep entry for the new critical route), fixed in the same commit; sweeps then 5/5 |

**Fresh full gate at `d99a1d1`: CLEAN.**
- 935/935 tests.
- 0 on every check: setup, suite, money / logistics / work / collective invariants after the suite and after everything, load, sweeps, web build, E2E J8–J14, weak-network lab, migration rehearsal.
- `schema_diff empty`, `audit_critical 0`, `deploy_inert yes` (crons unchanged), client matches schema at start and end.

## 2. What each decision became

**F1, S4 partner debits** (`PARTNER_DEBIT_INSTRUCTIONS_ENABLED`, off). A partner can only *request* a payout or a payroll batch for a linked business. Nothing moves until an in-Jokko approver with `business.pay` approves that instruction.
- **Fresh step-up** on every approval.
- **Immutable details:**
  - recipients are bound to account ids at request time;
  - a canonical `detailsHash` must be echoed by the approver;
  - a DB trigger refuses edits, deletes and any state change after a decision;
  - a re-post with different details → 409.
- **15-minute expiry.**
- **Recipient binding:** a handle re-assigned within 30 days, frozen or unknown recipients and non-employees are refused at request; frozen recipients are re-checked at approval.
- **Payroll batches** show every recipient; any roster change invalidates the instruction, all-or-nothing.
- **Risk:** the approver may not be a recipient; per-line, per-instruction and daily limits per business (proposed defaults, configurable); link and business still active; insufficient funds → `failed` with nothing moved.
- **Exactly-once:** row lock, one money transaction, references `pdi-<id>-<i>`, same-approver replay returns the same result; 5 concurrent approvals by 2 approvers → one execution.

**F2, chat orders** (`MBOLO_ORDER_EXPIRY_ENABLED`, off).
- Stock is reserved for 30 minutes. That is a hard payment deadline, checked under the order lock; charges never outlive it and a re-share can't extend it.
- The expiry pass takes the order lock and then the charge locks, the same order as payment, so pay and expiry serialize.
  - A pay request still in flight → deferred (unknown outcome).
  - A paid charge on an unconfirmed order → reconciliation exception, not released.
  - Otherwise: charges expired, stock restored once, order cancelled. Idempotent.
- An 8-round pay-versus-expiry race always ends paid-and-kept XOR expired-and-whole.

**F3, partner audit retention** (`PARTNER_AUDIT_RETENTION_ENABLED`, off).
- Security and authorization audit (`PartnerAuditLog`) is kept **≥ 12 months**. The setting can only lengthen it. `PARTNER_AUDIT_LEGAL_HOLD` suspends every purge.
- Webhook delivery logs stay at 30 days. Financial records are untouched.
- Refused attempts by an identified key (revoked / expired / out of scope / wrong environment) are now audit rows.
- `redactSecrets()` strips keys, webhook secrets, bearer tokens and raw hex keys from operator free text before storage.

**F4, partner keys.**
- `integration_ops` (issuer) and `risk` (approver) can never be combined, and `sysadmin` holds neither.
- The approver is re-checked at approval time: no issuing authority, must hold `partner_keys.approve`.
- Issue / rotate / activate / revoke are audited with creator and approver, never the key or its hash.

## 3. Findings

| # | Finding | Fix |
|---|---|---|
| FU1 | The S6 audit trail recorded only successful mutating calls; refused attempts by known keys were invisible | F3: denials of identified keys are security audit rows |
| FU2 | Operator free text (revoke / replay / issue reasons) could carry a pasted secret into the audit store | F3: `redactSecrets()` before storage |
| FU3 | Nothing stopped one operator from holding both key-issuing and key-approving roles | F4: role SoD plus an approval-time re-check |
| FU4 | Card orders held stock until someone cancelled | F2: 30-min reservation and safe expiry |
| FU5 | First draft of the S4 recipient check reused the legacy-client policy, which fails closed after the 2027-01-11 sunset and would then have refused every partner payout | Replaced before any test run with a direct `HandleRelease` stability check |
| FU6 | The new critical approval route lacked a sweep source and body (authz boundary sweep flagged it) | Sweep source (falls back to a foreign business with a placeholder id) and valid bodies |

## 4. Open items for decision

1. **S4 limit defaults:** 500 000 ₭ per line, 5 000 000 ₭ per instruction, 10 000 000 ₭ and 20 executions per business per 24 h.
2. **S4 UI:** the approval API exists (list, detail with every recipient, approve, reject). The in-app approval screen is not built yet.
3. **Partner rate limits** are per process (in memory). Before partner activation, decide whether they must be shared (see the J15 plan).

## 5. Next

The J15 financial torture-lab plan: `docs/JOKKO-J15-TORTURE-LAB-PLAN.md`.
