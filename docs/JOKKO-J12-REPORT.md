# J12: Offline, low-bandwidth, Senegal-first (final report)

**Scope:** local engineering only. **Nothing deployed.** J11 and J12 are **not activated** in production: all J11 money flags stay off, and the two J12 migrations are additive and not deployed. Production incidents are reported separately in §9 and were never bundled with J12.

**Final tested commit:** see §8. The report itself is committed after the gate; that commit is docs only.

**Every result marked "simulated" comes from desktop Chromium with DevTools emulation, not a physical device** (§6).

---

## 1. Rules applied everywhere

| Rule | How it is enforced |
|---|---|
| Never display a payment as completed before the server confirms it | `MoneyPhaseBanner` says "effectué" only for `state === 'done'`, i.e. after the server answer or an intent lookup. Browser tests assert that "Envoyé !" never appears while an outcome is unknown. |
| No spendable local balances | Balances are never cached: they are excluded by the low-data allowlist. Pending intents store a key, the user, the flow and an instruction **hash** only. |
| Never auto-resubmit a financial transaction after an uncertain outcome | An uncertain outcome leads to a **lookup** (`GET /api/money/intents/:key`) only, including after a restart. The same key is reused only for an identical instruction within 10 min (P-J12-5), and only on a user action. |
| Offline state never overrides server permissions | Queued messages and replays pass the same membership and posting checks; a removed member cannot replay. Revoked sessions show no private content. Refusals become "held", never retried. |
| Queued money is never shown as money | The offline queue accepts text and stickers only. Money kinds and money commands are dropped and never drafted. |

## 2. Policy decisions applied (P-J12-1 … P-J12-5)

| Decision | Implementation |
|---|---|
| **P-J12-1** low-data cache | A strict allowlist of public, non-sensitive GETs (`src/lib/offline-policy.js`), at most 45 s, keyed per user (token subject), cleared on sign-in, sign-out and session refresh failure. Private, financial, identity and authorization responses are never cached (tested path by path). |
| **P-J12-2** languages | `src/i18n/money-safety.js`: reviewed French is the reference and fallback. A Wolof, Pulaar or Serer entry is used only with a native-speaker review record (`reviewedBy`, `reviewedAt`, `checkedAgainst: 'fr'`). The build test fails on an unreviewed entry. **No translation was invented.** |
| **P-J12-3** chat dedupe | Additive migration `20261025000000_j12_mbolo_client_message_id`: nullable `clientMessageId` plus a unique index on (`senderId`, `clientMessageId`). The server replays on a repeated id, refuses reuse for a different message (409), and survives concurrent sends (P2002 → replay). **Not deployed.** |
| **P-J12-4** SMS | Research and dormant code only: `docs/JOKKO-J12-SMS-USSD.md`. Balance-by-SMS is now opt-in and PIN-confirmed (J12-F12). There is no SMS payment authorization and no USSD. |
| **P-J12-5** windows | Client lookup period 24 h; identical-instruction retry 10 min. **The server's idempotency rows and ledger remain authoritative beyond these windows** (history shows the real outcome). An expired client record is only forgotten: it is never shown as "failed" and never enables a second payment. After a restart, a "nothing received" answer keeps the key bound to the instruction hash for 10 min, so re-entering the same payment reuses it and a late-arriving original cannot execute twice. |

## 3. Features completed

