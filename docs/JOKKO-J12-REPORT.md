# J12: Offline, low-bandwidth, Senegal-first (local only)

**Status:** first slice built locally. Nothing has been deployed, and no production schema, data or flag has changed. J12 adds **no** schema change, migration, cron or server money path. The changes are client-side safety rules, one UI banner, tests and this document.

Rules applied throughout (from the J12 brief):
- An offline payment is never displayed as completed before authoritative server confirmation.
- No spendable local balances.
- Expired or materially changed financial instructions are never auto-replayed.
- Test coverage: airplane mode, weak network, duplicate retries, clock changes, stale permissions, account switching, lost responses.

---

## 1. Inventory: what already existed (J4–J11)

| Area | Existing foundation | Assessment |
|---|---|---|
| Money writes | One `Idempotency-Key` per user action. The server fingerprints the body and returns 422 on reuse with a different body. Keys are scoped by user and route. A 5xx after commit is recorded as `completed_response_lost` (`lib/api-idempotency.js`). | Strong. It is the base everything else relies on. |
| Unknown outcome | `useMoneySubmit` keeps one key per attempt. A lost response leads to `outcome_unknown` and then polling of `GET /api/money/intents/:key`. A second payment is blocked while checking. | Good, but **in memory only**: an app kill or reload lost the key (see J12-F3). |
| Low-data mode | 45 s client GET cache, longer timeouts, `X-Low-Data` header. | **Unsafe partitioning** (J12-F1). |
| Mbolo offline queue | A local outbox for chat messages. | **Not scoped to the account** (J12-F2). |
| Languages | fr/en/wo cover the 173 i18n keys (wo is missing 5 signup keys). Eight other languages are best-effort, about 13 keys each. | Most money screens use **hard-coded French** (11 of 87 screens use the locale). See §5. |
| SMS | Africa's Talking or Twilio adapter (OTP, notifications). | No USSD. See §4. |

## 2. Findings

| ID | Finding | Severity | Status |
|---|---|---|---|
| **J12-F1** | The low-data GET cache was keyed by URL only. It was **never cleared** (`clearApiCache` had no caller) and it cached **every** GET without `skipCache`. On a shared phone, user B could get user A's cached response for up to 45 s after an account switch, for any personal GET without `skipCache` (business, payroll, orders, groups, messages…). | Privacy (device-local). Not theft-capable. | **Fixed locally.** Allowlist of public, non-money GETs only, partitioned by the token's user, and cleared on sign-in and sign-out. |
| **J12-F2** | The Mbolo offline outbox was not tied to the account that wrote each message. After an account switch, B opening the same thread (e.g. a group both belong to) would send **A's queued messages as B**. Stale messages were also sent with no age limit. | Impersonation on a shared device. Not money. | **Fixed locally.** Entries carry their owner. Only text and stickers can be queued. Stale (>24 h) or clock-ambiguous entries are held, never auto-sent. Ownerless legacy entries are never sent. |
| **J12-F3** | An unknown-outcome intent key lived in React memory. If the app was killed or reloaded during "vérification", the user lost the handle and could pay again by hand, because the first payment's status was invisible. | Double-payment risk from user retry. The server cannot prevent it, because a new tap carries a new key. | **Fixed locally.** The key alone is remembered (no amount, recipient or balance), per user, for lookup only. It is resumed on screen mount and never re-submitted. |
| **J12-F4** | Same-key retry had no time or instruction bound on the client. The server's body fingerprint already refuses a changed body, but an old "nothing received" key could be retried hours later with the same body. | Stale-instruction replay (no double-spend). | **Fixed locally.** Same-key retry requires the same user, an identical instruction fingerprint, ≤10 min and a sane clock. Anything else gets a new key and a fresh confirmation. |
| **J12-F5** | Mbolo message sends carry no stable client id, so a lost response followed by an outbox flush can post a message twice. | Cosmetic duplication, no money. | Open. Proposal: a per-entry client id and server dedupe (P-J12-3). |
| **J12-F6** | Money-safety status texts ("ne le renouvelle pas", "aucun argent n'a été débité") exist only in French. | Comprehension risk for Wolof-first users. | Open. Needs native-speaker-reviewed copy (P-J12-2). **Not machine-written.** |

## 3. What was built (local)

- **`src/lib/offline-policy.js`** (pure, unit-tested) holds the rules:
  - cache allowlist and per-user cache key;
  - outbox decision (`send` / `hold` / `drop` / `not_mine`);
  - instruction fingerprint;
  - same-key retry window;
  - pending-intent lookup TTL (24 h).
