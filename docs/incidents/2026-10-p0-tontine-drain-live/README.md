# P0: tontine wallet drain is LIVE in the production deployment (`7d262de`)

**Status: OPEN in production. STOP condition (theft-capable).** Found at the start of J11, during the J11.0 audit. A fail-closed containment patch is ready and tested **locally only**. **Nothing has been deployed.**

**Owner action:** authorize, through verified access only, a containment deploy on `7d262de`, sequenced with the open delivery-dispute P0. Then run the read-only exposure queries and decide on restitution.

## 1. What is wrong
On `7d262de`, the latest successful production deployment:
1. **No consent.** `POST /api/tontine/groups` adds **any handle** as a member. There is no invitation and no acceptance step.
2. **Release at will.** `POST /api/tontine/groups/:id/release` is allowed for the creator at any time. It debits **every** listed member's national wallet by `amountPerMember`.
3. **The pot is the creator's personal wallet.** Contributions go into the creator's own wallet (`tontine_pot_in`). The rotation-0 "payout" goes to the creator too, who is listed first.
4. **The cron does the same automatically.** The daily `/api/cron/daily` → `tontine_processor` collects from every member of every active group.

This is finding **P0-15** from the forensic audit, proven on `19ac203` (60 000 ₭ in one call). On the J1 branch it was contained and later replaced by the consent + escrow model (task #2). **That containment was never deployed**: `7d262de` predates it. No earlier report listed this P0 as live in production. The open incidents were the delivery-dispute P0, F1 and F4.

## 2. Reproduction on the real `7d262de` code (local, disposable database)
`repro-tontine-drain.test.js`, run with the production handlers:
- A creator with 0 lists two strangers who hold 50 000 each, with `amountPerMember` 20 000, then calls **release**.
- **Result: each stranger is debited −20 000; the creator gains +40 000.** Status 200, three members "added", no consent step.

## 3. Containment patch (minimal, fail-closed)
File: `tontine-containment-on-7d262de.patch`. 2 files, +13 / −1, on `7d262de`, with **no schema change, no migration and no environment change**.
- `lib/tontine-service.js`: `processTontineGroup` refuses with **503 `tontine_suspended`** ("no debit is made").
- `lib/cron/tontine-processor.js`: the daily job **skips** the collection.
- Records are preserved: groups, memberships and the old ledger are untouched.

Evidence (local):

| Check | Result |
|---|---|
| `tontine-drain-contained.test.js` | release → 503; cron skipped; balances unchanged (0 / 50 000 / 50 000); 3 memberships preserved |
| The reproduction rerun with the patch | release 503; every delta 0 |
| `7d262de` full suite (`npm test`) with the patch | **122 / 122** |

**This patch is separate** from the delivery-dispute P0 patch and from F1. Each ships as its own reviewed deploy. All are built on `7d262de`, never on `19ac203`.

## 4. Deploy plan (only with verified access and explicit authorization)
1. Verify the deploy identity: the latest successful production deployment is `7d262de`.
2. Run the read-only exposure queries **first** and record the baseline (§6).
3. Deploy a branch from `7d262de` plus this patch: preview first, then production. **No environment change.**
4. Sequencing with the delivery-dispute P0 patch is the owner's call. Both are small and fail-closed, and they touch different files.

## 5. Post-deploy verification
1. As a test account in preview, call `POST /api/tontine/groups/:id/release` → expect **503 `tontine_suspended`**. Check that no `tontine_contribution` ledger row was created.
2. After the next daily cron: no new `tontine_contribution` / `tontine_pot_in` rows (query §6).
3. Watch the logs for `tontine_suspended`. These are expected user attempts and should be shown with a clear message in the app.

## 6. Exposure (read-only) and remediation
Use `scripts/forensics/production-exposure.sql` **§10**. It lists every old auto-collection: who was debited, how much went from others into creators' personal wallets, and the payouts. Run it inside a read-only transaction.

**Restitution is a finance and legal decision.**
- Never debit a creator automatically.
- Any reversal is a reviewed, consented, audited adjustment.
- Some groups may have been genuine, consenting tontines run outside the app; the data cannot tell. Case review is needed.

## 7. Rollback / forward-fix
- **Rollback:** redeploying `7d262de` re-opens the drain. Do not roll back except for an outage, and then re-contain immediately.
- **Forward-fix:** the replacement is J11's consent + escrow tontine engine. It stays OFF in production until approved, together with a **separately approved migration plan** for any live groups. Live tontines are not migrated or replaced by this patch.

## 8. Effect on J11
J11 feature work **stopped** under the stop rule when this was confirmed. It resumes only on the owner's instruction. The legacy model's live state must be settled first anyway (J11.0, one tontine model).
