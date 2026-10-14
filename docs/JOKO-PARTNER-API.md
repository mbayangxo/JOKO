# Joko Partner API — payments + messaging for African shops

Joko is the **wallet**. Kebu (and other shops) plug in via this Partner API.

Base URL: `https://<joko-host>/api`  
Example: `https://keit-six.vercel.app/api`

## Auth

```http
Authorization: Bearer {JOKO_API_KEY}
```

Or header `X-Api-Key: {JOKO_API_KEY}`.

| Env (Joko server) | Purpose |
|---|---|
| `JOKO_API_KEY` | Partner bearer secret (default partnerId = `kebu`) |
| `JOKO_DEFAULT_PARTNER_ID` | Optional, default `kebu` |
| `JOKO_API_KEYS` | Multi: `kebu:key1,rect:key2` |
| `JOKO_WEBHOOK_SECRET` | HMAC key for outbound webhooks |
| `PARTNER_WEBHOOK_URL` | Optional default webhook if request omits `webhook_url` |
| `PARTNER_SETTLEMENT_USER_ID` | Optional Joko user wallet credited on collect |
| `PARTNER_MESSAGING_USER_ID` | System user that sends partner Mbolo messages |
| `PUBLIC_APP_URL` | Used to build `payment_url` (fallback: `EXPO_PUBLIC_API_URL`) |
| `JOKO_XOF_PER_USD` | Legacy USD→XOF bridge (default `600`) |
| `PARTNER_SANDBOX_AUTO_COMPLETE` | If `true`, hosted confirm auto-completes in sandbox |

Kebu should set:

```
JOKO_API_BASE_URL=https://<joko-host>/api
JOKO_API_SECRET=<same as JOKO_API_KEY>
JOKO_WEBHOOK_SECRET=<same as JOKO_WEBHOOK_SECRET>
```

## Mode 1 — Accept payment online (shop checkout)

### `POST /v1/checkout/sessions`

Preferred body (XOF):

```json
{
  "reference": "shop_order_<uuid>",
  "amount_xof": 15000,
  "currency": "XOF",
  "description": "Shop order: Product",
  "customer": { "phone": "+22177…", "email": "optional@…" },
  "method": "wave",
  "return_url": "https://kebu…/thanks",
  "cancel_url": "https://kebu…/cancel",
  "webhook_url": "https://kebu…/api/webhooks/joko",
  "metadata": {
    "partner": "kebu",
    "kind": "shop_order",
    "order_id": "…",
    "project_id": "…"
  }
}
```

Legacy bridge: `amount` (USD cents) + `currency: "USD"` converts via `JOKO_XOF_PER_USD` until Kebu sends XOF natively.

Response:

```json
{
  "id": "pay_…",
  "reference": "shop_order_…",
  "status": "pending",
  "payment_url": "https://…/api/v1/pay/pay_…?token=…",
  "amount_xof": 15000,
  "mode": "sandbox"
}
```

`payment_url` always present — hosted Joko pay page. Buyer enters phone; MM is push-to-phone in live mode.

Idempotency: same `partnerId` + `reference` + same `amount_xof` + same merchant returns the existing session; a different amount or merchant is `409 idempotency_conflict`.

### Per-merchant settlement (J6.0 — mapped merchants)

Send the Kabu shop id of a merchant linked through `POST /v1/business-links`:

```json
{ "reference": "shop_order_…", "amount_xof": 5000, "merchant": { "external_business_id": "kabu_shop_123" } }
```

- Resolves **only** through the consented, active link of the calling partner. Unknown / revoked → `409 merchant_not_linked`; suspended merchant → `409 merchant_inactive`. Optional `merchant.jokko_business_id` is an assertion (`409 mapping_mismatch` if different), never an instruction.
- On provider confirmation the money settles to **that merchant's business wallet** — never the platform settlement wallet, never another business.
- If the link was revoked / re-pointed or the merchant suspended between creation and confirmation, the collected funds are **held for review** (`settlement.status = held_for_review`) and released only by Jokko finance (maker/checker) to the merchant the payment was created for.
- Every response and the `paid` webhook carry `settlement: { target, legacy, external_business_id, status, ledger_reference }`.
- **LEGACY:** a payment without `merchant.external_business_id` settles to `PARTNER_SETTLEMENT_USER_ID` (`settlement.target = legacy_platform`). `PARTNER_LEGACY_PLATFORM_SETTLEMENT=false` refuses such requests (`400 merchant_required`). Payouts still debit the platform settlement wallet (per-merchant payouts: DORMANT).

### `POST /v1/payments/collect`

Same auth. Requires phone. Same response shape (also returns `payment_url`).

### `GET /v1/payments/:reference`

