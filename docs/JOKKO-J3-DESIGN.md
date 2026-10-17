# Jokko J3: Identity, Trust & Permissions (design as built)

**Objective.** Know who is acting, what identity, organization or device they represent, what they may do, how much trust is established, and when more verification is needed.

**Scope.** Local only:
- nothing was deployed;
- production is untouched;
- branch deployments stay disabled.

The decisions this builds on are in [`JOKKO-DECISIONS.md`](JOKKO-DECISIONS.md). The full per-route matrix is in [`JOKKO-J3-PERMISSION-MATRIX.md`](JOKKO-J3-PERMISSION-MATRIX.md), generated from code.

---

## 1. Identity and role architecture

```
Person (User)  ──┬─ Account roles (AccountRole: personal, promoter, worker, seller,
                 │      business_owner, cooperative, driver*, agent*)   *operator-approved
                 ├─ Business authority (Business.ownerId = accountable owner;
                 │      BusinessMember: invited → active → removed, role-levelled)
                 ├─ Agent profile (AgentProfile: pending → active ⇄ suspended | rejected/revoked)
                 ├─ Courier profile (DriverProfile + driver role: pending → active ⇄ suspended | revoked)
                 ├─ Verification (effective tier 0–3, from proven facts only)
                 └─ Devices (UserDevice) → Sessions (AuthSession: trusted | new | recovery)
                                              └─ step-up (PIN) bound to the session

Operator (AdminUser, separate principal) ── AdminRoleGrant: support | risk | compliance |
        finance_ops | finance_approver | sysadmin   (no role = no permission)
        └─ AdminSession (password + TOTP)

System identities: cron (CRON_SECRET), provider webhooks (signature + one-time receipt),
        partners (per-partner API key), break-glass script (offline, actorType break_glass)
```

The identities in the brief, and how each is represented:

| Identity | Representation | Becomes active by |
|---|---|---|
| Personal user | `User` + `personal` role | OTP signup |
| Merchant / business owner | `Business.ownerId` + `business_owner` role | creating a business (Tier 3) |
| Business employee | `BusinessMember` with role, `status='active'` | invitation **accepted** by the invitee |
| Agent | `AgentProfile` + `agent` role | application → compliance approval |
| Courier | `DriverProfile` + `driver` role | application → compliance approval |
| Gig worker | `WorkerProfile` (mode container) | self-service; **grants nothing** by itself |
| Seller / promoter | self-service roles | no money privilege attached |
| Support / risk / compliance / finance / sysadmin | `AdminUser` + `AdminRoleGrant` | maker-checker grant by two sysadmins, or the break-glass script |
| System | cron secret, webhook signature, partner key | configuration |

**Rules:**
- Roles never collapse into each other. A person who is a customer, a courier and an employee holds three independent grants, each checked on its own.
- No endpoint grants a role as a side effect of performing an action.
- Removed in J3:
  - `POST roles/:role` let anyone self-grant `driver`;
  - `drivers/profile` activated couriers;
  - a float top-up activated pending agents;
  - payroll employment created a business membership whose role came from the free-text job title.

## 2. Permission matrix

The matrix is in `lib/authz/route-policy.js`. Every route (388) has exactly one policy, and `tests/j3/authz-matrix.test.js` fails otherwise. `lib/authz/enforce.js` runs it centrally before every handler. A route with no policy gets 403 `policy_missing`.

Each policy records:
- the actor;
- the permission;
- the resource relationship (object-level, enforced in the service);
- an active application role, if one is required;
- the minimum KYC tier;
- step-up;
- the risk class (`cash_out`, `sensitive_change`);
- where the action is audited.

**Object-level authorization** stays in the services, as an explicit relationship check: owner-of, member-of, party, assigned rider, and so on. Two sweeps prove it:
- `tests/sweep/data-exposure.test.js`: every GET with someone else's ids;
- `tests/sweep/j3-mutation-sweep.test.js`: every mutating id-route with someone else's objects.

## 3. Authentication and recovery

**Channels:**

| Channel | Role |
|---|---|
| Phone OTP | Primary login |
| Email OTP | Alternative |
| Password | Optional, email accounts |
| PIN | Local / transaction factor, never a login |
| Biometric | Client-side unlock of the PIN, toggled as a sensitive change |

**Passkeys.** Not built in J3. The session/device model is where they would attach, as a device-bound credential raising session trust (J4).