- **`src/lib/api-client.js`:** the low-data cache uses the allowlist and is partitioned by user.
- **`SessionContext`:** clears the cache on sign-in and sign-out.
- **`src/lib/mbolo-outbox.js`:** owner-scoped, text and stickers only, stale and clock-ambiguous entries held.
- **`src/lib/pending-intents.js`:** device-local list of `{key, userId, flow, createdAt}`, capped at 20 entries and pruned after 24 h.
- **`src/hooks/useMoneySubmit.js`:**
  - takes a `flow` and an `instruction`;
  - remembers unknown outcomes;
  - resumes lookups on mount (marked `resumed`);
  - after a restart, a "nothing received" answer requires a **new** intent;
  - rotates the key for changed or old instructions.
- **`src/components/MoneyPhaseBanner.js`:** shows only the server's verdict for attempts that went through a check. It never says "effectué" before `state === 'done'`.
  - Mounted on Send, Cash, Merchant pay and Request-pay screens.
- **Tests:**
  - `tests/j12/offline-policy.test.js` (5): account switch, clock moved backwards, stale entries, duplicate retry, changed amount or recipient, expired instruction, lost response and restart, lookup-only storage shape.
  - `tests/e2e/j12-ui.mjs` (Chromium, real API and DB):
    - **lost response:** the server executes, the reply and the auto-retry are cut → "vérification", never "Envoyé !", a second tap sends nothing;
    - **restart while unknown:** a reload resumes the **lookup**, never a re-send, and confirms only from the server;
    - **airplane mode** before sending: nothing executes, and nothing is shown as sent;
    - **account switch** on the same browser profile: no visibility of or lookup on the other user's intent;
    - exactly one debit and one credit, checked in the DB, plus J2 invariants.

**Weak network (2G/3G):** the low-data timeout (45 s) and the single same-key automatic retry already existed. The new code adds no extra round-trips to the money path. The resume lookup is one GET per 2 s for at most 30 s, only when an outcome is unknown.

## 4. SMS/USSD feasibility (assessment only, nothing built)

| Channel | What it could safely do | What it must not do | Dependencies |
|---|---|---|---|
| **SMS out** (existing adapter) | Receipts and status ("Paiement reçu", "en vérification"), group-dues reminders, with no balance in clear text by default. | Carry codes that authorise money. Include full balances. | Opt-in, per-message cost, sender-ID registration, data-protection review of message contents. |
| **SMS in** (commands) | Balance or status queries after PIN-less, low-risk confirmation. | Money movement: there is no step-up, SIM-swap exposure, and spoofable sender. | Not recommended for money. |
| **USSD** | Balance check, last-5 history, and P2P/cash-out **with PIN in session**. This is the standard WAEMU pattern. | Run without a PIN. Run outside the J2 kernel and idempotency. | **A licensed aggregator or MNO shortcode** (Orange/Free/Expresso), commercial agreements, and the BCEAO position on the channel (K21-REGULATORY-STRATEGY). Session timeouts of about 180 s require one intent key per USSD session. |

Recommendation: start with SMS **receipts and status only**, behind a flag, after a data-protection review. USSD is a regulatory and commercial decision, not an engineering one (P-J12-4).

## 5. Senegal-first languages and low-end Android

- **Language coverage:**
  - fr is authoritative. wo is solid for i18n keys (5 signup keys missing).
  - Money screens are hard-coded French.
- **Proposed order:**
  1. Extract money-safety and status strings into keys.
  2. Wolof copy from a native speaker, reviewed against the French meaning (refusal, verification, "do not repeat").
  3. Pulaar, then Serer.
  4. Keep the other best-effort languages labelled as such.
- **Low-end Android:** this slice adds no heavy dependencies; the banner is a plain `View`/`Text`.
- **Still to measure on a real device:**
  - cold-start time and JS bundle size from the web export;
  - list virtualisation on History and Mbolo;
  - image sizes in low-data mode;
  - large text (K21-ACCESSIBILITY) and the screen reader (`accessibilityLiveRegion` on the banner).

## 6. Decisions needed (none taken; silence is not approval)

- **P-J12-1:** Cache allowlist contents and TTL. Proposal: the public catalog, directory and config list in `offline-policy.js`, 45 s.
- **P-J12-2:** Wolof (then Pulaar, Serer) money-safety copy, written and reviewed by native speakers. Engineering will not ship machine-written financial text.
- **P-J12-3:** Message dedupe (client id plus server unique index). This is a schema change and needs a migration review.
- **P-J12-4:** SMS receipts (opt-in, content rules) and the USSD channel (aggregator or MNO, BCEAO).
- **P-J12-5:** Pending-intent lookup TTL (24 h) and same-key retry window (10 min).

## 7. Not done in this slice

- Interrupted media upload resume.
- Offline **drafts** for non-money forms (job posts, group proposals).
- Server-side `X-Low-Data` response trimming.
- Real-device 2G profiling.
- Applying the same banner to J9 offers and J11 contributions. Those flows use their own idempotency keys, but no lookup resume yet.
