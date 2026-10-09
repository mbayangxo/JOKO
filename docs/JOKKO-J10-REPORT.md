# Jokko J10: Community & Daily Life report

**Verdict: see §5. J10 is a LOCAL engineering milestone.** It is not deployed and makes no production claim:
- **The production delivery-dispute P0, the F1 cooperative double payout and the F4 affiliate decision remain OPEN** on their own track (C). Nothing was deployed. No environment variable was changed. Kebu Supabase was not accessed.
- J10 adds **no new money movement**. Every money flag stays off (`JOKKO_WORK_MONEY_ENABLED`, `AFFILIATE_DEFERRED_SETTLEMENT`, `TONTINE_ESCROW_ENABLED` in production).

## 1. Provisional-acceptance follow-ups (J9: A1–A6, before J10)

| Item | Commit | Evidence |
|---|---|---|
| A1: latest-HEAD gate | `f1af16f` | 665/665, invariants clean; the `ec733fa` run was declared **invalid** (shared Prisma client regenerated mid-run) |
| A2: settlement policy (acceptance / contest / payout eligibility / appeals) | `f1af16f` | `tests/j9/settlement.test.js` 5/5 |
| A3: F1 hotfix package on `7d262de` (not deployed) | `dc6b600` | unpatched fails 2/3, patched passes 3/3; `7d262de` suite 125/125 |
| A4: refund-aware affiliate lifecycle (off by default) and exposure SQL | `2ab1b2a` | 7/7. **Deploy-identity correction:** F4 is not in the live `7d262de`; it is latent on `19ac203` |
| A5: P-J9 decision review | `d9007f3` | `docs/JOKKO-J9-DECISION-REVIEW.md` |
| A6: batch validation, private evidence files, body cap, advisories, legal flags | `d9007f3`, `bc63c51` | batch 2/2, evidence 4/4; highs 31 → 20 (none on the server runtime) |
| Time-of-day test fix | `bc63c51` | the coop insufficient-funds test was held by the 2–4 am Dakar risk rule; now independent of the hour |

## 2. J10.0 inventory
`docs/JOKKO-J10-INVENTORY.md` classifies every community, messaging, social, group, school, event, notification and daily-life feature into JN, MB, KB, SH, AD, LD or FD, says whether it is live or branch-only, and maps the gaps against the 10 priorities.

**Findings (all latent on the default branch, none in the live `7d262de`):**

| Finding | What was wrong | Status |
|---|---|---|
| **J10-F1** | Typing "envoie 2000 à @x" in a chat **sent money directly**: no preview, no confirmation, no idempotency key, any handle | **fixed**: the command now only opens the normal Send flow, pre-filled |
| **J10-F2** | Partner (Kabu) messages ignored the recipient's block, had no per-recipient cap, and sent "verification" texts without the partner's name (phishing pattern) | **fixed** |
| **J10-F3** | Reports went into a void: no queue, no action, no appeal | **fixed** (the moderation loop) |
| **J10-F4** | Phone lookup was an enumeration oracle | **fixed** (budget plus a discoverability setting) |

## 3. What J10 delivers (real UI and API slices)

| # | Priority | Delivered | Tests |
|---|---|---|---|
| 1 | Daily-life home | **Aujourd'hui** (`GET me/today`, `TodayScreen`, Home entry with the real count). Built only from the person's own objects: money requests, J9 offers, milestones and earnings, J8 parcels, J5/J7 orders, school fees for their children, tontine dues, contact and message requests, tickets, moderation decisions. Honest empty state; ETag → 304 | `today` 2/2 |
| 2 | Contacts and consent-based connections | friends / requests (existing); consent-only hashed contact matching; a messaging restriction blocks new requests | `discovery-orders` |
| 3 | Groups with roles and moderation | owner > admin > member; manager-only add, link, remove and mute; announcement mode; link revocation; leave after hand-over; removed members cannot rejoin; **a tontine's chat never touches the tontine** | `groups-moderation` 3/3 |
| 4 | Useful notifications | categories, unread per category, mark all read, mutes (**money and security cannot be muted**), dedupe; **J8 delivery and J9 work events**; the Home bell shows only real unread items | `notifications` 4/4 |
| 5 | Safe merchant/customer communication | one conversation per real order (buyer or that shop's staff), support reference card, blocks close it, no cold outreach, **text never changes the order**; partner messaging fixes | `discovery-orders` 5/5 |
| 6 | School / student / neighbourhood | parent fees due in Aujourd'hui; **Mon quartier** (verified **active** businesses in my area plus neighbours who opted in) | idem; E2E |
| 7 | Privacy-safe discovery | find-by-phone setting (everyone / connections / nobody; hidden looks the same as not found), 30 lookups per hour, contact matching by hash only | idem |
| 8 | Reporting, blocking, moderation, appeals, anti-spam | message reports with a content snapshot (≤ 20 per day, one per message); `trust_safety` role (never combined with finance or sysadmin); warn or restrict 1–30 days; **a restriction never touches money**; one appeal decided by a **different** operator; the reporter learns only "handled"; audit log; ops console Community tab | `groups-moderation`, `adversarial` |
| 9 | Links to J5, J7, J8, J9 and J11 | Today and notifications deep-link to orders, parcels, work and tontines | — |
| 10 | Low-bandwidth foundations | compact Today with ETag, notification cursor; **no offline claim before J12** | `today` |

**Never in J10:** community text moves money, inventory or custody, assigns jobs or changes permissions (`adversarial`: wallet balances, roles and orders unchanged; a client cannot post a "payment" card). No fake engagement: the demo feeds stay off, there are no counters, and no permanent attention dot.

## 4. Gate at the latest HEAD (fresh database)
_Filled from the gate run; see §4 below._

## 5. Verdict, risks, next
_Filled after the gate._