Poll status: `pending` | `requires_action` | `completed` | `failed`.

### `POST /v1/payments/:reference/sandbox-complete`

Sandbox / mock Julaya only. Marks paid and fires webhook. **Blocked in live mode.**

## Webhook (required for Kebu “paid”)

When status becomes completed, Joko POSTs to `webhook_url`:

```json
{
  "reference": "shop_order_…",
  "payment_id": "pay_…",
  "status": "paid",
  "amount_xof": 15000,
  "metadata": { "partner": "kebu", "kind": "shop_order", "order_id": "…" }
}
```

**Signature mode: HMAC-SHA256** (matches Kebu `verifyJokoWebhookSignature`):

```
Header: x-joko-signature: sha256=<hex>
= HMAC_SHA256(raw_body, JOKO_WEBHOOK_SECRET)
```

Retries: up to 5 attempts with backoff on non-2xx.

## Mode messaging — verification + fulfill texts

### `POST /v1/messages/send`

```json
{
  "to_phone": "+22177…",
  "text": "Your code is 482191",
  "channel": "mbolo_auto",
  "metadata": { "partner": "kebu", "kind": "verification" }
}
```

Optional header: `Idempotency-Key`.

Response:

```json
{
  "id": "msg_…",
  "status": "sent",
  "channel_used": "mbolo",
  "error": null
}
```

Rules:

- Joko user with that phone → deliver in Mbolo (`channel_used: mbolo`)
- Else → SMS via configured provider (`channel_used: sms`)
- Else → `status: failed` with honest `error` (never fake sent)

## Mode 2 — Accept in store (POS / QR terminal)

### `POST /v1/pos/sessions`

Merchant enters amount on tablet/phone; customer pays via QR.

```json
{
  "amount_xof": 2500,
  "description": "Counter sale",
  "webhook_url": "https://kebu…/api/webhooks/joko",
  "metadata": { "shop_id": "…", "cashier": "awa" }
}
```

Response includes `payment_url`, `qr_payload` (same URL), `channel: "pos"`, and `terminal` helper copy. Customer opens URL → enters MM phone → sandbox-complete or live push.

### `GET /v1/pos/:reference`

Same as payment GET (poll until `completed`).

## Mode 3 — Send payment (payouts)

### `POST /v1/payouts`

```json
{
  "reference": "payout_supplier_1",
  "amount_xof": 100000,
  "phone": "+22177…",
  "method": "wave",
  "description": "Supplier settle",
  "webhook_url": "https://…",
  "execute": true,
  "metadata": { "kind": "payout" }
}
```

Live mode debits `PARTNER_SETTLEMENT_USER_ID` wallet then Julaya cash-out. Sandbox: create then `POST /v1/payouts/:reference/sandbox-complete`.

### `GET /v1/payouts/:reference`

### Webhook for payouts

Same HMAC. Body includes `"type": "payout"`, `payout_id`, `status: "paid"`.

## Mode 4 — Mbolo Business CS (shop agents)

Hire agents who already have Joko accounts; open order threads; reply in Mbolo.

| Method | Path |
|---|---|
| POST | `/v1/support/agents` — `{ phone, name, shop_external_id, role }` |
| GET | `/v1/support/agents` |
| POST | `/v1/support/threads` — `{ customer_phone, order_id, subject, initial_message? }` |
| GET | `/v1/support/threads` |
| POST | `/v1/support/threads/:id/assign` — `{ agent_id }` |
| POST | `/v1/support/threads/:id/messages` — `{ text, agent_id? }` |

If customer has no Joko account, thread opens without Mbolo — use `/v1/messages/send` (SMS) until they install Joko. Agent registration fails honestly (`user_not_found`) if phone is not a Joko user.

Requires `PARTNER_MESSAGING_USER_ID` (system sender) for auto messages / thread creation.

## Event subscriptions (J14-S1, disabled by default)

**Status:** local engineering only. Off unless `PARTNER_EVENTS_ENABLED=true`. Not activated in production. This is separate from the per-payment `webhook_url` above, which is unchanged.

