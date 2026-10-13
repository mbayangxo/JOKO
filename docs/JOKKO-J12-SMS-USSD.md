# J12 (P-J12-4): opt-in SMS receipts and status, and USSD feasibility

**Status:** research and dormant code only. No SMS receipt or status feature is switched on, no SMS can authorise or move money, and no USSD channel exists. Activating any of this requires the regulatory, operator and security reviews listed in §5.

## 1. What already exists in the code (inventory)

| Piece | Where | State |
|---|---|---|
| SMS provider adapter (Africa's Talking or Twilio; mock when no key) | `lib/sms-config.js`, `lib/sms-service.js` | Present. Live only if provider keys are set in the environment. Whether production has them is **unknown**: environment values are not readable from this session, by policy. |
| Outbound purposes | OTP, partner messages, and formatters for "received" and "deposit" messages | The receipt formatters exist but **no money flow calls them**: no receipts are sent today. |
| Inbound keyword webhook `POST /api/webhooks/sms/inbound` | `webhooksSmsInbound` → `handleInboundSms` | **Fail-closed.** It requires the webhook secret (in a non-production mock, nothing is required). It understands only `SOLDE`/`BALANCE` and `AIDE`/`HELP`, is rate-limited, and is logged. |
| Balance-by-SMS preference | `User.smsBalanceQueryEnabled` | Was **on by default**: J12-F12. |

### J12-F12 (privacy, not theft-capable)
**Problem:** the balance-by-SMS preference was `@default(true)`.
- Any registered phone number could text `SOLDE` and receive the wallet balance without ever opting in.
- Whoever holds the SIM (a SIM swap, or a borrowed or stolen phone) could read it.

**Fixed locally:**
- New accounts default to **off** (additive migration `20261026000000_j12_sms_balance_opt_in`, a default change only).
- Switching it on requires the **PIN** (step-up). Switching it off never does.
- Tests: `tests/j12/sms-optin.test.js`.

**Not done (decision needed):** existing accounts keep their current value. Switching existing users off is a production data change → **P-J12-6** below.

## 2. Opt-in SMS receipts and status: proposed design (dormant)

| Rule | Design |
|---|---|
| Opt-in | Per user, per category: receipts for money received, receipts for money sent, "pending/verification" status, and tontine due reminders. Off by default. Switching on needs the PIN; switching off is always free. |
| Content | **Never the balance by default.** Amount, counterparty display name (never their phone number), the K21 reference, and "this is not a request to pay". **No links** (anti-phishing). **No codes.** In the user's language only when reviewed text exists (P-J12-2), otherwise French. |
| Triggers | Only from committed ledger events (after commit, from the outbox), never from a client request. Deduplicated per reference, so a reference produces at most one SMS. |
| Failure | SMS is best-effort and never blocks or reverses a payment. The in-app status remains authoritative. |
| Cost | Per message (Africa's Talking Senegal pricing to be confirmed). Cap per user per day. Receipts above a threshold only, if cost requires. |
| Privacy | Logged without the full message body after N days. The SMS log is a data-protection record (CDP Senegal). |
| Fraud | Fake "K21 receipt" SMS are a known scam vector. Use a registered sender ID, a fixed format, and an in-app "verify a receipt by its reference" feature (the reference lookup already exists for support). |

## 3. What SMS must never do
- Authorise a payment, a withdrawal, a PIN change or a recovery. **SMS-in money commands are rejected:** only `SOLDE` and `AIDE` exist, and a test proves money commands move nothing.
- Carry an OTP alongside transaction details in the same message.
- Act as a second factor on its own for money. SIM-swap risk is high in the region.

## 4. USSD feasibility (no live USSD)
- **What it would need:** a short code from an aggregator or MNO (Orange, Free, Expresso); commercial agreements; a session-based menu; the PIN entered inside the USSD session; and one intent key per USSD session through the J2 kernel and router idempotency.
- **Pros:**
  - Works on every feature phone.
  - It is the regional standard for e-money.
- **Cons:**
  - PIN keyed in clear text through the MNO's network.
  - Session timeouts (about 180 s) on 2G.
  - MNO revenue share.
  - **BCEAO:** a USSD payment channel is part of the e-money licence perimeter (see `K21-REGULATORY-STRATEGY.md`).
- **Recommendation:** read-only USSD first (balance, last 5 transactions, verify a reference), and only after the licensing path is settled. Money over USSD only with the e-money licence and an MNO security review.

## 5. Reviews required before anything here is activated

| Review | Owner | Question |
|---|---|---|
| Regulatory (BCEAO) | Compliance | Is an SMS receipt or USSD menu a "payment instrument" channel under the current (closed-loop) status? |
| Operator | Partnerships | Sender ID registration, short code, pricing, delivery SLAs in Senegal |
| Security | Security | SIM-swap exposure, spoofed-receipt scams, content rules |
| Data protection (CDP) | Legal | Retention of SMS logs; consent wording; cross-border processing by the SMS provider |
| Product | Product | Which categories, thresholds and languages |

## 6. Decisions requested (none taken)
- **P-J12-6:** switch existing users' balance-by-SMS **off** (requires notice, because some users may rely on it), or keep it on for users who already have it until they confirm. Recommendation: notify users, then switch off any user who hasn't confirmed within 30 days.
- **P-J12-7:** approve the receipt design in §2 for a dormant implementation in J13 (flag off).
- **P-J12-8:** USSD read-only pilot, after the licensing decision.