**OTP:**
- 6 digits, 10-minute lifetime, single use, compared in constant time.
- A code is burned after 5 wrong guesses.
- Issuance is limited to 5 per hour per identity, plus per-IP and per-identity route limits.
- **New:** a persistent 24-hour throttle (`AuthThrottle`). After 15 failures, the identity is blocked even with the correct code. Re-issuing codes no longer resets the guessing budget.

**PIN:**
- **What it is.** Six digits, bcrypt-hashed, locked after 5 wrong attempts.
- **What it is used for.** The PIN is the transaction factor, always combined with a trusted device session. It never authenticates a remote session on its own.
- **Lock loop closed.** Clearing a PIN lock is a recovery: by OTP login or by CNI number, the PIN is reset and the recovery cool-off opens. Previously, "5 PIN guesses → OTP login → 5 more" allowed unlimited PIN guessing to anyone holding the SIM. The CNI number is printed on the card, so it is knowledge, not a secret, and its attempts are throttled too.

**Recovery (`POST auth/recover` → `auth/verify intent=recover`):**
- The code goes only to the account's own phone and, if verified, its own email.
- The response is identical whether or not the account exists.
- Recovery:
  - revokes **every** other session (`revokeAllSessions`);
  - resets the PIN;
  - creates a `recovery` session that never becomes trusted;
  - opens a 24-hour cool-off.
- During the cool-off:
  - every cash-out path is refused (423 `cash_out_hold`, reason `recent_recovery`);
  - P2P sends are held for review;
  - phone, email, password and biometric changes are refused.

**Credential and contact changes** are sensitive changes. Each needs:
- a trusted session (not new, not recovery);
- no recovery cool-off;
- step-up (PIN in this session), or a fresh OTP login under 10 minutes old when the account has no PIN.

Every change is audited, and every one opens a 24-hour **contact-change cool-off** on cash-out. Specifically:
- **Email** can no longer be attached by `PATCH me`, which used to set `emailVerifiedAt` with no proof. That allowed a stolen session to bind the attacker's inbox, then recover or log in through it. The new flow is `POST me/email` followed by a code to the new inbox, `POST me/email/confirm`.
- **Phone** changes need a code sent to the new number. The old flow also accepted the change from any session.
- **Password** set through email OTP is audited and opens the cool-off.

## 4. Device and session model

`AuthSession` (one per login, per device):

| Field | Meaning |
|---|---|
| `deviceId` | Bound device |
| `authMethod` | `otp_phone`, `otp_email`, `password`, `recovery`, `legacy_refresh` |
| `trust` | `trusted`: the device was already verified for this account. `new`: unknown device. `recovery`. |
| `stepUpAt` | PIN step-up **in this session only** |
| `createdAt`, `lastUsedAt`, `expiresAt` | Absolute lifetime (`SESSION_MAX_DAYS`, default 60) |
| `revokedAt`, `revokeReason` | Revocation |

**Token behaviour:**
- Access tokens carry `sid`. Revoking the session kills the access token **immediately**, not at expiry.
- Refresh tokens are bound to the session.
- Rotation is single-use under concurrency and never extends past the session's absolute expiry.
- A rotated token replayed after the 60-second grace revokes the session. That kills both the thief's and the victim's tokens, and is audited.
- A pre-J3 refresh token is bound to a new, untrusted session on first use.
- In production, an access token with no session is never trusted.

**Users can:**
- list their sessions (`GET auth/sessions`) and devices (`GET auth/devices`);
- revoke one (`POST auth/sessions/:id/revoke`, `POST auth/devices/:id/revoke`);
- revoke all (`POST auth/logout-all`).

Responses carry no token material, and device ids are truncated. Revoking a device also removes its trust.

**Device trust and step-up:**
- **New device.** A device becomes trusted when it is verified by OTP. Cash-out still waits `NEW_DEVICE_CASH_OUT_COOL_OFF_HOURS` (default 24) after it is first seen. That stops a SIM swapper from verifying the new phone and cashing out at once.
- **Step-up requirements:**
  - outbound money at or above 50 000 XOF;
  - **any** amount from an untrusted session;
  - cash-out always;
  - sensitive changes always.

## 5. KYC and verification tiers

| Tier | Meaning | Evidence | Capabilities and limits | Agent / merchant eligibility |
|---|---|---|---|---|
| 0 | Account, no verified phone (email-only) | email OTP | receive only; balance ≤ 50 000 XOF / 5 000 ₭; no send, no cash-out | none |
| 1 | Phone proven | phone OTP | send ≤ 10 000 XOF/day; balance ≤ 50 000 XOF / 5 000 ₭; no cash-out | none |
| 2 | CNI verified | provider outcome (or compliance review) **and** `cniVerifiedAt` | cash-out ≤ 500 000 XOF/day; balance ≤ 2 000 000 XOF / 200 000 ₭ | agent / courier application |
| 3 | CNI + address verified | address verified by compliance | cash-out ≤ 2 000 000 XOF/day; create a business | merchant / business owner |

