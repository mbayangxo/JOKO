# P0 incident: legacy delivery-dispute ruling open to ordinary users

| State | Status |
|---|---|
| LOCAL CONTAINMENT | **DONE**: `948f2a6` (audit branch), regression test `tests/j8/p0-delivery-dispute.test.js` |
| PRODUCTION EXPOSURE ASSESSED | **DONE (read-only): LIKELY EXPOSED** (§3) |
| PRODUCTION PATCHED | **NO**: deployment recommended by the owner on 2026-10-08, conditional on verifying the serving Vercel deployment first. Verification **blocked**: the Vercel connector returns 403 for scope `mbayangxos-projects` (project `joko`), and no Vercel CLI is installed. The patch was **not** applied (§5). |
| HISTORICAL IMPACT ASSESSED | **NO, UNABLE TO DETERMINE**: no read access to the production database from this session; query set ready (§4) |
| REMEDIATION COMPLETE | **NO** |

## 1. What is wrong

**Route:** `POST /api/deliveries/:id/dispute/resolve` (`lib/handlers.js` → `deliveriesDisputeResolve`).
- It is registered as an ordinary **user** route (`auth: true`).
- Its only extra check is `if (process.env.ADMIN_API_KEY && header !== ADMIN_API_KEY)`.

**Root cause:** authorization depends on an optional shared secret and fails **open** when the secret is absent. No identity, role or permission check exists, and no audit record names the resolver.

**Authority affected:** ruling on a delivery dispute.
- `outcome=rider` pays the escrowed delivery fee to the courier.
- `outcome=customer` refunds the buyer and cancels the delivery.

**Financial consequence when `ADMIN_API_KEY` is unset:**
- **Courier wins against the buyer:** the courier marks a delivery done; if the buyer disputes, the courier rules for themselves and receives the escrowed fee.
- **Buyer takes back an earned fee:** after a genuine delivery, the buyer disputes (by direct API call; the live app has no dispute screen) and rules `customer`. The fee is refunded and the courier goes unpaid. **This needs no victim cooperation.**
- **Any signed-in stranger** can force either outcome on any open dispute.

**When the key is set:** anyone who holds the shared key can rule while using an ordinary user session, and no identity is attached to the ruling.

**Amount at stake per case:** one delivery fee (1,500–10,000 XOF in the live fee formula). This is money moved between two parties of one delivery, or taken from either of them. No money is created.

## 2. Reproduction

1. **Audit branch** (`tests/j8/p0-delivery-dispute.test.js`, history in `948f2a6`): a courier rules in their own favour on an open dispute: **HTTP 200**, the courier gains 150 ₭ (1,500 XOF).
2. **Live code** (`7d262de`, the latest successful production deployment), on a disposable database with the real handler:

| Live code | Result |
|---|---|
| as deployed, `ADMIN_API_KEY` unset | **200**, courier gained 150 ₭, escrow `released` |
| as deployed, key set, no header | 401, nothing moved |
| **patched**, key unset | 403 `operator_required`, escrow stays `disputed_held` |
| **patched**, key set | 403 `operator_required`, escrow stays `disputed_held` |

**Why the J3/J7 sweeps missed it:** the generic mutation-sweep body had no `outcome` field, so every attacker call stopped at validation (400) before reaching the money move, and a 400 counted as "refused". The fix to the sweep is tracked separately (validation refusals no longer count as authorization evidence).

## 3. Production exposure (read-only, authorized)

**Classification: LIKELY EXPOSED.**

**Evidence:**
- **The vulnerable code is live.** Per the GitHub deployment records for `mbayangxo/joko`, the latest **successful** Production deployment is `7d262de` (2026-07-17). Every later Production deployment record through 2026-08-03 is a failure. `7d262de` contains the route with the same fail-open logic, as does the default branch head `19ac203`.
  - Caveat: deployments made outside the GitHub integration (for example the Vercel CLI) would not appear in these records.
- **The route is reachable by any signed-in user.** `auth: true` only.
- **`ADMIN_API_KEY` state: UNABLE TO DETERMINE.**
  - The production environment cannot be read from this session: Vercel returned 403 for the project scope earlier, and the Vercel environment tools are not connected now.
  - The value was never requested.
- **What the configuration evidence shows:**
  - The key is documented as optional (commented out in `.env.example`).
  - Nothing in the live codebase sends `X-Admin-Key` to this route.
  - The live admin router mounts no admin routes. The only other shared-key check in mounted code (`lib/admin-handlers.js` via `legacyAdminKeyValid`) fails **closed**.
  - So there is no evidence that the key was ever configured for this route.
- **The two possible states:**
  - If the key is **absent:** any signed-in user can rule on any open dispute.
  - If it is **present:** exposure narrows to whoever holds the shared key, still without identity or audit.
- **Not claimed:** it is not claimed that no exploitation happened.

**Disputes currently exposed:** UNKNOWN (no database access). Query D in §4 lists them.

## 4. Historical use: read-only query set

`scripts/forensics/p0-delivery-dispute.sql` (`BEGIN TRANSACTION READ ONLY … ROLLBACK`; opaque ids only; validated on a disposable production-shaped database).

**Query sections:**
- **A.** Disputes by status.
- **B.** Resolved disputes: outcome, amount, resolver attribution (exact-path audit row, otherwise a **weak** ±10 s time correlation, otherwise UNKNOWN), resolver relationship (courier / buyer / unrelated / unknown) and assessment.
- **C.** Calls to the vulnerable path, and what shape of path the audit log records.
- **D.** Disputes still open or under review, so still exposed.

