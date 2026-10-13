# J13-F17 follow-up: uncertain payments stay provisional until the server confirms

**Scope:** separately tracked J13 follow-up; local only; **not deployed**.

**Original J13 milestone:** `86ee972` (accepted; unchanged by this work).

**Tested follow-up commit:** see §6.

## 1. The defect

A payment the app reported as "n’a pas été reçu" was based on a single intent lookup that found nothing under its key at that moment ("not_found"). Five problems followed from that:

- **Premature certainty.** Both the app and the server said "aucun argent n’a été débité. Tu peux réessayer" (`safeToRetry: true`) while the original request could still arrive and execute.
- **No follow-up.** Once that screen was shown, nothing checked again.
- **Silent drop after 24 h.** Unresolved records were dropped from the device after 24 hours without reaching a final answer.
- **Held shown as sent.** A payment answered "held for review" (202) landed on success screens titled "Envoyé !" (P2P) and "Payé !" (merchant). A toast mentioned the hold, but the headline claimed success.
- **Unknown shown as failed.** A shared fallback (`outcomeToast`) worded any non-final state as a refusal: "aucun argent n’a été débité".

## 2. Payment states (never confused)

| State | Basis | Wording (French reference) |
|---|---|---|
| **Unknown** | Reply lost; in progress; or "nothing received **yet**" | "Nous vérifions le statut de ce paiement. Ne le renouvelle pas pour le moment." Never says whether money moved |
| **Under review** | 202 hold / provider pending | "En vérification", never "Envoyé !" / "Payé !"; no undo or receipt sharing |
| **Completed** | Server completed (or a lost reply proven by the ledger) | "Paiement effectué." |
| **Confirmed failure** | Server refused, or the attempt was **closed** (§3) | "Opération refusée — aucun argent n’a été débité." / "Le paiement n’a pas été reçu : il a été annulé et aucun argent n’a été débité. Tu peux recommencer." |
| **Reversed** | Ledger reversal / refund | History shows "Annulé et remboursé" / "Remboursé" (J13-F6) |

The wording follows the app's existing convention ("Ne le renouvelle pas"). The J4 safety rule forbids any form of "réessayer" on an unknown outcome, so the requested example "Ne réessayez pas pour le moment" became "Ne le renouvelle pas pour le moment", with the same meaning.

## 3. Mechanism

**Server**
- **`POST money/intents/:key/void`** closes the caller's own key, and only if nothing ran under it. After that, any request carrying the key is refused (409 `intent_voided`), so "not received" becomes a fact rather than a guess.
- **Atomicity:** the close and a racing original both insert, then check; whichever commits second sees the other. They never both proceed, and a key that ran is never closed.
- **Lookup states:** `GET money/intents/:key` adds `voided`. `not_found` now carries provisional wording and `safeToRetry: false`.

**Client**
- **The reconciler** (`src/lib/intent-reconciler.js`, one shared instance) only looks up, and closes keys under the rules below. It has no submit path:
  - it never re-sends a payment, never creates a key or instruction for it, and only looks up the signed-in user's records;
  - it closes an overdue key: wall-clock age ≥ 90 s, or ≥ 60 s of monotonic time since the first "not found" in this session. A clock moved in either direction can't keep it open forever, and closing early is always safe.
- **When it runs:**
  - app start and resume (app active / tab visible);
  - every wallet history refresh;
  - every 15 s while the app is in the foreground and something is unknown.

  Background execution on mobile is never assumed.
- **On settlement:** the attempt's banner is replaced by the authoritative state, the balance is refreshed from the server, and the history reloads.
- **Records:** unresolved records are kept until a final answer, with a 7-day hard bound. They are no longer silently dropped at 24 h.

## 4. Tests

| File | Covers |
|---|---|
| `tests/j13/f17-reconciler-unit.test.js` (12, deterministic: fake API, storage and clocks) | Young "not found" stays unknown; overdue by wall clock or by monotonic time → closed once; clock moved −12 h / +48 h; lost reply (never closed); a close racing a late original; risk-review hold; confirmed refusal; unreachable server (never closed); account switching; repeated restarts (new instances, closed exactly once); eventual settlement (one event); lookup and close are the only server operations |
| `tests/j13/f17-reconciliation.test.js` (8, real HTTP, invariants after each) | Provisional `not_found` then delayed settlement shown in history and balance; close → delayed original refused, nothing moves; lost reply never closed and replays the original; refusal kept; 202 hold never closed; **20 concurrent original-vs-close races**: never both, money moved exactly once per execution; per-account isolation (another user's identical key unaffected, nothing leaked, no existence oracle); invalid / unauthenticated |
| `tests/e2e/j13-ui.mjs` (+3 browser steps) | Lost reply: provisional, never "aucun argent" / "pas été reçu" / "Envoyé !" / "Paiement effectué" early; settles after lookups return; paid once; history "✓ Effectué". Never arrived: provisional ≥ 20 s, then closed and final; the captured delayed original (same key, body and PIN token) is refused; no money. 202 hold: "En vérification", never "Envoyé !", never closed |
| `tests/e2e/j12-ui.mjs` | Airplane mode now requires provisional wording first and **no** early "pas été reçu"; account switch: the other user's pending attempt is never looked up |

Assertions changed, each to the stricter rule:
- `tests/j4/money-ux.test.js` and `tests/j4/journeys-pay.test.js`: `not_found` is no longer "safe to retry"; only a closed key is.
- `tests/j12/money-safety-i18n.test.js`: unknown wording must not state an outcome; a legacy `safe_to_retry` reads as unknown.
- The browser suites' wording checks were updated to the new provisional text.

Authorization sweep: `POST money/intents/:id/void` is classified "self-scoped by construction" (it closes only the caller's namespace), next to `DELETE friends/:id`. Foreign keys are probed, and the isolation test proves no cross-account effect.

## 5. Preserved

- J13-4 recipient binding: instruction keys are untouched by reconciliation.
- Idempotency: same key = original, changed body = 422; PIN challenges still release the key (J12-F7).
- J1–J13 ledger invariants.
- Offline guarantees: money is never queued.

## 6. Gate

_Pending: complete fresh-database gate on the follow-up commit._

## 7. Production

Not deployed. The P0-A, P0-B and F1 emergency track stays separate; Kebu Supabase is untouched.
