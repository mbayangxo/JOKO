# Jokko J3 gate report: Identity, Trust & Permissions (local)

Branch `claude/jokko-forensic-audit-rprqia`, on the accepted J2 head `a609a92`.

**Scope and limits.**
- Built and proven **locally only**; nothing was deployed.
- No production database, user, credential, operator or message row was read or changed.
- Branch deployments stay disabled.
- `db-migrate-deploy.mjs` stays inert (exit 3), and production migration history is not baselined (D2/D3).

**Verdict: the J3 gate is met locally.** No new P0 was found. Several identity and authorization vulnerabilities in existing features were found and closed (§11). The decisions still needed before production are in §17.

Gate items 1–10 are documented in [`JOKKO-J3-DESIGN.md`](JOKKO-J3-DESIGN.md) (sections in brackets) and the generated [`JOKKO-J3-PERMISSION-MATRIX.md`](JOKKO-J3-PERMISSION-MATRIX.md).

| # | Gate item | Where |
|---|---|---|
| 1 | Identity / role architecture | Design §1 |
| 2 | Complete permission matrix | Design §2; generated matrix (388 routes) |
| 3 | Authentication / recovery model | Design §3 |
| 4 | Device / session model | Design §4 |
| 5 | KYC tier model | Design §5 |
| 6 | Business / merchant authorization | Design §6 |
| 7 | Agent / courier trust | Design §7 |
| 8 | Operator separation of duties | Design §8 |
| 9 | Risk-engine foundation | Design §9 |
| 10 | Privacy / PII matrix | Design §10 |

The production / migration decisions (D1–D10) are recorded in [`JOKKO-DECISIONS.md`](JOKKO-DECISIONS.md).

---

## 11. Adversarial security results

`tests/j3/` runs real HTTP against `api/index.js` with `NODE_ENV=production`. Logins are real: a stored OTP, then `POST auth/verify`. Operators hold explicit role grants. J2 money invariants are checked after every scenario.

| Brief attack | Result | Test |
|---|---|---|
| Stolen refresh token | Replay after rotation revokes the session: thief and victim refresh **and** access tokens die. | sessions-recovery |
| Refresh replay (×5 concurrent) | Exactly one rotation. | sessions-recovery |
| Permanent access via refresh | Absolute session expiry; refresh and access refused after it. | sessions-recovery |
| OTP brute force | Code burned after 5 guesses; a rolling 24 h block after 15 failures survives re-issued codes; even the correct code then gets 429. | sessions-recovery |
| Recovery takeover (SIM swap) | Prior sessions revoked; PIN reset; recovery session never trusted; cash-out 423 (`recent_recovery`); email/phone change 423; P2P not executed. | sessions-recovery |
| PIN brute-force loop | An OTP login that clears a PIN lock is a recovery: PIN reset, cool-off opened. | sessions-recovery |
| Session after password/PIN reset | Pre-existing credential-remediation tests still pass; logout-all and recovery revoke all sessions. | http/credential-remediation, sessions-recovery |
| New-device cash-out | Untrusted session gets 423; after OTP device verification, still 423 (`new_device`, < 24 h); P2P from an untrusted session needs step-up for any amount. | sessions-recovery |
| Step-up replay across devices | A PIN step-up token from phone A is refused on phone B. | sessions-recovery |
| Recovery then cash-out | Refused on every cash-out route (central guard). | sessions-recovery, http/merchant-agents |
| Contact change then cash-out | Phone change gives 423 `recent_contact_change`. | sessions-recovery |
| Attacker attaches own email | `PATCH me` email gives 400; the verified flow needs step-up plus a code to the new inbox. | sessions-recovery |
| User A → user B (sessions/devices) | 404 on revoking another user's session/device. | sessions-recovery |
| Merchant A → merchant B | Wallet, members and transfer all 403; no money moved. | authz-roles |
| Employee → other business | 403. | authz-roles |
| Employee → owner-only action | Admin cannot grant `cfo`/`owner` (`owner_only_role`); staff cannot invite; staff cannot read treasury. | authz-roles |
| Forged business membership | An invitation gives no authority until accepted; a third party cannot accept it (404). | authz-roles |
| Revoked employee, incl. concurrent removal vs payments | Removal immediate; no payment commits after `removedAt`; row kept; DB refuses delete. | authz-roles |
| Payroll as privilege escalation | `jobTitle: "cfo"` grants nothing. | authz-roles |
| Fake courier | `roles/driver` (and the old `?role=` bypass) gives 403; application stays `pending`; open jobs 403. | authz-roles, http/commerce-delivery |
| Courier → unrelated delivery / suspended courier | Pending cannot accept or read; suspended gets `driver_required` immediately; cannot self-reactivate. | authz-roles |
| Agent → unrelated customer / suspended agent | An agent reaches only sessions a customer opened for them; suspended gets `agent_required`; a finance top-up never reactivates. | authz-roles |
| Role escalation | `roles/agent` gives 403 `role_requires_onboarding`; worker mode grants no courier role. | http/merchant-agents, authz-roles |
| Support → wallet mutation | Refund, adjustment, KYC and unfreeze all 403; masked user view, no balance. | authz-roles |
| Finance operator → identity action | Freeze, credential invalidation and courier approval 403; risk cannot move money. | authz-roles |
| Ordinary admin → high-risk adjustment | Customer-facing adjustment stays `requested`; the requester cannot approve; a second operator posts. Low-risk single path proven, with the cap enforced. | authz-roles |
| Admin privilege escalation | No-role operator gets 403 everywhere; legacy key 401; cannot request own role; requester cannot approve; second sysadmin grants; DB refuses self-approval; SoD conflict 409; audit append-only. | authz-roles |
| Revoked role → previously authorized endpoint | 403 immediately after revocation. | authz-roles |
| Direct HTTP bypass of UI restrictions | Every admin route refuses a user token; agent/courier routes refuse plain users. | authz-roles, sweep |
| KYC no key | 503 `kyc_unavailable`; tier unchanged. | kyc-privacy, http/kyc-production |
| KYC sandbox in production | Unreachable (`kycSandboxAllowed()` false in production). | http/kyc-production |
| Forged / malformed KYC webhook | 401, nothing changes. | kyc-privacy |
| KYC webhook replay / misdirected callback | Processed once (`duplicate: true`); another user's callback is refused and audited. | kyc-privacy |
| Blocked user / message interactions | Message-request and block tests (J0/J1) still pass under J3. | http/message-requests |
| PII enumeration | Lookup and profile DTOs carry no email, DOB, full phone, balance or credentials. | kyc-privacy, sweep |