**Rules:**
- **Submitted is not verified.** `cni_pending` and `address_pending` never raise the effective tier. The tier number without its verification timestamp counts for nothing.
- **Unknown tiers fail closed** to Tier 0.
- **Re-verification and expiry:** not implemented. Recommended for J4: re-verify on CNI expiry, and on a phone change for Tier 2+.
- **Fail-closed provider.**
  - With no provider key in production, KYC is unavailable (503) and never "approved".
  - The sandbox auto-approval cannot run in production.
  - Provider outcomes arrive only by signed webhook:
    - Sumsub: HMAC over the body.
    - Smile ID: timestamp signature plus freshness.
  - Every webhook receipt is accepted **once** (`WebhookReceipt`).
  - A callback naming a different user than the job is refused and audited.
  - Production refuses to record a verification without its hashing secret.
- **Provider adapter boundary.** Provider calls and parsing live in `kyc-service.js`, keyed by `KYC_PROVIDER`. Authorization only reads the effective tier, so changing provider never touches authorization.

## 6. Business and merchant authority

**Owner and members:**
- `Business.ownerId` is the accountable owner, who holds every capability.
- Members (`BusinessMember`) are invited, accept, and can later be removed.
- **Never deleted.** A DB trigger refuses deletes, so records created by a removed employee stay attributable.

**Capabilities** (`BUSINESS_CAPABILITIES`):
- `read`
- `wallet.read`
- `treasury`
- `pay`
- `admin`
- `members.manage`
- `catalog.manage`

Only active members hold them. In J3, treasury data (wallet, ledger, credit summary), salaries, school rosters and cooperative logs moved from "any member" to the matching capability.

**Grants:**
- Only the owner may grant `owner`, `admin`, `cfo` or `ceo`.
- Nobody may grant a role above their own level.
- Removal follows the same rule; members may also leave.

**Immediate revocation:**
- Every authority check requires `status='active'`.
- Business money flows re-check authority **inside the money transaction**, with the membership row locked. A concurrent removal either commits first, so the payment is refused, or waits for the payment.
- Held transactions re-check authority when an operator later approves them.

All membership changes are audited (`IdentityAuditEvent`).

## 7. Agent and courier trust

| | Agent | Courier |
|---|---|---|
| Onboarding | `agent/apply` → `pending` | `drivers/profile` → `pending` (worker mode `delivery` grants nothing) |
| Verification | Tier 2 required for cash-out operations; compliance approves | compliance approves (`couriers.onboard`) |
| States | `pending → active ⇄ suspended`, `rejected`, `revoked` | `pending → active ⇄ suspended → revoked` |
| Suspend / revoke | risk or compliance (`agents.suspend`), immediate | risk or compliance (`couriers.suspend`), immediate |
| Enforcement | every `agent/*` working route needs the ACTIVE role, centrally | open jobs, accept, pickup and deliver need the ACTIVE role, centrally |
| Financial privileges | float only through finance, with dual authorization above the cap; a top-up never activates an agent; commissions are funded liabilities (D8) | escrow released only by the buyer's confirmation or the rule-based auto-release; a courier never rules on their own dispute |
| Limits | per-agent `maxDepositXof`, `maxWithdrawXof`, `floatLimit`; a velocity review signal | the fee is escrowed per job |
| Region | `arrondissement`, location | not modelled (J4 if needed) |

## 8. Operator separation of duties

**No god-mode.** An operator with no role is authorized for nothing. The shared `ADMIN_API_KEY` is retired and returns 401. The bootstrap operator is `sysadmin` only.

| Role | Can | Cannot |
|---|---|---|
| support | tickets, calls, masked user view, freeze (protective) | money, KYC, unfreeze, balances, full phone/email |
| risk | held transactions, fraud alerts, freeze, request/approve unfreeze, credential invalidation, suspend agents/couriers, sensitive user view, audit | move money |
| compliance | KYC review, agent/courier onboarding, approve unfreeze, distributors, audit | move money |
| finance_ops | money position, statements, refunds ≤ cap, low-risk adjustments ≤ cap, adjustment requests, agent float ≤ cap, rail release | approve its own requests, identity actions |
| finance_approver | approve adjustments, large refunds, large float top-ups | initiate them |
| sysadmin | operator roles (maker-checker), ops health, audit | any money or identity action |

