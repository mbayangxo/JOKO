import { reference } from '../../api/_lib/auth.js';
import { prisma } from '../prisma.js';
import { assertBusinessAuthorityInTx, OrgAccessError } from '../business-access.js';
import { notifyEvent } from '../community/notify.js';
import { CollectiveError, assertEnabled } from './contract.js';

/**
 * J11 model E — cooperative member capital as RECORDS ONLY (Japalante, Jëm Kanam, IAWIC and others).
 *  - Nothing here moves money, issues shares or securities, or computes dividends.
 *  - Kinds keep different things apart: member capital, gifts, loans, wage references.
 *    Investment returns are refused while model F (regulated investments) is not licensed.
 *  - A coop administrator (business.admin) records; the member confirms or disputes their own line.
 *    Records are append-only in the database: a correction is a new record.
 */
export const KINDS = {
  member_capital: ['in', 'out'], // paid in by the member / returned to the member under the statutes
  gift: ['in'], // a donation to the coop: no claim
  loan: ['in', 'out'], // member lends to the coop / the coop repays
  wage_reference: ['out'], // pointer to wages paid through payroll (never capital)
};
export const DISCLAIMER = 'Registre seulement : aucune part sociale, aucun titre, aucun dividende et aucun rendement ne sont calculés ou promis par K21.';

export async function recordEntry(actorId, businessId, b) {
  assertEnabled();
  if (b.kind === 'investment_return') throw new CollectiveError('not_licensed', 'Les rendements d’investissement ne peuvent pas être enregistrés : activité non autorisée sans licence', 409);
  if (!KINDS[b.kind] || !KINDS[b.kind].includes(b.direction)) throw new CollectiveError('invalid', 'Type ou sens invalide', 400);
  if (!Number.isSafeInteger(b.amountXof) || b.amountXof < 1 || b.amountXof > 1_000_000_000) throw new CollectiveError('invalid_amount', 'Montant invalide', 400);
  const occurredOn = new Date(b.occurredOn);
  if (Number.isNaN(occurredOn.getTime()) || occurredOn > new Date()) throw new CollectiveError('invalid', 'Date invalide', 400);
  return prisma.$transaction(async (tx) => {
    const biz = await tx.business.findUnique({ where: { id: String(businessId) }, select: { id: true, type: true, name: true } });
    if (!biz) throw new CollectiveError('not_found', 'Coopérative introuvable', 404);
    try {
      await assertBusinessAuthorityInTx(tx, actorId, biz.id, 'business.admin');
    } catch (e) {
      if (e instanceof OrgAccessError) throw new CollectiveError('not_found', 'Coopérative introuvable', 404);
      throw e;
    }
    if (biz.type !== 'cooperative') throw new CollectiveError('not_cooperative', 'Registre réservé aux coopératives', 409);
    const h = String(b.memberHandle).replace(/^@/, '');
    const member = await tx.user.findFirst({ where: { handle: { in: [h, `@${h}`] } }, select: { id: true } });
    if (!member) throw new CollectiveError('not_found', 'Membre introuvable', 404);
    const row = await tx.coopCapitalRecord.create({
      data: {
        businessId: biz.id, memberUserId: member.id, kind: b.kind, direction: b.direction, amountXof: b.amountXof, occurredOn,
        note: b.note ? String(b.note).slice(0, 500) : null, evidenceRef: b.evidenceRef ? String(b.evidenceRef).slice(0, 200) : null, recordedBy: actorId, reference: reference('COOPR'),
      },
    });
    await notifyEvent(tx, member.id, { category: 'money', kind: 'coop_record', refId: row.id, title: 'Nouvelle ligne à vérifier', body: `${biz.name} a enregistré une ligne à ton nom. Confirme-la ou conteste-la. ${DISCLAIMER}`, dedupeKey: `coop:${row.id}` });
    return row;
  });
}

/** The member confirms or disputes their own line, once. */
export async function memberRespond(recordId, userId, { confirm, note = null }) {
  assertEnabled();
  const r = await prisma.coopCapitalRecord.findUnique({ where: { id: String(recordId) } });
  if (!r || r.memberUserId !== userId) throw new CollectiveError('not_found', 'Ligne introuvable', 404);
  if (r.memberConfirmedAt || r.memberDisputedAt) return { ...r, replayed: true };
  return prisma.coopCapitalRecord.update({ where: { id: r.id }, data: confirm ? { memberConfirmedAt: new Date(), memberNote: note } : { memberDisputedAt: new Date(), memberNote: note } });
}

function totals(rows) {
  const t = {};
  for (const r of rows) {
    const k = (t[r.kind] ??= { inXof: 0, outXof: 0, unconfirmed: 0, disputed: 0 });
    k[r.direction === 'in' ? 'inXof' : 'outXof'] += r.amountXof;
    if (r.memberDisputedAt) k.disputed += 1;
    else if (!r.memberConfirmedAt) k.unconfirmed += 1;
  }
  return t;
}
const line = (r) => ({ id: r.id, kind: r.kind, direction: r.direction, amountXof: r.amountXof, occurredOn: r.occurredOn.toISOString(), note: r.note, confirmed: Boolean(r.memberConfirmedAt), disputed: Boolean(r.memberDisputedAt), reference: r.reference });

export async function memberStatement(userId) {
  assertEnabled();
  const rows = await prisma.coopCapitalRecord.findMany({ where: { memberUserId: userId }, orderBy: { occurredOn: 'asc' } });
  const bizIds = [...new Set(rows.map((r) => r.businessId))];
  const names = new Map((await prisma.business.findMany({ where: { id: { in: bizIds } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
  return { disclaimer: DISCLAIMER, coops: bizIds.map((id) => ({ businessId: id, name: names.get(id), totals: totals(rows.filter((r) => r.businessId === id)), lines: rows.filter((r) => r.businessId === id).map(line) })) };
}

export async function coopRegister(actorId, businessId) {
  assertEnabled();
  return prisma.$transaction(async (tx) => {
    try {
      await assertBusinessAuthorityInTx(tx, actorId, String(businessId), 'business.admin');
    } catch (e) {
      if (e instanceof OrgAccessError) throw new CollectiveError('not_found', 'Coopérative introuvable', 404);
      throw e;
    }
    const rows = await tx.coopCapitalRecord.findMany({ where: { businessId: String(businessId) }, orderBy: { occurredOn: 'asc' } });
    const users = new Map((await tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.memberUserId))] } }, select: { id: true, handle: true, name: true } })).map((u) => [u.id, u]));
    const byMember = [...new Set(rows.map((r) => r.memberUserId))].map((m) => ({ member: { handle: users.get(m)?.handle, name: users.get(m)?.name }, totals: totals(rows.filter((r) => r.memberUserId === m)) }));
    return { disclaimer: DISCLAIMER, members: byMember, lines: rows.map((r) => ({ ...line(r), member: users.get(r.memberUserId)?.handle })) };
  });
}
