# J13-4: Mandatory recipient identity binding (P2P)

**Status: target policy approved 2026-10-13. Implemented LOCALLY only. Not deployed. No production money route is changed by this document.**

## 1. Problem (J13-F12)

A P2P payment named its recipient by **handle**. Handles are labels: `POST auth/complete-profile` can rename an account at any time, and a released handle can be taken by someone else. Phone numbers can also move between people.

So the person the sender confirmed on screen and the account that holds that label when the payment executes could differ. The original lookup bug made this worse: the server searched a mixed query such as "moussa771234567" as a phone number after stripping its letters, so it could match another person's number.

## 2. Policy

1. A payment is bound to the recipient's **immutable account id**. Usernames, phone numbers and display names are never used as the payment identifier.
2. New payment clients submit a server-issued `instructionRef` (see §3).
3. The server rejects a changed, expired, mismatched, forged or cross-account binding with **409**. A binding that is required but missing is rejected with **428**. Both happen before any money moves.
4. Older clients (no `instructionRef`) get a **temporary** compatibility path (§5). It is open only while the server can independently verify the exact intended recipient; otherwise the request **fails closed with 426 `update_required`**. There is no permanent exemption.

## 3. Mechanism

| Step | Endpoint | Issues / checks |
|---|---|---|
| Find | `GET users/lookup` (explicit `mode=handle\|phone`; a query with letters is never a phone, J13-F12) | `recipientRef` (`rr2`): sender id, recipient **account id**, the identifier searched by (handle or phone, **hashed**), expiry 15 min |
| Confirm ("Oui — Envoyer") | `POST money/p2p/confirm` (moves no money; deliberately outside `transfers/` so the router idempotency layer never caches it under the payment's key) | Verifies the `recipientRef`: signature, expiry, same sender, the identifier **still** belongs to that account. Issues `instructionRef` (`ri2`), which adds the confirmed **amount** and the payment's **idempotency key**; expiry 10 min |
| Send | `POST transfers/send` with `instructionRef` | Re-verifies against the current state: signature, kind, expiry, sender, recipient account id = account resolved now, identifier still held, amount, idempotency key = this request's key |

- **Tokens** are encrypted and authenticated with AES-256-GCM under a dedicated subkey of the server secret, so they can never be confused with session JWTs. The token kind is bound as associated data, so a recipient token can't be presented as an instruction token. They are stateless (no storage), and **nothing in them is readable**: no account id, handle, phone or key. Any modified byte makes the token `forged`.
  - An earlier local draft (`7794d91`) only *signed* the payload, which left account ids readable in base64. The J13-4 test suite caught this before any gate, and it was replaced.
- **One confirmation, one payment.** The instruction is bound to the idempotency key. The same key is the normal idempotent replay, which returns the original payment. A new key is refused (`instruction_changed`).
- **Chat payments** use the same sequence (lookup by handle, then confirm, then send). The existing check that the recipient is a member of the thread still applies.

### Refusal codes (no money moved in any case)

| Code | HTTP | Meaning | Client behaviour |
|---|---|---|---|
| `recipient_changed` | 409 | Account behind the label changed (renamed / reclaimed handle, moved phone number) | Drop the recipient; the sender searches again |
| `expired` | 409 | Stale confirmation screen | Same: search and confirm again |
| `cross_account`, `forged` | 409 | Token from another session or not issued by this server | Refused |
| `instruction_changed` | 409 | Amount or payment key differs from the confirmation | Refused |
| `confirmation_required` | 428 | A recipient token was sent, but no confirmed instruction | Confirm first |
| `update_required` | 426 | Legacy request that cannot be verified, or enforcement is on | "Mets à jour l’application" |

## 4. Scope

**Bound in this change:**
- P2P `transfers/send`, from the send screen;
- chat money (`MbooloChatScreen`);
- voice commands, which open the send screen.

**Already immutable:**
- scheduled-payment *execution*, which pays the stored `recipientId`;
- merchant payments (business id);
- request payments (requester id);
- collective funds and tontines (member ids).

**Tracked follow-ups (same policy, not yet bound):**
- payroll `employeeHandle` (`lib/handlers.js` ~2891);
- scheduled-payment *creation* (`lib/scheduled-payment-service.js:211`, which resolves the handle once at creation);
- the remaining handle-based *invitation* flows (tontine, collective, coop, org, work, trade buyer, Jëkkal beneficiary). These move no money at invitation time, and their money later moves by account id after the invitee accepts.

## 5. Compatibility window and enforcement

| | |
|---|---|
| Window | From the release that ships this server change until **2027-01-11 00:00 UTC** (`COMPAT_SUNSET`, hard-coded) |
| Earlier closure | `RECIPIENT_BINDING_ENFORCE=true` closes the legacy path immediately. **No setting can extend the window**: extending it requires a reviewed code change. |
| After the window | Every request without an `instructionRef` → 426 `update_required` |

A legacy request is allowed during the window **only** if the server can verify the exact intended recipient:

- **(a) Chat:** a `direct` thread whose two members are exactly the sender and the recipient. Membership was established by account id before this request.
- **(b) Otherwise:** the handle has **not been released** by any account within the last **30 days** (`HandleRelease` log, written in the same transaction as every rename). If no one gave up this handle recently, its holder now is its holder at the time of the legacy client's lookup.

Anything else fails closed (426), including a released-and-reclaimed handle and a group thread. The assumption behind (b) is that a confirmation screen older than 30 days cannot still be open.

Each legacy decision writes a `SecureLog` row (`category recipient_binding`, title `legacy_allowed` / `legacy_refused`, with the basis or reason only: no id, handle or phone). This measures the compatibility share before enforcing.

## 6. Rollback-safe migration plan

| Phase | Action | Rollback |
|---|---|---|
| 0 | Deploy the server (compat mode) with additive migration `20261027000000_j13_handle_release` (one new table and index; nothing existing touched). Old clients keep working through §5. | Stop writing `HandleRelease`. The table is inert and can stay. |
| 1 | Ship clients that use lookup → confirm → send. | Clients need the phase-0 server. **Do not roll the server back below phase 0 once binding clients are live**: their confirm call would fail closed and they could not pay (safe, but an outage). Roll forward instead. |
| 2 | Watch the `legacy_allowed` / `legacy_refused` counts, and in-app update adoption. | None (observation only). |
| 3 | Set `RECIPIENT_BINDING_ENFORCE=true` once the legacy share is acceptable. | Unset the variable (back to compat, never beyond the sunset). |
| 4 | Sunset `2027-01-11`: enforcement becomes unconditional. | Requires a reviewed code change (deliberately). |

Each phase needs **separate production authorization**. None of this is deployed.

## 7. Tests

| File | Covers |
|---|---|
| `tests/j13/recipient-ref-unit.test.js` | Pure, fixed clock: forged / tampered / wrong-kind / malformed tokens, expiry, cross-account, renamed handle, reclaimed handle, changed phone after a phone lookup, changed amount, changed or missing key |
| `tests/j13/recipient-binding.test.js` | Real HTTP: happy path; renamed handle; reclaimed handle at confirm and at send; changed phone; stale screen (expired tokens minted at a fixed past instant); replay (same key = original, new key / amount / other sender refused); forged / cross-account; 8 concurrent payments racing a rename + reclaim (only the confirmed account is credited); legacy stable handle (allowed); legacy after a **real** rename + reclaim (426); legacy chat direct (allowed) vs group (426); `RECIPIENT_BINDING_ENFORCE=true` (legacy 426, bound 201); sunset check; 401 / PIN step-up / block unchanged |
| `tests/j13/lookup-letters-are-handles.test.js`, `tests/j12/lookup-handle.test.js` | Lookup interpretation: letters → handle; phone-shaped → phone; no silent switch |
| `tests/e2e/j13-ui.mjs` | Browser: recipient renamed and reclaimed after the confirmation screen → refused, nobody paid, the sender must search again |