| Area | Delivered | Evidence |
|---|---|---|
| Pending-payment memory and restart resume | `useMoneySubmit` + `pending-intents` (key, user, flow, hash) | E2E j12: lost reply, restart, airplane mode, account switch; lab: clock ±, page killed, background freeze |
| J9 offers and budget top-ups | `BusinessWorkScreen` on `useMoneySubmit` + banner; router intent ledger | E2E j9 11/11 |
| J11 contributions | `CollectiveGroupScreen` on `useMoneySubmit` + banner; contribute, withdraw, release and protected contribute added to the intent ledger | E2E j12 (lost reply → verification → server confirmation, paid once); E2E j11 8/8 |
| PIN × idempotency | J12-F7 + J12-F8 | `tests/j12/pin-idempotency.test.js` (6, real HTTP), `tests/j4/intents.test.js` (order test, fails before the fix) |
| Chat outbox dedupe and sync states | Stable client ids, owner-scoped queue, pending/held states, Resend/Discard, retry while open | `tests/j12/chat-dedupe.test.js` (6); E2E: lost reply stored exactly once; lab reconnect storm, 0 duplicates |
| Interrupted uploads | `src/lib/upload-resume.js`: mint → PUT → complete → send checkpoint; "Reprendre" in chat | `tests/j12/upload-resume.test.js` (cut at every step, URL expiry, refusal, J12-F9) |
| Offline drafts (non-financial) | `src/lib/drafts.js` + `useDraft`: job posting, chat compose; money fields and money commands never drafted; 7-day TTL; wiped at sign-out | `tests/j12/drafts-network.test.js`; E2E draft survives a reload |
| Expired, revoked and switched sessions | Cache cleared on refresh failure; per-user partitions; revoked session shows nothing private | E2E revoked-session step; PIN suite (revoked step-up rejected) |
| Network status and accessibility | `NetworkStatusBanner` (screen-reader alert) derived from real requests and browser events; banner copy says a payment never leaves offline | unit test; E2E offline/online |
| Low-data daily-life screens | `LowDataImage` tap-to-load on Marché, shop, product and channel screens; chat already lazy | `import-integrity` + build |
| Web boot on weak networks | J12-F14 font timeout fix; J12-F15 boot message and bounded automatic retry (`public/index.html`) | lab: cold 2G load, interrupted first load |
| Weak-network / low-end lab | `tests/e2e/j12-lab.mjs`, part of the gate, JSON report | §6 |

## 4. Findings (all fixed locally unless stated otherwise)

| ID | Finding | Severity | Status |
|---|---|---|---|
| J12-F1 | Low-data cache never cleared, URL-keyed, cached personal GETs | Device privacy | Fixed |
| J12-F2 | Offline chat queue not tied to its author; after an account switch, A's messages could be sent as B | Impersonation (device) | Fixed |
| J12-F3 | Unknown-outcome key lost on app kill or reload | Double payment by user retry | Fixed |
| J12-F4 | Same-key retry unbounded in time and instruction | Stale replay | Fixed |
| J12-F5 | Chat messages could post twice after a lost reply | Cosmetic | **Fixed** (P-J12-3) |
| J12-F6 | Payment-safety text French-only | Comprehension | Mechanism built; **translations await native reviewers** |
| J12-F7 | PIN challenge (403) stored as the intent's final answer, so PIN-confirmed payments could never complete | Fails closed | Fixed. **Production not affected** (`b0318b5` predates the J4 wrapper) |
| J12-F8 | Reply sent before the idempotency row was final, so an instant retry got a spurious 409 | Fails closed | Fixed (order test fails before the fix) |
| J12-F9 | Retried or concurrent media completion charged the vault quota twice | Quota accounting | Fixed (test fails before the fix) |
| J12-F10 | Chat imported a misspelled media-send function: every chat photo, video, GIF and voice send threw | Feature broken (local branch only; not in `b0318b5`) | Fixed + import-integrity guard |
| J12-F11 | Web bundle 9.4 MB raw / 2.1 MB gzip: about 63 s first download on 2G | Performance | **Open**: J13 (code splitting, Hermes bytecode for native, asset diet) |
| J12-F12 | Balance-by-SMS on by default for every user | Privacy (SIM holder) | Fixed for new accounts and PIN to enable; **existing users: decision P-J12-6** |
| J12-F13 | User lookup guessed "phone" for any query with 8+ digits; digit-heavy handles were "introuvable" | Functional; also a ~2 % test-flake source | Fixed (explicit mode) |
| J12-F14 | **Web app stuck forever on the loading screen on slow links** (expo-font 3 s timeout) | Availability (web) | Fixed on J12; **also present in production `b0318b5`**: separate package (§9) |
| J12-F15 | An interrupted bundle download left a blank page | Availability (web) | Fixed (boot message + bounded retry) |

## 5. Senegal-first languages and accessibility
- The safety-message catalogue and reviewed-only mechanism are in place; screens show reviewed French until reviewed translations exist.
- **Needed from people, not code:** Wolof, then Pulaar, then Serer payment-safety texts written and reviewed by native speakers against the French meaning.
- **Accessibility:**
  - status banners announce themselves (`accessibilityRole="alert"`, polite live region);
  - tap-to-load images carry labels;
  - the boot page uses `role="status"`.

