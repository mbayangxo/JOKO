# Operational notice: temporary suspension of tontine collections (draft, for owner approval)

**Status:** draft. It is published only when the containment patch is deployed.

## In-app / support message (French)
> **Tontines : pause de sécurité temporaire.**
> Pour protéger votre argent, les prélèvements et les versements automatiques des tontines sont suspendus pendant que nous mettons en place une nouvelle tontine où **chaque membre accepte les règles et chaque cotisation**.
> **Aucun prélèvement n'est effectué pendant la pause.** Vos groupes et l'historique de vos cotisations sont conservés.
> Si votre tour de versement était prévu pendant cette période, ou si vous pensez avoir été prélevé sans votre accord, contactez le support K21 : votre dossier sera examiné individuellement.

## Support script (internal)
1. **Never promise a date or a refund.** Say that the case is recorded for review.
2. **Collect:** the account handle, the group name, the approximate dates, and whether the person had agreed to join the group. Never ask for a PIN or an OTP.
3. **Open a case** tagged `tontine-p0`. The finance/legal review uses the read-only exposure report (`historical-tontine-exposure.sql`).
4. **Never move money manually.** Any correction is a reviewed, audited adjustment decided by finance/legal.
5. **If someone says they are owed a payout** in a group they really joined: the record of who paid what is preserved; review it with the same case process.
