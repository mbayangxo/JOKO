# Jokko: Mboolo message requests

**Status:** built and tested (`tests/http/message-requests.test.js`, 17 adversarial HTTP tests under `NODE_ENV=production`). The legacy-thread migration has **not** been run on any shared or production database.

## Why

A public handle makes someone discoverable. It must not give a stranger a conversation. Before this change, anyone could open a direct thread with any handle and post without limit. That is also how the run-3 user-record leak reached its victims.

## Model (`lib/mbolo-access.js`)

`MboloMember.status`:

| State | Meaning |
|---|---|
| `active` | Accepted. Also: the creator, friends, and anyone who used an invite link. |
| `requested` | Added by a stranger. Sees only the request card. |
| `declined` | Said no. |
| `blocked` | Said no and blocked the requester (`UserBlock` row). |

The member row also stores `invitedById` and `respondedAt`.

| | Requester (stranger) | Recipient while `requested` |
|---|---|---|
| Messages before acceptance | **One** text intro, ≤500 characters. No media, stickers, GIFs, shares, affiliate cards, calls, or payment/commerce receipts. | Can't post or read the thread. Sees the card in `GET /api/mbolo/requests`: requester name/handle/avatar plus the intro. Group requests carry no content and don't name other invitees. |
| Presence / read / typing | Sees none of the recipient's. | None of their own state is recorded, and none is visible to them. |
| Can tell decline / block from pending | No. All three show as `pending`. | — |
| New request after decline or block | Refused. Blocked → `cannot_message`. Declined → the same pending thread comes back. Add-member silently skips. | Not pinged again. |
| Friend request after decline (30 days) or block | Looks sent. Nothing is created and no notification goes out. | — |

**Recipient actions:**
- `POST /api/mbolo/threads/:id/accept`
- `POST /api/mbolo/threads/:id/decline`
- `POST /api/mbolo/threads/:id/block`
- `POST /api/mbolo/threads/:id/report` (creates a `ContentReport` against the requester)

Each change is a conditional update on the current status. So a concurrent accept + decline produces exactly one winner, and the loser gets `409`.

**Rate limit:** each requester may make 10 requests to strangers per hour and 30 per day (`RL_MSG_REQUEST_HOUR`, `RL_MSG_REQUEST_DAY`) → `429`.

**Enumeration:** a non-member gets the same status and body for a real thread id and a made-up one.

**Responses:** threads are shaped by `threadDto`, an explicit DTO. A member object carries only `userId, role, status, lastReadAt, user{id,name,handle,avatarEmoji,avatarUrl,statusText}`. The global secret scrubber stays as a second layer.

**Trust only comes from deliberate relationships:**
- an accepted friendship (`ensureDirectMboloThread` activates any pending thread unless either side blocked);
- an explicit accept;
- a voluntary invite-link join.

It is **never** inferred from a payment or marketplace order. Payment receipts post only when payer and recipient are both `active` members (`postPaymentReceipt`). A payment never creates a thread, and the unused `postReceiptBetweenUsers`, which created one, is removed.

**Out of scope (documented decisions):**
- **Partner/system threads** (`type: 'partner'`, Kebu support): these are created by an authenticated partner API, which is a partner-trust decision recorded in the forensic report.
- **Tontine commerce threads:** they hold only the creator.

**Also tightened:**
- invite links are for groups only, so a direct chat can't silently turn into a group;
- a member who blocked a group can't be re-joined by its invite link;
- the affiliate share no longer returns the sender's full User row (`include: { sender: true }` → select).

## Migrating existing conversations

Threads created before this change have every member `active`. One-time migration:

```bash
node scripts/migrations/mbolo-message-requests.mjs            # dry run: counts only
node scripts/migrations/mbolo-message-requests.mjs --execute  # local
node scripts/migrations/mbolo-message-requests.mjs --execute --confirm-production <db host>
```

A legacy member becomes `requested` (invited by the creator) only if they are:
- not the creator;
- in a direct or group thread that isn't a commerce thread;
- someone who never posted there;
- not a friend of the creator.

Anyone who has posted keeps the conversation, because it was previously accepted. The migration is idempotent and tested. **Not run against production:** the deployment is blocked and production access is read-only.

## Client

Mboolo home shows a "Demandes de message" section with Accepter / Refuser / Bloquer / Signaler. In the chat, a second message before acceptance shows the server's message ("Ta demande est envoyée…").