A partner subscribes an HTTPS endpoint to a minimal allowlist of events (D-J14-2). Only events of businesses **explicitly linked** to that partner are sent (active `ExternalLink`, `objectType=business`). Nothing is sent for another partner's business, an unlinked business or a revoked link; the link is re-checked at send time.

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/event-subscriptions` | `{ url, event_types? }`. Returns `secret` **once**. |
| GET | `/v1/event-subscriptions` | Your subscriptions only (no secrets) |
| POST | `/v1/event-subscriptions/:id/rotate-secret` | New secret, returned once; the old one is still used for signing for 24 h |
| POST | `/v1/event-subscriptions/:id/disable` | Stops delivery |
| GET | `/v1/event-deliveries` | Your delivery log (30 days) |

**Event types:**
- `order.placed`, `order.paid`, `order.accepted`, `order.ready_for_fulfillment`, `order.out_for_delivery`, `order.delivered`, `order.completed`, `order.cancelled`, `order.refunded`
- `payment.recorded`
- `settlement.completed`, `settlement.held`
- `fulfillment.requested`, `shipment.created`

Payloads carry ids, amounts and statuses only, never names, phones, addresses or notes:

```json
{
  "id": "evt id (stable across retries)",
  "type": "settlement.completed",
  "created_at": "2026-10-13T12:00:00.000Z",
  "business": { "external_id": "your shop id" },
  "object": { "type": "partner_payment", "jokko_id": "…", "external_id": null },
  "data": { "amountKori": 15000, "partnerReference": "shop_order_…" },
  "api_version": "2026-10-j14"
}
```

### Verifying a delivery

Headers:

```
X-Jokko-Event-Id:        <event id>
X-Jokko-Event-Timestamp: <unix seconds>
X-Jokko-Event-Signature: v1=<hex>[,v1=<hex>]
```

Each signature is `HMAC_SHA256(secret, "<timestamp>.<event id>.<raw body>")`, hex-encoded. During a rotation overlap there are two signatures; accept the request if **any** of them matches. The receiver must:

1. compute the HMAC over the **raw** body bytes, before parsing the JSON;
2. compare in constant time;
3. reject a timestamp more than **300 s** from its own clock (replay window);
4. dedupe on `X-Jokko-Event-Id`. Delivery is at-least-once, so the same id can arrive more than once, for example after a retry or an operator replay.

```js
import crypto from 'node:crypto';
function verify(secret, { timestamp, eventId, rawBody, header }) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const want = Buffer.from('v1=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${eventId}.${rawBody}`).digest('hex'));
  return header.split(',').some((s) => { const got = Buffer.from(s.trim()); return got.length === want.length && crypto.timingSafeEqual(got, want); });
}
```

A delivery succeeds only on a `2xx` response. Redirects are not followed. On failure, Jokko retries with backoff (0 s, 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h). After 8 attempts the delivery is dead-lettered. An authorized operator can replay it, with a reason that is audited; the replay carries the same event id. Delivery logs are purged after 30 days. Events and financial audit records keep their own retention. A delivery never changes money on either side.

## Product mapping (J14-S3, disabled by default)

**Status:** local engineering only. Off unless `PARTNER_PRODUCT_MAPPING_ENABLED=true`. Requires scopes `partner.products.map` and `partner.products.read`.

| Method | Path | Body / query |
|---|---|---|
| POST | `/v1/product-links` | `{ external_business_id, external_product_id, jokko_product_id \| jokko_sku }` → `201` created, `200` same mapping again (idempotent), `409 already_mapped` if pointed elsewhere |
| GET | `/v1/product-links?external_business_id=…` | Your links for that linked shop |
| POST | `/v1/product-links/:id/unlink` | Revokes the link; mapping again reactivates the same row |

Rules:
- The business link must be active, and the product must belong to **that** business. Another business's product, an unknown shop and a revoked link all return `404`.
- Only ids cross. No title, price, stock or image is copied.
- External product ids are namespaced per shop, so two shops can reuse the same SKU string.
- The business owner sees these links, and can revoke them, under the existing business-links screen. Revoking the business link disables all of its product links.

## Fulfilment requests → Jokko Logistics (J14-S2, disabled by default)

**Status:** local engineering only. Off unless `PARTNER_FULFILLMENT_ENABLED=true`. Requires scopes `partner.fulfillment.request` and `partner.fulfillment.read`.

`POST /v1/fulfillment-requests`

```json
{
  "external_business_id": "your shop id",
  "external_order_id": "your order id",
  "mode": "merchant_fleet",
  "lines": [{ "external_product_id": "kabu-riz", "qty": 2 }],
  "destination": { "area": "Médina", "precise": "…", "lat": 14.68, "lng": -17.44 },
  "pickup_point_id": "only for customer_pickup"
}
```

Responses:
- `201` for a new request, `200` for a retry of the same order. Retries are idempotent per (partner, shop, order).
- The body is `{ reference, external_order_id, mode, request_status, shipment: { reference, status } }`. The destination is never echoed back.

Rules:
- The shop link must be active, and the business active (`409 business_inactive` otherwise).
- Every line must be mapped through `/v1/product-links`. Otherwise `422 product_not_mapped` lists the unmapped ids and nothing is created.
- **No money moves.** Only `merchant_fleet` and `customer_pickup` are accepted. `jokko_logistics` is refused with `409 requires_merchant_approval`: it holds a delivery fee from the business wallet, and D-J14-1 requires an in-Jokko approval for any partner-initiated business debit.
- Ids may not contain `:`.

Use `GET /v1/fulfillment-requests/:reference` for status. It returns your own requests only; any other request reads as `404`. Status changes also arrive as signed `shipment.*` events (S1), only for shipments **you** requested.

## Scoped partner keys (J14-S6, disabled by default)

**Status:** local engineering only. Off unless `PARTNER_SCOPED_KEYS_ENABLED=true`. With the flag off, nothing changes: environment keys (`JOKO_API_KEYS`) authenticate exactly as before, at 60 requests/min per partner.

With the flag on:

- **Database keys** look like `jk_live_…` or `jk_test_…`. Only a SHA-256 hash is stored, and the key is shown once, at issue.
- **Issuing a key is maker/checker:**
  1. An operator with `partner_keys.issue` (role `integration_ops`) issues the key with its scopes, environment, and an optional rate limit and expiry.
  2. The key stays **unusable** until a *different* operator with `partner_keys.approve` (role `risk`) approves it through `POST admin/approvals/:id/approve`.
- **Scopes** are the route-policy permissions (for example `partner.collect`, `partner.payment.read`, `partner.events.subscribe`). A key calling a route outside its scopes gets `403 scope_required`. The check runs centrally for every partner route.
- **Environment:** a `sandbox` key is refused while the server is live (`403 environment_mismatch`). A `live` key never reaches a sandbox-only route.
- **Rotation:** `POST admin/partner-keys/:id/rotate` creates a new pending key with the same scopes. Once that key is approved, the old one expires after the overlap: at most 24 h, and 0 cuts it at approval.
- **Revocation** (`POST admin/partner-keys/:id/revoke`, reason required) is immediate and audited. A revoked pending key can never be activated.
- **Rate limits** apply per partner (`JOKO_PARTNER_RATE_LIMITS=kebu:120,rect:30`, default 60/min, shared by all of that partner's keys) and per key (`rate_limit_per_min`). Exceeding either returns `429`.
- **Partner audit trail:** each mutating call writes one row recording partner, key, route and status code. No request body and no personal data are stored. Read it through `GET admin/partners/:partnerId/audit`. Environment keys are recorded too, as `credential=env`.

Environment keys stay valid with every scope, so existing partners are never cut off. Moving a partner to a scoped key is a separate, authorized step.

## Legacy unmapped settlement for new partners (D-J14-3)

Unmapped payments (no `merchant.external_business_id`) settle to the platform settlement wallet (legacy, D23). **Default: unchanged.**

`PARTNER_LEGACY_SETTLEMENT_PARTNERS=<existing partners>`, for example `kebu,rect`, keeps the legacy path for those partners only. Any other (new) partner must send mapped payments; an unmapped one gets `400 merchant_required` and nothing is created.

The rule is applied at payment creation. A payment already created settles exactly as it was created, including a new partner's legacy payment from before the switch. `PARTNER_LEGACY_PLATFORM_SETTLEMENT=false` still closes the legacy path for everyone.

Before switching, run the read-only settlement reconciliation (`reconcilePartnerSettlements`). Each completed payment must be booked exactly once, through one confirmed operation and one `-CONFIRM` entry, to the account its target names:
- the business wallet, with one PaymentRecord;
- the partner's unallocated account;
- or the legacy settlement wallet.

Mapped and legacy payments never mix.

A new partner gets mapped merchants through the same consented link: the owner creates a one-time code naming that partner (`POST businesses/:id/os/integrations/link-code {system}`), and the partner redeems it with its key. A code for one partner is useless to another.

## Sandbox checklist

1. Set `JOKO_API_KEY`, `JOKO_WEBHOOK_SECRET`, `PUBLIC_APP_URL` on Joko  
2. Online: checkout → sandbox-complete → webhook paid  
3. POS: `/v1/pos/sessions` → open `qr_payload` → sandbox-complete  
4. Payout: `/v1/payouts` → sandbox-complete → webhook `type=payout`  
5. CS: register agent (Joko user phone) → open thread → assign → message  
6. Messaging: `/v1/messages/send` to a test phone  

## Status

| Slice | Capability | Status |
|---|---|---|
| 1 | Online accept + webhook + messages | Done |
| 2 | In-store POS / QR | Done |
| 3 | Partner payouts | Done |
| 4 | Mbolo Business CS agents | Done (API) |

In-app CS agent UI in the Joko Business hub is a follow-up; the Partner API is the E2E contract for Kebu/shops.

## Do not claim

Do not claim “works with Kebu live” until one real webhook round-trip against Kebu’s `/api/webhooks/joko` succeeds with matching secrets.
