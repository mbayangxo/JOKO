# J10.0: Community & Daily Life, forensic inventory

**Scope:** every existing community, messaging, social, group, school, event, notification and daily-life feature in the codebase. That covers schema, `lib/` services, `/api` routes and `src/` screens, read as of `bc63c51`.

**Classes** (as in `JOKKO-ECONOMIC-OS-ARCHITECTURE.md`, plus Mbolo):

| Class | Meaning |
|---|---|
| **JN** | JOKKO-NATIVE |
| **MB** | MBOLO-OWNED: messaging is the system of record for conversations, hosted in Jokko |
| **KB** | KABU-OWNED |
| **SH** | SHARED infrastructure |
| **AD** | ADAPTER / integration |
| **LD** | LEGACY / DUPLICATIVE |
| **FD** | FUTURE / DORMANT |

**Status:**
- **live:** in `7d262de`, the latest successful production deployment.
- **branch:** only on the default branch (`19ac203`) or later.
- **J10:** changed here.

## 1. Inventory and classification

| Feature | Where | Class | Status | Assessment |
|---|---|---|---|---|
| Mbolo direct / group threads, messages, media vault, GIFs, voice, video | `MboloThread/Member/Message`, `lib/mbolo-*`, `mbolo/*` (31 routes), `MbooloHome/Chat/GroupInfo` screens | **MB** | live (a subset) / branch | Core is sound. Message requests for strangers, blocks and media retention were hardened earlier (task #7). **Gap:** no group roles or moderation; any active member can add people (§2 G1). |
| **Chat text → money** ("envoie 2000 à @x") | `src/screens/MbooloChatScreen.js` `parseMoneyCommand` → `transfers/send` | — | **branch** (`fa3cd31`) | **Finding J10-F1:** typed text **moved money directly**: no preview, no confirmation, no idempotency key, any handle (not only thread members), `national` currency. **Fixed in J10:** it now opens the normal Send flow pre-filled. The explicit send sheet got an intent key. |
| Mbolo commerce cards (charge card, tontine escrow card, receipts, shares) | `mbolo-commerce/receipt/share-service`, `mbolo/threads/:id/charge-card` | **MB** displaying **JN** objects | branch | Correct pattern: a card **references** a Jokko object, and paying needs an explicit tap on the real flow (`money/charges/:id/pay`). Keep. |
| Partner messaging (Kabu → user) | `lib/partner-messages-service.js`, `v1/messages/send` | **AD** | branch | **Finding J10-F2:** delivered even when the recipient **blocked** the thread; no per-recipient cap; "verification" messages dropped the partner prefix (they look like Jokko itself, a phishing risk). **Fixed in J10** (§3 S5). |
| Friends + friend requests (KYC-gated) | `UserFriend`, `FriendRequest`, `friends-service`, `friends/*`, `FriendsScreen` | **JN** | live | Consent-based (request → accept). This is the base for "connections". |
| Vouch ("confirmé") | `UserVouch`, `vouch-service`, `trust/vouch` | **JN** | branch | Anti-spam signal. Keep; never a credit or trust score. |
| Blocks | `UserBlock`, `trust-safety-service`, `trust/block*` | **JN / SH** | live | Works for users and businesses. Used by Mbolo. **Gap:** partner messaging ignored it (F2). |
| Reports | `ContentReport`, `trust/report`, `mbolo/threads/:id/report` | **JN** | live | **Finding J10-F3:** reports are written (plus a `secureLog`), but **no admin route lists or acts on them**: no review, action, appeal or reporter feedback. `listOpenReports` is unused. **J10 builds the moderation loop** (§3 S8). |
| Notifications | `Notification`, `notify-service`, `notifications` (2 routes), `NotificationsScreen` | **SH** | live | ~90 call sites, money-heavy. **Gaps:** no category, no unread count, no "mark all", no preferences, no dedupe. **J8 logistics and J9 work emit none.** The Home 🔔 dot **blinks permanently**, regardless of unread state (fake attention). J10 fixes these (§3 S4). |
| Home | `HomeScreen.js` | **JN** | live | Money-only by design (balance plus actions). No "what needs me today". J10 adds **Aujourd'hui** (§3 S1). |
| Stories (24 h) | `UserStory`, `mbolo-stories-service`, `mbolo/stories` | **MB** | branch | Friends-scoped. Keep; not extended. |
| Presence / typing / read receipts | `mbolo-presence-service` | **MB** | branch | Active members only (task #7). Keep. |
| Channels (one per account, followers) | `Channel*`, `channels-service`, `channels/*`, `ChannelsScreen` | **MB / FD** | branch | Broadcast feed. Not a J10 priority; **no ranking and no engagement counters**. Keep as is. |
| Polls (profile poll) | `UserPoll*`, `polls-service` | **LD** | branch | Novelty feature, superseded by group features. Leave dormant; no investment. |
| Broadcast (≤ 50 handles) | `mbolo-broadcast-service` | **MB** | branch | Message-request rules apply. Keep. |
| Culture feed, trending articles, regional alerts | `CultureFeedItem`, `TrendingArticle`, `RegionalAlert`, `culture-feed`, `trending-feed-service`, `regional-alerts-service` | **FD / LD** | live | Demo seeds are already gated off in production (`demoContentAllowed`). Seeded `signatureCount` / `trendScore` are **fake engagement** if ever shown: they stay off. Regional alerts need a real source before use. **Not used by J10.** |
| Events and tickets (door scan) | `Event`, `Ticket`, `TicketPass`, `event-ticket-service`, `events/*`, `EventCreate/Scanner` | **JN** (money via J2) | live | Real. J10 shows a person's **own upcoming tickets** in Aujourd'hui. No event discovery feed (no fake events). |
| School: students, fee periods, parent payments, reminders | `SchoolStudent/FeePeriod/FeePayment`, `school-service`, `businesses/:id/school/*`, cron reminders | **JN** | live | Real, business-run. **Gap:** the parent has no "fees due for my children" view. J10 adds it to Aujourd'hui (S6), grounded in `SchoolFeePayment`. |
| Student pass | `User.studentPass*`, `me/student-pass` | **JN** | branch | Keep. Shown in Aujourd'hui when pending or expiring. |
| Jekkal campaigns (fund-raising) | `jekkal-service`, `jekkal/*` | **JN** (money) | branch | A money product: **J11** scope (collective money). Not touched. |
| Tontine groups | `Tontine*`, `tontine-service`, Mbolo tontine thread | **JN** (money) | live / branch | **J11** scope. J10 shows **contributions due** in Aujourd'hui (read-only). A group's Mbolo chat **never** changes tontine membership or money. |
| Support tickets, partner support threads, call logs | `SupportTicket*`, `PartnerSupport*`, `support/*`, `SupportScreen` | **SH / AD** | live | Keep. J10 attaches **support references** (order / shipment / work refs) to order conversations (S5). |
| `users/lookup` (find by phone or handle) | `handlers.js usersLookup` | **JN** (J4 P2P) | live | **Finding J10-F4:** phone lookup is an **enumeration oracle** (is this number on K21, and under which name?), bounded only by the generic per-account limit. J10 adds a lookup budget and a discoverability setting (§3 S7). |
| Public profile | `profiles/:id`, `PublicProfileScreen` | **JN** | live | Minimal shape; relation-aware. Keep. |
| Kabu (Kebu) shop, customers, staff | Partner API, `ExternalLink` | **KB / AD** | branch | Not a J10 surface. Kabu's own customer messaging stays Kabu's; Jokko delivers through the partner adapter (F2 fixes). |
| Legacy `/server` Express app | `server/` | **LD** | — | Superseded; not used. |
| Offline sync | `offline/sync`, Mbolo offline queue | **SH** | branch | Message queueing only. **No offline-support claim before J12.** |

## 2. Gaps against the J10 priorities

| # | Priority | Exists | Missing (J10 builds) |
|---|---|---|---|
| 1 | Daily-life home | money Home | **Aujourd'hui:** one honest list of what needs the person today, from real objects only |
| 2 | Contacts and consent-based connections | friends + requests | discoverability setting; consent-only contact matching |
| 3 | Groups with roles and moderation | groups, invites, requests | **G1:** owner/admin/member roles; admin-only add/remove/mute; announcement mode; leave; invite revocation; group reports |
| 4 | Useful notifications | money notifications | categories, unread count, mark all, per-category mute (money and security never muted), dedupe; **J8 delivery and J9 work events**; honest 🔔 |
| 5 | Safe merchant/customer communication | commerce cards, support | order-anchored conversation (buyer or seller of that order only) with a support reference; partner messaging respects blocks, caps and attribution |
| 6 | School / student / neighbourhood | school fees, student pass, arrondissement | parent "fees due"; verified businesses in my neighbourhood (real, opt-in for people) |
| 7 | Privacy-safe discovery | phone/handle lookup | lookup budget; discoverable-by-phone setting; consent-only contact match |
| 8 | Reporting, blocking, moderation, appeals, anti-spam | blocks; reports into a void | **moderation queue, actions (warn / messaging restriction), reporter feedback, one appeal decided by a different operator;** a messaging restriction never touches money |
| 9 | Links to J5, J7, J8, J9, J11 | — | Aujourd'hui and notifications deep-link to orders, deliveries, work, tontines |
| 10 | Low-bandwidth foundations | Mbolo offline queue | compact Aujourd'hui payload, `since` cursor, ETag; no offline claim |

## 3. Non-negotiable rules for J10
- **Community text never authoritatively moves money or inventory, transfers custody, assigns jobs or changes permissions.** Cards reference real objects; acting means the object's own flow with its own authorization (J2/J3).
- **No fake engagement.** No seeded people, merchants, jobs, events, counters or "trending". No attention dots without a real unread item. Empty states are honest.
- **Moderation never touches money.** A messaging restriction stops new conversations and group posts. Payments, refunds, payouts and receipts keep working.