**Attribution limit:** the live route writes **no** resolver id. Live `ApiAuditLog` stores `req.url` without the query string. Behind the `/api?path=…` rewrite, that may record only `/api`, which would make path-based attribution impossible (query C shows which shape is recorded). Where attribution cannot be proven, the result is **UNKNOWN**, never a guess.

**Incident table:** not produced, because the queries have not been run on production (this needs database access the session does not have). Running them is read-only. **No reversal, debit or compensation** happens automatically: remediation is a separate, authorized J2 compensating-entry process after review.

## 5. Emergency patch package (deployment NOT authorized)

| Item | Value |
|---|---|
| Patch | `emergency-7d262de.patch` (sha256 prefix `a52648f78bf37b72`). One file, `lib/handlers.js`, +6 / −25: `deliveriesDisputeResolve` always returns `403 operator_required`. |
| Base | `7d262de` (last successful production build). Applies cleanly to the default branch head `19ac203` too, but that branch's production builds have failed since 2026-08. |
| Routes affected | `POST /api/deliveries/:id/dispute/resolve` only |
| Migration | **none** |
| Env / config change | **none** (do not add or remove `ADMIN_API_KEY` for this patch) |
| Build | live build command (`prisma generate` + `expo export --platform web`), **no database schema step**. Patched build: **ok**. |
| Tests | live suite on the patched tree: **122 / 122**. Before/after exploit probe on live code: §2 table. Audit branch: full suite **576 / 576** including the regression test. |
| Money invariant evidence | the patched handler moves no money (escrow stays `disputed_held`, both balances unchanged). Audit branch: J2 invariants after every test. |
| User-visible effect | none in the app (no screen calls this route). Direct API callers get 403. |
| Open disputes after the patch | **safe**: they stay `disputed_held`; the cron moves expired ones to `under_review`; auto-release skips disputed deliveries. Funds stay in escrow until an operator ruling path ships (on the audit branch: `POST admin/deliveries/:id/dispute/resolve`, J3 `deliveries.disputes.resolve`). |
| Historical remediation | unknown until §4 is run |
| Rollback | redeploy / promote the existing `7d262de` production deployment (restores the vulnerable behaviour; only for a severe regression). |

**Verify immediately after deploy** (read-only, or with a test account you own):
1. Production build id = patched commit.
2. `POST /api/deliveries/<any id>/dispute/resolve` with a test user session → **403 `operator_required`**.
3. `GET /api/health` → ok.
4. The courier flow (`accept` / `pickup` / `deliver` / `confirm`) still works for a test delivery.
5. Run §4 queries A and D read-only to confirm no dispute changed state after the deploy.

## 6. Shared-key pattern inventory (code only; no secret values)

| Location | Pattern | Reachable? | Status |
|---|---|---|---|
| live `lib/handlers.js` `deliveriesDisputeResolve` | `if (KEY && header !== KEY)`, fail-**open** | **yes** (user route) | **this P0** |
| live `lib/handlers.js` `requireAdmin` (held transactions list / approve / reject) | same fail-open pattern | **not mounted** in the live router | latent; not reachable in `7d262de`; removed on the audit branch |
| live `lib/admin-auth.js` `legacyAdminKeyValid` + `lib/admin-handlers.js` `assertAdminAccess` | shared key, fail-**closed** (`KEY && header === KEY`) | admin routes **not mounted** in the live router | legacy-dangerous design (unattributable); retired on the audit branch (J3: authorizes nothing) |
| audit branch (`HEAD`) | any `ADMIN_API_KEY` / `x-admin-key` authorization | — | none: `legacyAdminKeyValid()` returns false; admin routes refuse a shared key (`legacy_admin_key_retired`); no user route reads `ADMIN_API_KEY` any more (the last one was this P0, fixed in `948f2a6`) |

No other reachable money-moving route with this bypass was found in the live code.

## 7. Deployment verification log

| When | Check | Result |
|---|---|---|
| 2026-10-08 | Vercel `list_deployments` (project `prj_lOUwSQp2PPi8Bhe1tA1jjrKXdiYt`, target production) | **403 forbidden** for scope `mbayangxos-projects`; the connector's token has no team access (`list_teams` returns none) |
| 2026-10-08 | Vercel CLI | not installed in this session |

| 2026-10-08 (after the owner's written deployment authorization) | Vercel `list_teams` / `get_project` (`prj_lOUwSQp2PPi8Bhe1tA1jjrKXdiYt`, team `team_DuHLYw71m5ATHKdtGSur1Diw`) | `list_teams` returns no teams; `get_project` **403 forbidden** for scope `mbayangxos-projects`. **Deployment authorized but NOT performed**: the live deployment cannot be verified (authorization step 1). |

**Needed before deployment:**
1. Reconnect the Vercel connector with access to the `mbayangxos-projects` team.
2. Confirm which deployment serves production (expected `7d262de`).
3. Then deploy `7d262de` + `emergency-7d262de.patch` as one commit, and run the §5 verification steps.

## 8. Deployment-base warning (found 2026-10-08, during J8 browser testing)

**Do not apply the emergency patch on the default branch head `19ac203`.**

- On that head, `src/navigation/RootNavigator.js` uses `GiftRevealScreen` without importing it. The bug was introduced in `494991d` (2026-08-02).
- The app throws `ReferenceError` on first render and shows a **blank screen** for every user, on web and native alike.
- Production deployments from that branch all failed after `7d262de`, so the live build (`7d262de`, 2026-07-17) does **not** contain the bug.
- The patch package's recommended base, **`7d262de`**, remains correct. Applying the patch on `19ac203` would ship a blank app.
- Fixed on the audit branch (one-line import). This does not change any state of the incident.