**Vulnerabilities found and closed in J3.** All existed in the pre-J3 code. None is a new P0, because each needs a session, a role or an account relationship first.

| Severity | Finding | Fix |
|---|---|---|
| P1 | `PATCH me` set any email **as verified**: a stolen session could bind the attacker's inbox and then recover or log in through it | rejected; a verified two-step flow, guarded and audited |
| P1 | Phone (the recovery channel) changeable from any session with only a code to the new number | sensitive-change guard plus audit plus 24 h cash-out cool-off |
| P1 | `POST roles/:role?role=driver` self-granted the courier role (accepting moves buyer escrow) | self-service roles only |
| P1 | PIN brute-force loop through OTP login (and the CNI number) clearing the lock | clearing a lock is a recovery (PIN reset plus cool-off); CNI throttled |
| P1 | Every operator and the shared `ADMIN_API_KEY` were god-mode | role grants, SoD, maker-checker, key retired |
| P1 | A finance float top-up silently activated a pending agent | top-up never activates |
| P1 | A business `admin` could grant `owner`/`cfo`; members were added without consent; no removal existed | hierarchy, owner-only grants, invite → accept, removal |
| P1 | Payroll employment created a membership whose role was the free-text job title | invited `staff` only |
| P2 | Staff/viewer members could read the business wallet and ledger, salaries, school rosters and cooperative logs | capability checks |
| P2 | Refresh tokens slid forever with no session or device binding; step-up was user-wide across devices | AuthSession, absolute expiry, session-bound step-up |
| P2 | KYC webhooks were not replay-protected; Smile's signature does not bind the body | one-time receipts plus user binding |
| P2 | Email-only accounts held Tier 1 money rights | Tier 0 (receive only) |
| P3 | Dead fail-open `requireAdmin` copies in `handlers.js` (unrouted) | deleted |
| bug | Free-event ticket → 0-amount posting (500); every Jekkal contribution crashed (500) | fixed (found by the mutation sweep) |

## 12. Horizontal authorization sweep

`npm run test:sweep` runs after the full suite on the populated database:
- **GET sweep (existing).** A multi-role attacker calls **every authenticated GET route** with other people's ids:
  - no PII markers, credentials, or other users' balances leak;
  - no unexpected 2xx;
  - the scrubber never has to act.
