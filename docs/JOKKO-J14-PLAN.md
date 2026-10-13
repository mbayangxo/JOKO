# J14: Ecosystem integration (plan)

**Status:** plan, local engineering only. **Nothing deployed.** Nothing in J14 activates a production money route, a production webhook endpoint, or any partner credential. Kebu Supabase is never touched. The production emergency track (P0-A verification, P0-B, F1) stays separate and is not bundled with J14.

**Baseline:**
- J13 milestone `86ee972`;
- J13-F17 follow-up `a6adf97` (gate clean, 845/845).

**Source of the scope:** `docs/JOKKO-ECONOMIC-OS-ARCHITECTURE.md` §3 (Kabu ↔ Jokko integration contract) and §15 (dormant register). "Kabu" is spelled "Kebu"/"KEBU" in existing code and the Partner API.

## 1. What already exists

| Contract item | State today |
|---|---|
| Business link (owner one-time code + partner key) | ACTIVE |
| Payment acceptance (checkout sessions, collect) → signed result webhook → Kabu updates its order | ACTIVE |
| Per-merchant settlement into the linked business wallet (J6.0) | ACTIVE; unmapped payments use the LEGACY platform wallet (D23) |
| Partner payouts | ACTIVE, from the legacy platform wallet only |
| `CommerceEvent` outbox, written in the same transaction as each state change | ACTIVE as an outbox; **no delivery to Kabu** |
| Kabu fulfilment requests → Jokko Logistics (J8) | DORMANT (contract only) |
| Per-merchant payouts and payroll instructions **from a business wallet** | DORMANT: needs merchant authority for debits |
| Product mapping, payouts by purpose, Mbolo order-from-conversation | DORMANT |

## 2. Rules applied to every slice

1. **Money:** only the J2 kernel writes balances, and every money action is atomic and idempotent. No partner can debit a Jokko wallet without an authority model the user approves (D-J14-1).
2. **Identity:**
   - objects cross systems by reference (`ExternalLink`), never by copy;
   - every partner call is scoped to its partner key and to an active link;
   - recipients are bound to immutable account ids (the J13-4 policy).
3. **Privacy:** outbound events carry ids and amounts only; never names, phones or addresses.
4. **Delivery honesty:** a partner-facing status is never shown as final before the Jokko side is final. The F17 rules apply: unknown ≠ failed ≠ completed.
5. **Activation:** everything new ships **off** behind a flag. Activation in production is a separate, authorized step.

## 3. Slices

| # | Slice | Moves money? | Can start | Acceptance |
|---|---|---|---|---|
| **S0** | Carry-forward: apply the approved J13-4 recipient-binding policy to **payroll** (`employeeHandle`) and **scheduled-payment creation** | Protects existing flows | **Yes** (policy already approved) | Renamed / reclaimed handle refused; bound to the account id; existing payroll and scheduled-run tests unchanged |
| **S1** | **Signed event delivery** from the `CommerceEvent` outbox to each linked partner's subscriptions | No | **Yes** | Per-partner subscriptions with signing secret and rotation; signature = HMAC over timestamp + event id + body; replay window; exponential retry; dead-letter; manual replay by an operator (maker/checker); per-business filtering through active `ExternalLink`s only; at-least-once delivery with stable event ids; nothing leaves for an unlinked or revoked business; no PII. Delivery never feeds back into money |
| **S2** | **Kabu fulfilment requests → Jokko Logistics** (partner API) | No (the delivery fee recipe exists in J8 but stays off) | **Yes**, flagged off | A partner creates a shipment for its linked business referencing the Kabu order id (by reference); status and proof events go back through S1; idempotent creation; cross-partner / cross-business refused; J8 invariants hold |
| **S3** | **Product mapping** (`ExternalLink objectType=product`) for B2B and Kabu catalogs | No | **Yes** | Link / unlink / list by the partner for its linked business only; no catalog copy; used by S2 and B2B reorder |
| **S4** | **Per-merchant payouts and payroll instructions from a business wallet** (Kabu → Jokko) | **Yes: debits a business wallet** | **No: needs D-J14-1** | Defined only after the decision. At least: J3 `business.pay` authority; recipient binding; maker/checker above a threshold; idempotent; held-for-review paths; F17 states |
| **S5** | **Mbolo order-from-conversation** adapter (seller charge card → `Order` / `PurchaseOrder`) | Uses the existing charge payment | After S1–S3 | No order without seller confirmation; payment by the existing charge flow only |
| **S6** | Partner hardening: key rotation, scopes per key, per-partner rate limits, sandbox parity tests, partner audit trail | No | **Yes** | Old key refused after rotation; a key without a scope is refused; sweeps cover every partner route |

**Proposed order:** S0 → S1 → S6 → S3 → S2 → S5. S4 waits for D-J14-1.

## 4. Decisions needed (none taken here)

| ID | Question | Why it matters |
|---|---|---|
| **D-J14-1** | How may Kabu instruct a debit from a Jokko **business** wallet (per-merchant payouts, payroll)? Options: (a) per-instruction approval inside Jokko by the business owner or CFO; (b) a standing, revocable mandate with per-period and per-recipient limits; (c) not in J14 | Material financial-policy decision: a partner-initiated debit of a merchant's money |
| D-J14-2 | Which event types may leave Jokko for partners, and with what retention? (Default proposal: order / payment / fulfilment events of the linked business only; 30-day delivery log) | Privacy and data-sharing contract |
| D-J14-3 | Should the legacy unmapped settlement path (D23) be closed for new partners once S1–S3 exist? | Reduces the legacy platform-wallet exposure |

## 5. Gates

Each slice ends with:
- targeted tests;
- sweeps: authz boundary, data exposure, mutation;
- a fresh-database gate, J1–J13 plus J14.

The J14 report records every finding, fix, test and dependency, and the final tested commit.
