# Jokko: legacy schema (preserved, never dropped)

**Decision (2026-10-03):** preserve, do not drop. Until production can be read, assume these tables and columns hold real data or represent functionality Jokko still needs.

| Source of truth | Status |
|---|---|
| Shape | `prisma/migrations/0_baseline/migration.sql`. Commit `5d97adc`, 2026-08-17: "Captures the current Postgres schema … against production". |
| Production contents | **UNKNOWN** (no read access). Exposure pack §17 counts rows and non-null values. |
| How preserved | All 9 tables are back in `prisma/schema.prisma` with their exact introspected shape: same columns, defaults, indexes, unique constraints, FKs and ON DELETE actions. All 17 columns are restored on their models. |
| Proof | `prisma migrate diff` from a database built from the baseline → current schema contains **0** `DROP TABLE`, `DROP COLUMN`, type changes or `SET NOT NULL`. Every dropped FK is re-added (J1's CASCADE→RESTRICT swaps). The deploy guard (`scripts/db-sync-deploy.mjs`) stays as a second barrier. |

No current server code reads or writes any of these, except the Ñu Lekk UI, which is a "coming soon" shell. They are inert, which is exactly why they must not be dropped blindly.

---

## 1. Tables

| Table | Apparent purpose (from shape + naming) | Value it carries | Code references today | Roadmap mapping |
|---|---|---|---|---|
| `KebuInvestment` | A user invests ₭ in a business's offering on Kebu (`amountKori`, `status` active/…, unique `reference`) | **Money: ₭ committed by investors.** Could be an outstanding claim (investor → business). | None | Kebu/business funding. Not in the current Jokko roadmap; the regulatory doc warns against investment products. **Needs a regulatory decision.** |
| `KebuInvestmentOffering` | A business raises funds: `targetKori`, `raisedKori`, min/max ticket, `dividendBps` (default 5%), `status` open/… | Money totals (raised ₭) | None | As above |
| `KebuInvestmentPayout` | A dividend paid on an investment (`amountKori`, unique `reference`) | **Money: ₭ paid to investors** (a mint or a transfer from the business, unknown which) | None | As above |
| `KoriRedemption` | A user spends ₭ on a business reward offer (`costKori`, unique `reference`) | **Money: ₭ burned or transferred to the business** | None | Kori rewards / loyalty (J2 funded-incentives model) |
| `KoriRedemptionOffer` | Business reward catalog priced in ₭ (`costKori`, `inventory`, `category` reward) | Price list | None | Loyalty / rewards marketplace |
| `MerchantPromo` | Merchant promotions: percent (`percentBps`), fixed (`fixedOffKori`), buy-X-get-Y (`triggerProductId`, `buyQty`, `freeProductId`, `freeQty`), min order, use limits, online/in-person, code | Discount rules | None | Commerce promotions (future commerce phase) |
| `MerchantPromoUse` | One use of a promo (`discountKori` granted, `orderId`, `channel`) | **Money-like: discount granted per order.** Whoever funds the discount is a ledger question. | None | Commerce promotions |
| `NuLekkSplit` | "Ñu Lekk" (Wolof: "we eat") bill split: `totalKori`, optional `businessId` payee, status open → funded (`fundedAt`) | **Money: pooled ₭** | UI shell `src/screens/NuLekkScreen.js`, behind `comingSoon.nuLekk` in `lib/platform-config.js` and `src/lib/platform-features.js`. No API. | Group payments / bill split (roadmap: "coming soon") |
| `NuLekkShare` | One participant's share (`amountKori`, status pending → paid, `paidAt`) | **Money: ₭ owed or paid per participant** | None (server) | As above |
| `TontineContribution` (legacy shape) | Pre-run-3 automatic tontine collection rows (`cycleKey`, `amountKori`). The model the forensic audit proved could **drain wallets without consent**. | **Money: forensic evidence of debits** | Now `LegacyTontineContribution` in Prisma (`@@map("TontineContribution")`). The escrow model moved to a new table, `TontineCycleContribution`. | Tontine (replaced by the run-3 escrow model). **Victim restitution input** (exposure pack §10). |

## 2. Columns

| Column | Apparent purpose | Code references | Roadmap |
|---|---|---|---|
| `DeliveryTask.proofRecipientUserId`, `proofRecipientHandle`, `proofScannedPayload`, `proofSignatureUrl`, `proofPhotoUrl`, `proofLat`, `proofLng`, `proofSubmittedAt` | Proof of delivery: recipient identity / QR scan, signature, photo, GPS, time | None. `docs/K21-TRADE-PORTAL.md` lists "Proof of delivery" as planned. | Delivery/trade (PoD). Strongly wanted: it is dispute evidence for escrow release. |
| `Order.subtotalKori`, `discountKori` (default 0), `promoId`, `promoCode` | Pre-discount subtotal, discount, promo link | None | Commerce promotions |
| `OrderItem.isPromoFree` (default false), `promoId` | A free item granted by buy-X-get-Y | None | Commerce promotions |
| `SolidarityCampaign.kind` (default `'jekkal'`, indexed with `status`) | Campaign type discriminator (jekkal vs other kinds) | None (all campaigns are jekkal today) | Solidarity campaigns |
| `TontineContribution.cycleKey` | Cycle identifier of the legacy auto-collection | Legacy model only | Evidence |
| `User.afriClass` (indexed) | Classification paired with `afriId` (probably a user segment/class of the AfriID) | None | Identity (AfriID) |

## 3. Migration implications

1. **Additive only.** J2 migrations never drop or narrow these. A future removal needs all of:
   - the exposure pack §17 result showing zero rows (or an archive);
   - an export/archive of the rows;
   - a product decision;
   - a dedicated reviewed migration.
2. **Money-bearing legacy tables need the J2 opening reconciliation.** If production has rows in `KebuInvestment`, `KebuInvestmentPayout`, `KoriRedemption`, `NuLekkShare`/`NuLekkSplit` or `MerchantPromoUse`, the ₭ they mention may be:
   - outstanding obligations (investments, unfunded split shares);
   - or past mints/burns that explain wallet balances.

   The J2 opening-balance migration therefore:
   - posts **no** entries for them until they are inspected;
   - reports them separately in the reconciliation ("legacy, uninspected");
   - books any confirmed outstanding obligation to an explicit account (`legacy:kebu_investment:{id}` …) through a reviewed `opening_balance` entry, never by guessing.
3. **Name collision fixed non-destructively.** Run 3 reused the table name `TontineContribution` with an incompatible shape (`cycle INT NOT NULL`, no `cycleKey`). On a production DB with rows, that ALTER would have **failed** (NOT NULL without default) or forced data loss. The escrow model now maps to `TontineCycleContribution`, and the legacy table is untouched.
4. **FK behaviour preserved exactly**, including `ON DELETE CASCADE` on legacy money tables. Deleting a user would cascade-delete their legacy investment and redemption history. J1's RESTRICT policy should extend to these in a later reviewed, non-destructive migration (changing the FK action loses no data). It is intentionally **not** done now, so preserved means byte-identical.
5. **Restored FK `DeliveryTask_buyerId_fkey`** (RESTRICT). The current schema had silently dropped this relation; it exists in production.
6. Other production-shape risks seen in the same diff, which a rehearsal must confirm:
   - new UNIQUE indexes on existing tables (`MboloThread.inviteCode`, `MboloMessage.mediaAssetId`) fail if production has duplicates. Exposure pack §17 will be extended if the rehearsal shows a need.
   - All other changes are new tables, nullable or defaulted columns, and FK action swaps.
