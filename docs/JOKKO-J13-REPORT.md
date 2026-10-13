# J13: UX audit, financial-state clarity, recipient identity binding

**Scope:** local engineering only. **Nothing deployed.** J11, J12 and J13 are not activated in production. The J13 migration (`20261027000000_j13_handle_release`) is additive and **not deployed**. Production incidents are reported separately in §8 and were never bundled with J13.

**Final tested code commit: `86ee972`**: fresh-database J1–J13 gate fully clean (§7). Every later commit on this branch changes **documentation only** (`git diff --stat 86ee972 <report commit>` lists `docs/` files only).

---

## 1. Step 1: validating bb10ac2

| Check | Result |
|---|---|
| Toast unmount safety | `dispose` on unmount; no timer fires after unmount (`tests/j13/outcome-toast.test.js`) |
| Pending vs success | `outcomeToast()`: success text only for `state === 'done'`; Receive, BusinessWork (offer + budget) and CollectiveGroup use it. Browser: a lost Jëkkal reply shows "Vérification…", never "Merci" before confirmation; a 202-held donation is announced as pending |
| Jëkkal idempotency | `tests/j13/jekkal-idempotency.test.js`: 10 concurrent same-key requests → 1 contribution; replay; changed amount → 422; new attempt = new donation |
| Full gate at `8dc3adf` | **Not clean: 779/780.** The one failure was the J4 "P2P: find recipient" test, root-caused as **J13-F12** (§3). Every other step passed. |

## 2. Steps 2–4: audit findings and fixes

| ID | Finding | Fix |
|---|---|---|
| J13-F1 | Jëkkal list had no entry point | Added to the "Plus" menu |
| J13-F2 | Notification title dropped (body only) | Title shown |
| J13-F3 | `jekkal` notification kind unmapped | Mapped; "Voir" opens the campaign |
| J13-F4 | Scheduled payments orphaned while their cron runs | Added to the "Plus" menu |
| J13-F5 | Many notification kinds opened nothing useful | `src/lib/notification-route.js` routes parcels, orders, stock, support, trade invoices, scheduled payments, agent and business notices |
| J13-F6 | Money statuses conflated ("En cours" for different states) | Distinct labels (En attente / En cours de traitement / En vérification / Effectué / Échoué / Annulé et remboursé / Remboursé). Each state has its own **tone and glyph** (✓ ⏳ 🔎 ✕ ↩), never colour alone; failed and reversed amounts are struck through; an unknown status is never shown as completed |
| J13-F7 | Load failures shown as false empty states, e.g. a debt reading as "Aucune facture ouverte" | `LoadErrorState` with "Réessayer" on 14 screens: wallet history, notifications, tickets, trade invoices, Jëkkal, parcels, courier jobs, agents, alerts, trending, analytics, merchant QR list and others |
| J13-F8 | Balance that failed to refresh shown as current | Flagged on Home until it refreshes |
| J13-F10 | Infinite decorative animations on low-end Android | Stopped under system "reduce motion" or low-data mode |
| J13-F11 | Slow-network double tap could submit twice | Shared buttons ignore taps while their request is in flight. **Server idempotency remains the authoritative safeguard for money.** |
| J13-F12 | **Financial identity defect:** the lookup searched mixed queries such as "test12345678" as phone numbers after stripping the letters. This caused a ≈2.3 % gate flake and a wrong-recipient risk ("moussa771234567" → the owner of +221 77 123 45 67) | A query with letters is a handle (server and Friends screen). Recipient identity binding in §3 |
| J13-F13 | Notification routes to Marketplace-stack screens silently did nothing | Routed through `Main → MarketplaceTab`; a static test checks every destination is registered where it is addressed |
| J13-F14 | Wallet history showed "Aucune opération" while its own load was still failing | History has its own loading state |
| J13-F15 | Recipient lookup lost to a network dropout never recovered | Re-runs when requests get through again; "Réessayer" button; a refused lookup is never retried |
| J13-F16 | **Regression from J13-F8:** the stale-balance flag toggled above the action tiles on a lossy network, moving "Yónnee" mid-tap (J12 lab 10/11 in the `4f6eada` gate) | The flag takes the pill's slot on one line, so nothing moves |
| — | Accessibility | Screen-reader names on ~40 icon-only buttons and 106 text inputs; status rows announce title, amount and state |

**Not done (dependency):** Affiliate has no entry point, pending decision P-J9-4.

## 3. J13-F12 / J13-4: mandatory recipient identity binding

The policy, mechanism, compatibility window, enforcement conditions and rollback-safe plan are in **[`JOKKO-J13-RECIPIENT-BINDING.md`](JOKKO-J13-RECIPIENT-BINDING.md)**.

In short:
- Lookup issues an encrypted `recipientRef` bound to the recipient's **account id** and the identifier searched by.
- `money/p2p/confirm` exchanges it for a single-payment `instructionRef` that also binds the amount and the idempotency key.
- `transfers/send` re-verifies against the current state and refuses with 409 or 428 before any money moves.
- Older clients go through a temporary, verifiable path, or fail closed with 426 `update_required`. The path has a hard sunset on 2027-01-11 and can only be closed earlier.

Defect found and fixed during validation: the first draft (`7794d91`) only signed the tokens, so account ids were readable. Tokens are now AES-256-GCM, and the tests assert nothing in them is readable.

Notification routing never bypasses access control (`tests/j13/notification-access.test.js` plus a browser step):
- another account's parcel → 403, no leak, writes refused even with the **correct** pickup code;
- a deleted parcel → 404;
- private campaigns → 404;
- a closed campaign takes no money;
- notifications are per account;
- list routes forward no foreign id.

## 4. Tests added in J13

