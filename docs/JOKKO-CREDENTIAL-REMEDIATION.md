# Jokko — credential remediation runbook (Mboolo user-record exposure)

**Status:** capability built and tested. **NOT executed in production**, and no notification sent. Production exposure is still unmeasured (read-only access unavailable).

## 1. What was exposed

Until commit `397e89a`, `GET /api/mbolo/threads`, `POST /api/mbolo/threads`, add-members, invite and join-by-invite returned each thread member's **full User row**:
- `pinHash` and `passwordHash` (bcrypt);
- `cniNumberEnc` and `cniHash`;
- email, phone, date of birth.

Anyone could open a direct thread with any public handle. A 6-digit PIN has only 10⁶ possibilities, so its bcrypt hash is **crackable offline**. Exposed PINs are therefore treated as compromised. Rotation is not optional for confirmed exposure.

## 2. Classification (read-only, `scripts/forensics/production-exposure.sql` §16)

| Class | Definition | Action |
|---|---|---|
| **A — confirmed exposed** | Had a PIN or password hash, and shared a thread with another user who made a leaking request (thread list, create, members, invite, join) while both were members. Evidence: `ApiAuditLog`. | Invalidate PIN + password, revoke all sessions, forced re-establishment, notify (§5). |
| **B — potentially exposed** | Shared a thread with someone, but there is no audit evidence of a leaking read (log gaps or rotation). | Same technical remediation as A: an offline-cracked PIN isn't bound to any session, so there is no safe partial option. Notification wording differs (§5). |
| **C — no evidence** | Never shared a thread with another user. | No action. |

Caveat: the PIN hash present today may have been set after the read, so class A is conservative.

## 3. Procedure (only after the exposure query has run and been reviewed)

1. Snapshot first. Run the read-only pack and save §16 output as `class-a.txt` / `class-b.txt` (ids only).
2. Dry run (default):
   ```bash
   DATABASE_URL=… node scripts/forensics/remediate-credentials.mjs --ids class-a.txt --class A
   ```
   This prints counts only: found, PINs/passwords to invalidate, sessions to revoke.
3. Two-person review of the dry-run output.
4. Execute (refuses without every flag; non-local DBs require the exact host):
   ```bash
   DATABASE_URL=… OPERATOR_ID=<staff id> node scripts/forensics/remediate-credentials.mjs \
     --ids class-a.txt --class A --execute --reason "mbolo-leak-2026-10" \
     --i-understand-this-revokes-sessions --confirm-production <db host>
   ```
   Single accounts (e.g. via support) use `POST /api/admin/users/:id/credentials/invalidate`. It needs an admin session with TOTP and is audited.
5. Verify: `SELECT type, COUNT(*) FROM "CredentialSecurityEvent" GROUP BY 1;`. Rerun §16. Class A accounts should now have `pinHash IS NULL`.

## 4. What remediation does (and does not) do

For each account:
- **`pinHash` and `passwordHash` set to null.** The exposed credentials can never be used again.
- **`credentialResetRequiredAt` set.** The risk gate holds every outbound money movement for review until a new PIN exists.
- **Sessions revoked:**
  - all refresh tokens are revoked;
  - access tokens issued before `sessionsRevokedAt` are rejected (exact to the millisecond for new tokens).
- **Re-establishment requires a fresh OTP login** (SMS or verified email) made **after** the reset was flagged. A session from before the reset can't set a new PIN or password (`reverification_required`). Password logins never count as OTP verification.
- **On the new PIN:** the reset clears and a **24h cool-off** starts on outbound money, the same as an access recovery.
- **Audit:** every step writes an append-only `CredentialSecurityEvent` row (type, actor, reason, class). It never stores PINs, passwords, hashes, OTPs or reset secrets, and the server logs contain none either (tested).

**It is not a new takeover path:**
- Re-establishment uses the same OTP flow as login: 5-attempt limit, per-IP and per-phone rate limits, no OTP disclosure in production.
- Recovery never attaches an email.
- Password login answers identically for "invalidated", "wrong" and "unknown account".
- Changing an existing PIN now requires the current PIN.

**App behaviour:**
- The user is signed out (sessions revoked) and logs in with an OTP.
- The PIN gate gets `pin_not_set` and shows "Pour ta sécurité, choisis un nouveau code PIN."
- `GET /api/me` returns `credentialResetRequired` and `pinSet`.

## 5. User notification — PREPARED, NOT SENT

Send only after production exposure is confirmed and the remediation has executed. Channels: in-app notification + SMS (+ email if verified). Never include links that ask for a PIN, the PIN itself, or any account detail.

**Class A (FR):**
> **Joko — sécurité de ton compte.** Nous avons corrigé un problème qui pouvait exposer des informations techniques de connexion de certains comptes. Par précaution, ton code PIN et ton mot de passe ont été désactivés et tes sessions fermées. Reconnecte-toi avec le code reçu par SMS, puis choisis un nouveau PIN. Pendant 24 h, les envois d'argent sont vérifiés. Joko ne te demandera jamais ton PIN par message ou par téléphone.

**Class A (EN):**
> **Joko — account security.** We fixed an issue that could expose technical sign-in information for some accounts. As a precaution we disabled your PIN and password and signed you out. Sign in with the code we text you, then choose a new PIN. For 24 hours, outgoing payments are reviewed. Joko will never ask for your PIN by message or phone.

**Class B:** same text with "pouvait potentiellement exposer" / "may have exposed".

**Also required if confirmed:**
- **Regulatory/partner disclosure:** assess the notification duty under Senegal's personal-data law (Loi n° 2008-12, CDP) and any BCEAO/partner obligations, since phone, email, date of birth and CNI-derived fields were exposed.
- **Support script and FAQ** ready before sending. Agents must never ask for PINs or OTPs.
- **Watch for social-engineering attempts:** exposed phone numbers and emails enable phishing. The SMS should warn about it, as above.

## 6. Not done (needs a decision or production access)

- Running §16 on production. **BLOCKED**: no read-only access.
- Executing remediation and sending notifications. **Waiting** on the exposure result.
- Re-encrypting / rotating `DATA_ENCRYPTION_KEY` for `cniNumberEnc`. The ciphertext was exposed but the key was not, so this is **not required** unless the key is suspected leaked.
