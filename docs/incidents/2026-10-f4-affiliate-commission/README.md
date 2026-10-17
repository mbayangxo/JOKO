# F4: affiliate commission integrity (refund-aware lifecycle, A4)

**Status:** **NOT live in the current production deployment. Latent on the default branch.** A refund-aware lifecycle exists locally and is **inactive by default** (`AFFILIATE_DEFERRED_SETTLEMENT` is unset). Nothing is deployed. Turning it on needs owner approval (P-J9-4).

## 1. Deploy identity (correction)
The J9 audit described F4 as "live". That is **wrong for the latest successful production deployment**:

| Commit | Role | Affiliate code |
|---|---|---|
| `7d262de` | latest **successful** production deployment (P0 incident §8) | **none**: no `AffiliateCommission` table, no routes, no `lib/affiliate-*` (checked with `git grep`) |
| `494991d` | introduces the affiliate programme | added here |
| `19ac203` | default-branch head (all later production deployments failed) | **present**: immediate 5 % commission at purchase |

**Consequence:** F4 becomes live the moment any commit containing `494991d` is deployed, including a redeploy of `19ac203`. This is one more reason the P0 and F1 patches must be deployed **on `7d262de`**. A decision on F4 is needed **before** any deploy of the default branch or later.

Query 0 of `exposure.sql` confirms this per database: on a `7d262de` database it returns `NULL`, and the rest does not apply.

## 2. The legacy behaviour (19ac203 and later, `settlementMode = immediate`)
- **At purchase:** the buyer's payment is split. The commission (`commissionBps`, default 5 %) goes straight to the affiliate's wallet in the same entry.
- **Cancel or refund:** current code refuses to refund a split payment automatically (`refund_unsupported`: "Paiement partagé (commission)"), so support has to handle it. On `19ac203` no refund path reverses the commission.
- **Abuse:** a second account can farm commissions. There is no check for self-purchase, affiliate–merchant collusion or velocity.

## 3. The refund-aware lifecycle (deferred mode, local only)
Code: `lib/affiliate-settlement.js`. It is wired into `placeMarketplaceOrder` and `refundOrderPayment` and gated by `AFFILIATE_DEFERRED_SETTLEMENT=true`.

| Stage | Money (J2 kernel, atomic) | Row |
|---|---|---|
| Purchase + provisional attribution | buyer → merchant in full; in the **same** transaction, commission merchant → `escrow:affiliate:<id>` | `provisional`, `deferred` |
| Payment confirmed | only `payNow` orders are attributed (credit / invoice orders get no commission) | |
| Settlement window | starts the first time the job sees the order `delivered` / `completed`; default 7 days | `completedSeenAt`, `eligibleAt` |
| Earned | escrow → `affiliate:<user>:earnings`, scaled by the share **not** refunded; the rest goes back to the merchant | `earned`, `earnedKori`, `reversedKori` |
| Payable / paid | the affiliate moves earned commission to their wallet: `POST /api/affiliate/earnings/payout`, idempotent per key, rows under review excluded | `paid`, `payoutReference` |
| Cancelled or fully refunded **before** earning | inside the cancel or refund transaction the escrow goes back to the merchant **first**, so the merchant can always refund | `reversed` |
| Refunded **after** earning | **no clawback**; the merchant bears the refund | `reviewReason = refunded_after_earned`; payout held for a reviewed decision |
| Order never completes (60 days) | stays in escrow | `review`, `order_not_completed` |

- **Scope (deferred mode):** marketplace (B2C) orders only; B2B / KEBU supplier orders get no attribution.
- **Fraud controls (deferred mode):** no commission when the affiliate is the buyer, owns the business, or is an active member of it; at most 3 attributions per affiliate × buyer in 24 h; one commission per order.
- **Chargebacks:** the Kori closed loop has no card chargeback. An external-rail reversal reaches the order as a refund and follows the same rules.
- **Invariants** (`checkAffiliateInvariants`):
  - A1: each deferred escrow holds exactly its provisional amount.
  - A2: each earnings account equals its earned, unpaid commissions.
  - The J2 money invariants also hold.
- **Historical records:** immediate-mode rows are never modified. The new columns are additive and nullable, or default to `immediate` / `0`.
- **Cron:** `/api/cron/affiliate-settlement` (cron secret). It is a no-op while the flag is off and is **not** added to `vercel.json`.

## 4. Evidence (local)
`tests/j9/affiliate-settlement.test.js`: **7/7**.

| Test | Shows |
|---|---|
| Lifecycle | nothing paid at purchase; escrow equals the commission; not eligible before completion; earned after the window; paid once; same key replays; a new key pays 0 |
| Cancel | reversed inside the cancellation; the affiliate gets 0 |
| Full refund, then refund after earning | reversed before the window; after earning, flagged, not debited, and not paid out |
| Fraud | a member of the business gets no commission; the 4th attribution in 24 h is refused |
| Legacy | with the flag off, behaviour is unchanged (paid at purchase, `immediate`) |
| Partial refund | 50 % refund gives 50 % earned and 50 % back to the merchant; earned + reversed = amount |
| Races | 3 concurrent settlement jobs earn once; 3 concurrent payouts with different keys pay once; a refund racing the job ends `reversed` or flagged, never both |

Each test also checks the A1/A2 and J2 invariants.

## 5. Exposure analysis (read-only)
File: `exposure.sql`. It runs inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`, with opaque ids and sums only (buyer ids are hashed).

| Query | Finds |
|---|---|
| 0 | whether the feature exists in this database |
| 1 | total immediate commissions |
| 2 | commissions kept on cancelled / refunded orders |
| 3 | partial refunds |
| 4 | self-dealing (buyer, owner, member) |
| 5 | velocity pairs |
| 6 | duplicates per order |
| 7 | per-affiliate review list |

Validated on the local pilot database: it ran clean, and query 2 detected a cancelled order inside a rolled-back test transaction.

**Remediation of anything found is a finance decision.** Never debit an affiliate automatically.

## 6. Activation (needs explicit approval, P-J9-4)
1. Owner decision: the commission rate, window length, velocity cap, and who bears a refund after earning (today: the merchant).
2. Apply migration `20261018000000_affiliate_settlement` (additive) with the normal release. It does not by itself change behaviour.
3. Set `AFFILIATE_DEFERRED_SETTLEMENT=true` in **preview** only, run the pilot, then decide on production. Add the cron entry at that point.
4. **Rollback:** unset the flag. New orders go back to immediate mode. Provisional rows keep settling through the cron: either leave the cron on until the escrows are empty, or reverse them to the merchant.