| File | Tests |
|---|---|
| `tests/j13/jekkal-idempotency.test.js`, `outcome-toast.test.js` | bb10ac2 validation |
| `tests/j13/notification-route.test.js` | Kind mapping and route registration |
| `tests/j13/notification-access.test.js` | Unauthorized, deleted, expired/closed and cross-account resources |
| `tests/j13/lookup-letters-are-handles.test.js` | The exact flaky shape; the wrong-recipient case; phone formats |
| `tests/j13/recipient-ref-unit.test.js` | Token unit tests (fixed clock) |
| `tests/j13/recipient-binding.test.js` | 13 end-to-end binding tests: renamed / reclaimed handles, changed phone, concurrent changes, stale screens, replays, legacy clients, enforcement, authorization |
| `tests/j4/money-ux.test.js` (+1) | Distinct tones and glyphs per money state |
| `tests/e2e/j13-ui.mjs` | 9 browser steps |

Changed assertions (each made stricter or more precise, never weaker):
- J12 lookup: a bare letter-bearing handle is now **found**; it used to assert 404;
- J4 cash-in label: the precise "En cours de traitement";
- J12 lab helper: waits for the resolved recipient, and still fails if the lookup never recovers.

## 5. Gate history

| Commit | Result |
|---|---|
| `8dc3adf` | Not clean: tests 779/780 (J13-F12); everything else passed |
| `4f6eada` | Not clean: tests 797/797, all E2E passed, **J12 lab 10/11** (J13-F15 / J13-F16); everything else passed |
| `a287efa` | Not clean: **tests 811/812**; everything else passed (E2E J8–J13 all pass, **J12 lab 11/11**, invariants, sweeps, rehearsal, empty schema diff, 0 critical, deploy-inert, no Postgres restart). Failure: `money-in-chat … not a member … rejected` expected 403, got 426. The J13-4 binding ran before the thread-membership authorization check. Fixed in `86ee972` (binding after the authorization refusals); test unchanged |
| `86ee972` | **CLEAN** (§7) |

Between gates (`a287efa` code):
- targeted regressions 71/71, twice;
- browser suites J8 12/12, J9 11/11, J10 7/7, J11 8/8, J12 9/9, J13 9/9 (J13 twice);
- J12 lab 11/11 on three consecutive full runs.

## 6. Remaining dependencies

- Physical low-end Android testing; external language and compliance approvals (carried from J12).
- Payroll `employeeHandle` and scheduled-payment *creation* to adopt the same recipient binding (tracked, same policy).
- Production rollout of J13-4 in phases, each needing separate authorization (binding doc §6).
- P-J9-4 (Affiliate entry point).
- J13-F17: **fixed in the separately tracked follow-up**, gate clean at `a6adf97`. See [`JOKKO-J13-F17-REPORT.md`](JOKKO-J13-F17-REPORT.md). This J13 milestone (`86ee972`) is unchanged.

## 7. Final gate (fresh database)

**CLEAN at `86ee972`.** Fresh database, `scripts/dev/gate.sh`, 2026-10-13.

| Check | Result |
|---|---|
| Unit / integration / HTTP / J3–J13 suites | **812/812** |
| Ledger invariants (after each suite and after all) | OK: money, logistics, work, collective |
| Load | 5/5 |
| Sweeps (authorization, horizontal) | 5/5 |
| Web export | OK |
| Browser E2E | J8 12/12 · J9 11/11 · J10 7/7 · J11 8/8 · J12 9/9 · **J13 9/9** |
| J12 weak-network lab (**simulated**: desktop Chromium + DevTools emulation) | **11/11**. Lossy 3G step: attempts 3, outcomes sent / not received / sent, **2 debits for 2 "sent"** (one reply lost after execution was resolved correctly) |
| Migration rehearsal | OK (`ok: true`) |
| Schema diff (migrations vs schema) | empty |
| Dependency audit | 0 critical (20 high / 8 moderate, unchanged since J12) |
| Deploy-inert | yes |
| Postgres | **no restart during the run** (up since 04:59:36 UTC) |

Recipient binding inside this gate (all pass):
- token unit tests 8/8;
- end-to-end 13/13, including every legacy-client case:
  - stable handle → allowed;
  - real rename + reclaim → 426;
  - direct chat → allowed; group thread → 426;
  - `RECIPIENT_BINDING_ENFORCE=true` and sunset → 426 for legacy, 201 for bound clients;
- the browser step: recipient changed after confirmation → refused, nobody paid.

### J13-F17 (open, found during the final review; not fixed in `86ee972`)

A payment the app reports as **"n’a pas été reçu"** (the intent lookup found nothing under that key at that moment) is a point-in-time answer:

- **Protected:**
  - a late-arriving original cannot execute twice: the same key is kept for 10 min, and with J13-4 the instruction expires after 10 min;
  - if it executes inside that window, **history shows it**, because history is read from the server ledger.
- **Not protected:**
  - the screen's wording ("aucun argent n’a été débité") is stated as final;
  - nothing re-checks or corrects that screen if the late original settles;
  - no test covers a late settlement after "not received".

Proposed fix, as its own commit and fresh gate:
- provisional wording until the window closes;
- a background re-check of the same key;
- a deterministic test (forced "not found", then the delayed original executes) asserting:
  - history shows it;
  - the same payment re-entered returns the original;
  - the message is corrected.

## 8. Production (separate track; nothing deployed)

- **P0-A:** runtime verification **INCOMPLETE**. Vercel returns 403 for this project's deployments, runtime logs and errors (scope `mbayangxos-projects`). The Vercel connection needs re-authorization.
- **P0-B and F1:** separate, open, undeployed emergency releases, each requiring its own authorization and verification. They are not combined with J11, J12 or J13.
- Kebu Supabase: untouched.
