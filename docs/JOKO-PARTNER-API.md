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