## 6. Weak-network / low-end lab (**SIMULATED**)

**Harness:** `tests/e2e/j12-lab.mjs`. Desktop Chromium with DevTools network and CPU emulation, seeded loss, fixed profiles:
- **2G:** 280/256 kbps, 800 ms RTT;
- **3G-unstable:** 750/250 kbps, 300 ms RTT, 10 % seeded request loss, 2 s drops every 12 s;
- **CPU:** 6× slowdown as a low-end proxy.

The JSON report is written by the gate (`lab.json`). Results at the final gate are in §8.

**Still needs a real low-end Android device:**
- true memory pressure and process death by the OS (emulation cannot limit memory);
- Hermes start-up and JS parse time on an entry-level SoC;
- real 2G/3G radio behaviour (RRC state promotion, handovers, carrier proxies);
- background kill by vendor battery managers;
- SecureStore performance;
- camera and media pickers;
- TalkBack with real fonts;
- APK size and install over mobile data.

## 7. Not done (scope for J13)
- **Bundle diet (J12-F11):**
  - route-level code splitting on web;
  - Hermes bytecode and size budget for native;
  - font subsetting;
  - an image size budget;
  - a performance budget in CI.
- **Server-side `X-Low-Data` trimming:** smaller list payloads, no avatars.
- **Real-device lab:** low-end Android devices on real Orange/Free/Expresso SIMs, following §6.
- **Reviewed Wolof copy:** wire it into the catalogue once reviewed.
- **Dormant SMS receipts:** the P-J12-7 design, flag off.
- **Offline drafts:** extend to dispute and support forms (the allowlist is ready).

## 8. Final gate (fresh database, J1–J12)
(filled below after the run)

## 9. Production (separate from J12; nothing deployed)

| Incident | Status |
|---|---|
| **P0-A** tontine drain containment | Production build `dpl_CmyTMHWsumXsE3aduWzbcjzUxEoS` (`b0318b5`) READY; aliases verified on 2026-10-10. **Runtime verification INCOMPLETE:** on 2026-10-13 runtime errors, runtime logs **and even the deployment list** return 403 for this session (scope `mbayangxos-projects`). Containment is **not** claimed. Owner checks remain in the incident README §10. Never roll back to `7d262de`. |
| **P0-B** delivery-dispute ruling open to users | **OPEN in production.** Re-verified on `b0318b5`: patch byte-identical; patched 122/122 + probe; the probe fails on unpatched `b0318b5`. Separate package; not deployed. |
| **F1** cooperative double payout | **OPEN in production.** Re-verified on `b0318b5`: duplicate payout reproduced unpatched (fails 2/3); patched 3/3; suite 125/125. Separate package; not deployed. |
| **Web slow-boot** (new, J12-F14) | **Present in production.** Emulated 2G: `b0318b5` still on the splash after 240 s; patched, home at 39 s. Availability only, no money or data risk. Separate package `docs/incidents/2026-10-web-slow-boot/`; not deployed. |

Kebu Supabase was not touched. No secrets were read or printed.

## 10. Decisions and external dependencies (none taken here)
- **P-J12-6:** switch existing users' balance-by-SMS off (with notice).
- **P-J12-7:** approve the dormant SMS receipt design.
- **P-J12-8:** read-only USSD pilot after the licensing decision.
- **Native reviewers:** Wolof, Pulaar and Serer payment-safety copy.
- **Deployment authority and Vercel access:** both are needed for P0-A verification and for the P0-B, F1 and web slow-boot packages, each deployed separately.
- **Migration windows:** the two additive J12 migrations, including building the chat index `CONCURRENTLY` on a large table.

## 11. Recommendation for J13
**J13 = "fast and verifiable on a real phone".** In order:
1. Get the production emergency packages deployed and verified, one by one (P0-B, F1, web slow-boot), with restored Vercel access.
2. Bundle and start-up budget (J12-F11) with a CI performance gate.
3. A real-device low-end Android lab on Senegalese networks, turning §6's "simulated" into measured.
4. Reviewed Wolof safety copy.
5. Dormant SMS receipts (flag off).
6. Server low-data payloads.

J11 and J12 production activation should wait for steps 1 and 3.