- **Mutation sweep (new, `tests/sweep/j3-mutation-sweep.test.js`).** The same kind of attacker, with an established step-up session, owning a business, ACTIVE as both courier and agent, and staff elsewhere, calls **every mutating route that takes an object id (87 routes, 172 calls)** on objects belonging to others:
  - **none accepted**, apart from a documented by-design list: paying a merchant, buying a ticket, following a channel, an active courier accepting an open job, self-scoped friend removal;
  - no 5xx;
  - J2 invariants hold.
- **Admin sweep.** Every admin route refuses a user token.
- **Result:** 3/3 in the fresh-DB gate.

## 13. Full test results (fresh DB `joko_j3_gate`, commit `48f7f40`)

| Step | Result |
|---|---|
| `test:db:setup` (schema + financial, money-kernel and **identity** guards) | exit 0 |
| `npm test` (unit, integration, security, http, money, **j3**) | **412 / 412 pass** |
| └ `tests/j3` (sessions-recovery 14, authz-roles 17, authz-matrix 10, kyc-privacy 6) | 47 / 47 |
| └ J2 torture 27, kernel guards 7 | pass |
| `npm run test:load` | 3 / 3 |
| `npm run test:sweep` (GET + mutation + admin) | 3 / 3 |
| `prisma migrate diff --from-migrations --to-schema-datamodel` | "No difference detected" |
| messaging migration dry run | exit 0 |
| `db-migrate-deploy.mjs` without activation | refused, exit 3 (as intended) |
| `expo export --platform web` | exit 0 |
| `tsc --noEmit` | the same 5 pre-existing errors (Deno-only `supabase/functions/cron-proxy`) |
| `npm audit --omit=dev` | 42 (29 high, 13 moderate, 0 critical): unchanged since J1; J3 adds no dependencies |

**Existing tests changed to J3 semantics.** None was weakened; each asserts the stricter behaviour:
- HTTP fixtures sign in with an established, device-bound session (`establishedSessionToken`). Tests about new devices, recovery and missing step-up build weaker sessions explicitly.
- The courier test now proves application → pending → refused → operator approval.
- `roles/agent` gives 403 with an explicit code; nothing is granted.
- Cash-out recovery hold gives 423 `cash_out_hold` with reason `recent_recovery`.
- CNI unlock resets the PIN.
- A float top-up keeps the agent pending.
- Unknown tiers fall back to Tier 0.
- Funded rewards are accounted for exactly.

## 14. J2 invariant results

- `money:check` after the full suite: **OK**, 451 entries / 951 postings / 324 accounts.
- `money:check` after load + sweeps: **OK**, 2 472 entries / 4 995 postings / 1 335 accounts.
- `assertInvariants` runs after every J3 adversarial scenario and inside the mutation sweep, with **0 violations**.

## 15. Fresh-database result

`joko_j3_gate` was dropped, recreated, and built only from `schema.prisma` plus the three SQL guard files. Results:
- every suite above passes;
- the reviewed migrations (J1 + J2 + J3) reproduce the schema exactly.

## 16. Production-shaped migration rehearsal

J3 changes the schema, so the rehearsal was run. `npm run money:rehearse`: **14 / 14 steps OK** on a database built from `0_baseline` (production shape, legacy tables included):
- refused without activation (exit 3), and refused before baselining;
- after baselining:
  - `migrate deploy` applied **`20261002000000_j1_financial_safety`, `20261003000000_j2_money_kernel`, `20261004000000_j3_identity`**;
  - zero drift afterwards;
  - money-kernel and identity guards applied;
- backfill dry run and execute; legacy totals equal the ledger; invariants clean before and after kernel flows;
- direct balance write refused;
- exposure pack ran.

**The J3 migration is additive only:**
- new tables: `AuthSession`, `AdminRoleGrant`, `AdminApproval`, `IdentityAuditEvent`, `RiskDecision`, `AuthThrottle`, `WebhookReceipt`;
- nullable columns on `AccountRole`, `RefreshToken`, `UserDevice`;
- `BusinessMember.status` defaulting to `'active'`, so existing members keep their current access;
- no drop, type change or data rewrite.

## 17. Unresolved risks and decisions

None of these is a new P0.