**Rules:**
- **Role conflicts.** `sysadmin` cannot be combined with finance, risk or compliance.
- **Maker-checker** (`AdminApproval`, DB-guarded) covers:
  - operator role grants;
  - unfreeze;
  - refunds above `MONEY_REFUND_SINGLE_MAX_KORI`;
  - agent float above `AGENT_FLOAT_SINGLE_MAX_XOF`.
- **Money adjustments** (D10):
  - single operator only for ≤ `MONEY_ADJUSTMENT_SINGLE_MAX_KORI` between platform accounts;
  - dual authorization otherwise.
- **Who can approve.** Nobody approves their own request. Nobody grants or approves a role for themself. The database enforces both.
- **Every sensitive action** records reason, case reference, actor, timestamp, minimal before/after state and the permission checked:
  - `IdentityAuditEvent` and `AdminAuditLog`, both append-only by trigger;
  - denied permission checks are recorded too.

**Bootstrap and emergencies:**
- Existing production operators hold **no roles** after J3.
- The offline `scripts/admin-roles.mjs grant … --break-glass` assigns the first roles. It refuses non-local databases without an explicit flag and is audited as `break_glass`. Running it in production is a recorded decision (risk §17 of the gate report).

## 9. Risk engine foundation (`lib/risk/engine.js`)

Signals feed a per-action rule table. The result is one decision, `allow | step_up | hold | review | deny`, with explicit reasons, recorded append-only in `RiskDecision`.

**Signals:**
- new / unverified device;
- untrusted session;
- recent recovery;
- recent contact or credential change;
- credential reset pending;
- repeated wrong PIN or OTP;
- rapid cash-in → cash-out (≥ 80 % within 2 hours);
- hourly outbound velocity;
- burst of identity changes;
- agent velocity;
- tier eligibility.

**How decisions are used:**
- **Cash-out:**
  - `deny` → 403;
  - `hold` → 423 with reason codes;
  - `review` → routed to the existing held-transaction review queue;
  - then a mandatory step-up.
- **Sensitive changes:** `hold` or `review` → 423.

High-risk operator actions are handled by maker-checker rather than scoring.

**Fairness:** the engine reads only the account's own security and behaviour facts. It **never** reads:
- nationality or country;
- language;
- name;
- ethnicity;
- neighbourhood or arrondissement;
- date of birth;
- diaspora status.

A static test enforces this. One existing signal remains in the device-login flags (`lib/device-session.js`): login-IP country outside UEMOA for non-diaspora users. It is a location-of-login signal, not a person attribute, but it reads diaspora status, so it is listed for review in the gate report.

## 10. Privacy / PII matrix

| Data | Owner sees | Other users | Business / agent / courier | Support | Risk / compliance | Partner | Defence |
|---|---|---|---|---|---|---|---|
| Phone | full | masked (`•••• 1234`) in lookup; never on profiles | agent: masked; courier: none | masked | full | none | `recipientLookupShape`, `maskPhone`, sweep markers |
| Email | full | never | never | masked | full | never | DTOs, sweep |
| CNI number / hash, documents | never returned (hash only, images purged ≤ 24 h) | never | never | never | outcome only | never | scrubber `SECRET_KEYS`, purge job |
| Date of birth | own profile | never | never | never | full | never | DTOs, sweep marker |
| Balances | own | never | business: treasury roles only; agent: own float | **not shown** | shown | own settlement | DTO + sweep balance check |
| Transactions | own | counterparty sees own side | business: treasury roles | via transaction id only | full | own payments | ledger-scoped queries |
| Location | own | arrondissement label only | courier: exact dropoff only after accepting | none | none | none | delivery shape |
| Contacts / friends | own | relation only | — | — | — | — | — |
| Messages | members of the thread | strangers → message requests; blocks respected | — | none | report content only | partner support threads only | membership checks |
| Business data | members by capability | public card only | — | read | read | — | capability checks |
| Device / session data | own (truncated ids, no tokens) | never | never | never | via audit | never | `sessionShape`, `deviceShape` |
| Credential material (PIN/password hash, tokens, TOTP secret) | never | never | never | never | never | never | scrubber + DTOs + sweep |

Explicit DTO shaping is primary. The global scrubber (`lib/response-scrubber.js`) is defence-in-depth, and any strip it makes is logged and fails the sweep.