1. **Production remains BLOCKED** (D1). Real role, session and membership data are unmeasured.
2. **Operator bootstrap in production (decision).** Existing production operators will hold **no roles** after J3: fail closed, they authenticate but are authorized for nothing. Roles must be granted, either with `scripts/admin-roles.mjs … --break-glass` (a recorded decision, run by someone with database access) or by a second sysadmin in-app. Which operators get which roles is a business decision.
3. **Session cut-over.** Pre-J3 access tokens (no session) are untrusted in production, so step-up or a fresh login is needed for any outbound money. Pre-J3 refresh tokens become untrusted sessions on first use. Users on an already-verified phone simply sign in again. Expect a support spike on the first release.
4. **New-device cash-out cool-off (24 h) and the cash-out step-up are product-visible.** Defaults: `NEW_DEVICE_CASH_OUT_COOL_OFF_HOURS=24`, `SESSION_MAX_DAYS=60`. Confirm or tune.
5. **Tier 0 for email-only accounts (decision).** These accounts can no longer send until they verify a phone. Beta email-only users are affected.
6. **Single-operator ceilings (D10).** Adjustments 5 000 ₭ (platform accounts only), refunds 10 000 ₭, agent float 500 000 XOF. Confirm.
7. **KYC.**
   - Re-verification and expiry are not implemented.
   - Tier 3 address verification is manual (compliance).
   - The Smile ID signature still does not bind the body. Replay is blocked, but the body is trusted within the freshness window; a server-side job-status lookup is recommended once the provider contract is live.
   - The CNI hashing secret must be set in production, or verifications are refused (fail closed, by design).
8. **Fairness review.** The device-login flag "IP country outside UEMOA for non-diaspora users" (pre-J3) uses diaspora status. It is a security signal, not a person attribute, but should be reviewed or dropped. The J3 risk engine itself reads no such attribute (static test).
9. **Passkeys / device-bound keys:** not built (J4 candidate). Biometric stays a client-side PIN unlock.
10. **Courier service region and agent region** are not used in authorization (agent location is informational).
11. **Risk engine** is a foundation, not a fraud model. Thresholds are fixed constants without production calibration. There is no case-management UI beyond the existing held-transaction queue and `admin/identity-events`.
12. **Carried from J2:**
    - coverage-freeze policy (D5/D6 recorded; implement when reconciliation is live);
    - legacy XOF and legacy value tables (D7);
    - agent commission funding (D8);
    - partner payout resolver (D9);
    - the intermittent load-test send (did not recur: load 3/3);
    - `npm audit`.
13. **Product gaps, unchanged (not built in J3, per M):**
    - Commerce: PARTIAL
    - Rides: NOT IMPLEMENTED
    - Gigs: PARTIAL
    - Mobile: PARTIAL
    - Locale: PARTIAL

## 18. Exact commits (on `a609a92`)

| Commit | Summary |
|---|---|
| `f412efa` | J3: identity, sessions, permission matrix, separation of duties |
| `48f7f40` | J3: adversarial suites, mutation sweep, and fixes they found (gate commit) |
| `e3137d0` | J3 design and generated permission matrix |
| (this commit) | J3 gate report |

All are pushed to `origin/claude/jokko-forensic-audit-rprqia`. No PR has been opened, and deployments stay disabled.

## 19. Recommendation for J4

**J4 should be Production Readiness & Controlled Exposure, still without deploying until access and decisions exist.** In order:

1. **Read-only production verification (D1).** When legitimate access exists, measure:
   - operators;
   - roles;
   - business memberships;
   - email-only accounts (Tier 0 impact);
   - legacy refresh tokens;
   - J2 opening balances.

   Run `money:backfill` as a dry run and `money:check`, both read-only.
2. **Take the decisions in §17.2–§17.6.** Prepare the operator role plan and the user-facing communication (re-login, new-device cool-off).
3. **Rehearse on a restored production backup:**
   - migrate deploy (J1–J3);
   - backfill;
   - break-glass operator roles;
   - full gate plus sweeps.

   Only then consider a Preview deployment, re-enabled by an explicit decision.
4. **Operational tooling on the J3 foundation:**
   - an operator case view (risk decisions, identity events, approvals);
   - risk-threshold calibration;
   - session/device management in the app UI;
   - KYC re-verification and provider status lookup.
5. **Passkeys** as a device-bound factor raising session trust; PIN stays the transaction factor.
6. **Then the product phases** on the kernel and the permission matrix: commerce refunds, gigs, logistics. Each new route must arrive with its policy and sweep coverage, which the matrix test enforces.
