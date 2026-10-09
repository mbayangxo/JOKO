import { reference } from '../../api/_lib/auth.js';
import { prisma } from '../prisma.js';
import { InsufficientFundsError, lockWallets, runMoneyTransaction } from '../wallet-atomic.js';
import { account, business as businessAccount, customer, move } from '../money-kernel/flows.js';
import { ensureBusinessWallet } from '../business-wallet-service.js';
import { notifyEvent } from '../community/notify.js';
import { CollectiveError } from './contract.js';

/**
 * J11 model C (protected PROJECT: milestone release) and model D-protected (Jekkal protected CAMPAIGN:
 * all-or-nothing). DORMANT: everything refuses unless JOKKO_PROTECTED_FUNDS_ENABLED=true.
 *
 *  - The recipient is VERIFIED (user KYC tier ≥ 2 and not frozen, or a verified active business) and consents.
 *  - Contributions sit in J2 `protected:<id>:escrow` — never in the organizer's or recipient's wallet.
 *  - Project milestones are approved by independent approvers (never the organizer or the recipient).
 *    An approval NEVER moves money: each release is a separate J3 maker/checker settlement
 *    (collective_ops requests, a finance operator executes), re-checking the recipient at that moment.
 *  - Deadline missed → the fund fails and every contribution is refunded in full, automatically.
 *  - Cancelled mid-way (maker/checker) → what is still in escrow goes back pro-rata, to the unit.
 *  - Reports from 3 different people freeze the fund (protective; an operator reviews).
 *  - Wording: "protégé" means held by K21's rules inside Kori — not insurance, not a bank escrow.
 */
export const protectedEnabled = () => process.env.JOKKO_PROTECTED_FUNDS_ENABLED === 'true';
function assertEnabled() {
  if (!protectedEnabled()) throw new CollectiveError('protected_not_enabled', 'Les cagnottes protégées ne sont pas encore ouvertes.', 503);
}
const notFound = () => new CollectiveError('not_found', 'Cagnotte introuvable', 404);
const int = (v) => Number.isSafeInteger(v);
const escrow = (tx, id) => account(tx, 'protectedEscrow', id);
const REPORTS_TO_FREEZE = 3;
const parse = (j) => JSON.parse(j ?? '[]');

async function lockFund(tx, id) {
  const rows = await tx.$queryRaw`SELECT id FROM "ProtectedFund" WHERE id = ${String(id)} FOR UPDATE`;
  if (!rows.length) throw notFound();
  return tx.protectedFund.findUnique({ where: { id: String(id) }, include: { milestones: { orderBy: { seq: 'asc' } } } });
}
const byHandle = (db, h) => db.user.findFirst({ where: { handle: { in: [String(h).replace(/^@/, ''), `@${String(h).replace(/^@/, '')}`] } } });

/** Verified recipient now (re-checked at every release): returns null when not eligible. */
async function recipientEligible(db, fund) {
  if (fund.recipientUserId) {
    const u = await db.user.findUnique({ where: { id: fund.recipientUserId }, select: { verificationTier: true, frozenByAdminAt: true } });
    return u && u.verificationTier >= 2 && !u.frozenByAdminAt ? { userId: fund.recipientUserId } : null;
  }
  const b = await db.business.findUnique({ where: { id: fund.recipientBusinessId }, select: { id: true, ownerId: true, verificationStatus: true, status: true } });
  return b && b.verificationStatus === 'verified' && b.status === 'active' ? { businessId: b.id, ownerId: b.ownerId } : null;
}
async function recipientOwner(db, fund) {
  if (fund.recipientUserId) return fund.recipientUserId;
  return (await db.business.findUnique({ where: { id: fund.recipientBusinessId }, select: { ownerId: true } }))?.ownerId ?? null;
}

export async function createFund(organizerId, b) {
  assertEnabled();
  if (!['project', 'campaign'].includes(b.kind)) throw new CollectiveError('invalid', 'Type inconnu', 400);
  if (!int(b.goalKori) || b.goalKori < 100 || b.goalKori > 10_000_000) throw new CollectiveError('invalid_amount', 'Objectif invalide', 400);
  const deadline = new Date(b.deadline);
  if (Number.isNaN(deadline.getTime()) || deadline < new Date(Date.now() + 3600_000) || deadline > new Date(Date.now() + 180 * 86_400_000)) throw new CollectiveError('invalid', 'Date limite entre 1 heure et 6 mois', 400);
  let recipientUserId = null;
  let recipientBusinessId = null;
  if (b.recipientBusinessId) recipientBusinessId = String(b.recipientBusinessId);
  else {
    const u = await byHandle(prisma, b.recipientHandle ?? '');
    if (!u) throw new CollectiveError('not_found', 'Bénéficiaire introuvable', 404);
    recipientUserId = u.id;
  }
  if (b.kind === 'campaign' && !recipientUserId) throw new CollectiveError('invalid', 'Une collecte protégée aide une personne', 400);
  const fund0 = { recipientUserId, recipientBusinessId };
  if (!(await recipientEligible(prisma, fund0))) throw new CollectiveError('recipient_not_verified', 'Le bénéficiaire doit être vérifié (identité ou entreprise vérifiée)', 409);
  const owner = await recipientOwner(prisma, fund0);
  let approvers = [];
  let milestones;
  if (b.kind === 'project') {
    const hs = [...new Set((b.approverHandles ?? []).map((h) => String(h).replace(/^@/, '')))];
    for (const h of hs) {
      const u = await byHandle(prisma, h);
      if (!u) throw new CollectiveError('not_found', `Approbateur introuvable : ${h}`, 404);
      if (u.id === organizerId || u.id === owner) throw new CollectiveError('approver_not_independent', 'Un approbateur ne peut être ni l’organisateur ni le bénéficiaire', 409);
      approvers.push(u.id);
    }
    approvers = [...new Set(approvers)];
    if (approvers.length < 1 || approvers.length > 5) throw new CollectiveError('invalid', 'Entre 1 et 5 approbateurs indépendants', 400);
    if (!int(b.approvalsRequired) || b.approvalsRequired < 1 || b.approvalsRequired > approvers.length) throw new CollectiveError('invalid', 'Nombre d’approbations invalide', 400);
    milestones = (b.milestones ?? []).map((m, i) => ({ seq: i + 1, title: String(m.title).slice(0, 120), amountKori: m.amountKori }));
    if (!milestones.length || milestones.length > 10 || milestones.some((m) => !int(m.amountKori) || m.amountKori < 1) || milestones.reduce((s, m) => s + m.amountKori, 0) !== b.goalKori) {
      throw new CollectiveError('invalid_milestones', 'Les étapes (1 à 10) doivent totaliser exactement l’objectif', 400);
    }
  } else {
    // A person may have one protected campaign open at a time (duplicate / farming guard).
    const dup = await prisma.protectedFund.findFirst({ where: { kind: 'campaign', recipientUserId, status: { in: ['draft', 'funding', 'funded'] } } });
    if (dup) throw new CollectiveError('duplicate_campaign', 'Cette personne a déjà une collecte protégée en cours', 409);
    milestones = [{ seq: 1, title: 'Objectif atteint', amountKori: b.goalKori }];
  }
  const now = new Date();
  const fund = await prisma.protectedFund.create({
    data: {
      kind: b.kind, title: String(b.title).slice(0, 80), purpose: String(b.purpose).slice(0, 2000), organizerId, recipientUserId, recipientBusinessId,
      recipientConsentAt: owner === organizerId ? now : null, goalKori: b.goalKori, deadline,
      approverIdsJson: JSON.stringify(approvers), approvalsRequired: b.kind === 'project' ? b.approvalsRequired : 0,
      milestones: { create: milestones },
    },
  });
  if (owner && owner !== organizerId) await notifyEvent(prisma, owner, { category: 'money', kind: 'protected_consent', refId: fund.id, title: 'Une cagnotte à ton nom', body: `« ${fund.title} » te désigne comme bénéficiaire. Rien n’est publié sans ton accord.`, dedupeKey: `protected:${fund.id}:consent` });
  for (const a of approvers) await notifyEvent(prisma, a, { category: 'community', kind: 'protected_approver', refId: fund.id, title: 'Rôle d’approbateur proposé', body: `On te propose d’approuver les étapes de « ${fund.title} ». Tu peux accepter ou ignorer.`, dedupeKey: `protected:${fund.id}:approver` });
  return fund;
}

export async function recipientRespond(fundId, userId, accept) {
  assertEnabled();
  return prisma.$transaction(async (tx) => {
    const f = await lockFund(tx, fundId);
    if ((await recipientOwner(tx, f)) !== userId) throw notFound();
    if (f.status !== 'draft') throw new CollectiveError('not_draft', 'Déjà publiée ou fermée', 409);
    if (!accept) return tx.protectedFund.update({ where: { id: f.id }, data: { status: 'cancelled', closedAt: new Date() } });
    return tx.protectedFund.update({ where: { id: f.id }, data: { recipientConsentAt: new Date() } });
  });
}

export async function approverAccept(fundId, userId) {
  assertEnabled();
  return prisma.$transaction(async (tx) => {
    const f = await lockFund(tx, fundId);
    const ids = parse(f.approverIdsJson);
    if (!ids.includes(userId)) throw notFound();
    if (f.status !== 'draft') throw new CollectiveError('not_draft', 'Déjà publiée ou fermée', 409);
    const acc = [...new Set([...parse(f.approverAcceptedJson), userId])];
    return tx.protectedFund.update({ where: { id: f.id }, data: { approverAcceptedJson: JSON.stringify(acc) } });
  });
}

export async function publishFund(fundId, organizerId) {
  assertEnabled();
  return prisma.$transaction(async (tx) => {
    const f = await lockFund(tx, fundId);
    if (f.organizerId !== organizerId) throw notFound();
    if (f.status !== 'draft') throw new CollectiveError('not_draft', 'Déjà publiée ou fermée', 409);
    if (!f.recipientConsentAt) throw new CollectiveError('recipient_consent_required', 'Le bénéficiaire n’a pas encore accepté', 409);
    if (parse(f.approverIdsJson).some((a) => !parse(f.approverAcceptedJson).includes(a))) throw new CollectiveError('approvers_pending', 'Chaque approbateur doit accepter son rôle', 409);
    if (!(await recipientEligible(tx, f))) throw new CollectiveError('recipient_not_verified', 'Bénéficiaire non vérifié', 409);
    return tx.protectedFund.update({ where: { id: f.id }, data: { status: 'funding' } });
  });
}

export async function contribute(fundId, userId, { amountKori, idempotencyKey, anonymous = false }) {
  assertEnabled();
  if (!idempotencyKey || String(idempotencyKey).length < 8) throw new CollectiveError('idempotency_required', 'Clé d’idempotence requise', 400);
  const key = `${userId}:${String(idempotencyKey).slice(0, 80)}`;
  return runMoneyTransaction(prisma, async (tx) => {
    const f = await lockFund(tx, fundId);
    const prior = await tx.protectedContribution.findUnique({ where: { idempotencyKey: key } });
    if (prior) {
      if (prior.fundId !== f.id || prior.amountKori !== amountKori) throw new CollectiveError('idempotency_conflict', 'Cette clé a déjà servi pour un autre paiement', 409);
      return { contribution: prior, replayed: true };
    }
    if (f.status !== 'funding') throw new CollectiveError('not_funding', 'Cette cagnotte ne reçoit pas de contributions', 409);
    if (f.frozenAt) throw new CollectiveError('fund_frozen', 'Cagnotte gelée pendant une vérification K21', 423);
    if (f.deadline <= new Date()) throw new CollectiveError('deadline_passed', 'Date limite dépassée', 409);
    if ((await recipientOwner(tx, f)) === userId) throw new CollectiveError('self_contribution', 'Le bénéficiaire ne contribue pas à sa propre cagnotte', 409);
    const room = f.goalKori - f.raisedKori;
    if (!int(amountKori) || amountKori < 1 || amountKori > room) throw new CollectiveError('invalid_amount', `Montant entre 1 et ${room} ₭`, 400);
    const w = await tx.wallet.findUnique({ where: { userId } });
    if (!w) throw new CollectiveError('wallet_missing', 'Portefeuille introuvable', 400);
    await lockWallets(tx, [w.id]);
    if ((await tx.wallet.findUniqueOrThrow({ where: { id: w.id } })).koriBalance < amountKori) throw new InsufficientFundsError('Solde insuffisant');
    const ref = reference('PRTC');
    await move(tx, { from: await customer(tx, userId), to: await escrow(tx, f.id), amount: amountKori, reference: `${ref}-J`, kind: 'protected_contribution', actor: { type: 'user', id: userId }, authorization: 'contributor_explicit' });
    await tx.ledgerEntry.create({ data: { walletId: w.id, userId, type: 'protected_contribution', amount: -amountKori, counterpartyName: f.title, note: 'Contribution protégée', reference: ref } });
    const c = await tx.protectedContribution.create({ data: { fundId: f.id, contributorId: userId, amountKori, anonymous: Boolean(anonymous), reference: ref, idempotencyKey: key } });
    const raised = f.raisedKori + amountKori;
    await tx.protectedFund.update({ where: { id: f.id }, data: { raisedKori: raised, ...(raised === f.goalKori ? { status: 'funded' } : {}) } });
    return { contribution: c, raisedKori: raised, funded: raised === f.goalKori };
  });
}

/** Project approvers vote on the NEXT pending milestone. Approval changes a status only — it moves no money. */
export async function decideMilestone(fundId, approverId, { decision, note = null }) {
  assertEnabled();
  if (!['approve', 'reject'].includes(decision)) throw new CollectiveError('invalid', 'Décision invalide', 400);
  return prisma.$transaction(async (tx) => {
    const f = await lockFund(tx, fundId);
    if (f.kind !== 'project' || !parse(f.approverAcceptedJson).includes(approverId)) throw notFound();
    if (f.status !== 'funded') throw new CollectiveError('not_funded', 'Les étapes s’approuvent une fois l’objectif atteint', 409);
    const m = f.milestones.find((x) => x.status === 'pending');
    if (!m) throw new CollectiveError('nothing_pending', 'Aucune étape en attente', 409);
    const had = await tx.protectedApproval.findUnique({ where: { milestoneId_approverId: { milestoneId: m.id, approverId } } });
    if (!had) await tx.protectedApproval.create({ data: { milestoneId: m.id, approverId, decision, note: note ? String(note).slice(0, 500) : null } });
    const votes = await tx.protectedApproval.findMany({ where: { milestoneId: m.id } });
    const yes = votes.filter((v) => v.decision === 'approve').length;
    const no = votes.filter((v) => v.decision === 'reject').length;
    const n = parse(f.approverAcceptedJson).length;
    if (yes >= f.approvalsRequired) {
      await tx.protectedMilestone.update({ where: { id: m.id }, data: { status: 'approved', approvedAt: new Date(), evidenceNote: note ?? m.evidenceNote } });
      return { milestone: m.seq, status: 'approved', note: 'Approuvée : le versement attend la validation financière de K21.' };
    }
    if (n - no < f.approvalsRequired) {
      // The milestone can no longer be approved: the fund is frozen for an operator (money stays in escrow).
      await tx.protectedFund.update({ where: { id: f.id }, data: { frozenAt: new Date(), frozenReason: `étape ${m.seq} rejetée par les approbateurs` } });
      return { milestone: m.seq, status: 'rejected_frozen' };
    }
    return { milestone: m.seq, status: 'pending', yes, no };
  });
}

/** Anyone may report a fund. Three different reporters freeze it (no money moves; an operator reviews). */
export async function reportFund(fundId, userId, { reason }) {
  assertEnabled();
  const f = await prisma.protectedFund.findUnique({ where: { id: String(fundId) } });
  if (!f) throw notFound();
  const tag = `[protected:${f.id}]`;
  const dup = await prisma.contentReport.findFirst({ where: { reporterId: userId, reason: { startsWith: tag } } });
  if (!dup) await prisma.contentReport.create({ data: { reporterId: userId, targetUserId: f.organizerId, category: 'scam', reason: `${tag} ${String(reason).slice(0, 400)}`, status: 'open' } });
  const reporters = await prisma.contentReport.findMany({ where: { reason: { startsWith: tag } }, distinct: ['reporterId'], select: { reporterId: true } });
  if (reporters.length >= REPORTS_TO_FREEZE && !f.frozenAt) {
    await prisma.protectedFund.updateMany({ where: { id: f.id, frozenAt: null }, data: { frozenAt: new Date(), frozenReason: 'signalements de fraude' } });
  }
  return { reported: true };
}

/* ── settlement (only through an executed maker/checker approval) ───────────────── */

/** Release the next approved milestone (project) or the full goal (campaign) to the verified recipient. */
export async function executeRelease(db, { fundId, seq }, ctx) {
  return runMoneyTransaction(db, async (tx) => {
    const f = await lockFund(tx, fundId);
    const m = f.milestones.find((x) => x.seq === seq);
    if (!m) throw new CollectiveError('not_found', 'Étape introuvable', 404);
    if (m.status === 'released') return { fundId: f.id, seq, replayed: true };
    if (f.status !== 'funded') throw new CollectiveError('not_funded', `Cagnotte ${f.status}`, 409);
    if (f.frozenAt) throw new CollectiveError('fund_frozen', 'Cagnotte gelée', 423);
    if (f.kind === 'project' && m.status !== 'approved') throw new CollectiveError('not_approved', 'Étape non approuvée par les approbateurs indépendants', 409);
    if (f.kind === 'project' && f.milestones.some((x) => x.seq < seq && x.status !== 'released')) throw new CollectiveError('out_of_order', 'Les étapes se versent dans l’ordre', 409);
    const to = await recipientEligible(tx, f);
    if (!to) throw new CollectiveError('recipient_not_verified', 'Bénéficiaire plus vérifié ou suspendu : aucun versement', 409);
    const ref = `PRTR-${f.id}-${seq}`;
    let dest;
    if (to.userId) dest = await customer(tx, to.userId);
    else { await ensureBusinessWallet(to.businessId, tx); dest = await businessAccount(tx, to.businessId); }
    await move(tx, { from: await escrow(tx, f.id), to: dest, amount: m.amountKori, reference: `${ref}-J`, kind: 'protected_release', actor: { type: 'admin', id: ctx.approvedBy }, authorization: `approval:${ctx.id}:requested_by:${ctx.requestedBy}` });
    if (to.userId) {
      const w = await tx.wallet.findUnique({ where: { userId: to.userId } });
      if (w) await tx.ledgerEntry.create({ data: { walletId: w.id, userId: to.userId, type: 'protected_release', amount: m.amountKori, counterpartyName: f.title, note: `Versement · ${m.title}`, reference: ref } });
    }
    await tx.protectedMilestone.update({ where: { id: m.id }, data: { status: 'released', releasedAt: new Date(), releaseRef: ref } });
    const released = f.releasedKori + m.amountKori;
    await tx.protectedFund.update({ where: { id: f.id }, data: { releasedKori: released, ...(released === f.goalKori ? { status: 'completed', closedAt: new Date() } : {}) } });
    const owner = await recipientOwner(tx, f);
    if (owner) await notifyEvent(tx, owner, { category: 'money', kind: 'protected_release', refId: f.id, title: 'Versement reçu', body: `« ${m.title} » de « ${f.title} » t’a été versé.`, dedupeKey: `protected:${ref}` });
    return { fundId: f.id, seq, amountKori: m.amountKori };
  });
}

/** Refund what is still in escrow. `full` (deadline failure) = every contribution in full; otherwise pro-rata to the unit. */
async function refundRemaining(tx, f, why) {
  const bal = Number((await escrow(tx, f.id)).balance);
  const cs = await tx.protectedContribution.findMany({ where: { fundId: f.id }, orderBy: { createdAt: 'asc' } });
  const open = cs.map((c) => ({ c, rem: c.amountKori - c.refundedKori })).filter((x) => x.rem > 0);
  const S = open.reduce((s, x) => s + x.rem, 0);
  if (!bal || !S) return 0;
  // Largest-remainder allocation: Σ shares = bal exactly, no one gets more than they put in.
  const shares = open.map((x) => ({ ...x, base: Math.floor((bal * x.rem) / S), frac: (bal * x.rem) % S }));
  let left = bal - shares.reduce((s, x) => s + x.base, 0);
  [...shares].sort((a, b) => b.frac - a.frac).forEach((x) => { if (left > 0) { x.base += 1; left -= 1; } });
  let total = 0;
  for (const x of shares) {
    const amt = Math.min(x.base, x.rem);
    if (amt <= 0) continue;
    const ref = `${x.c.reference}-RF${x.c.refundedKori}`;
    await move(tx, { from: await escrow(tx, f.id), to: await customer(tx, x.c.contributorId), amount: amt, reference: `${ref}-J`, kind: 'protected_refund', actor: { type: 'system', id: why }, authorization: why });
    const w = await tx.wallet.findUnique({ where: { userId: x.c.contributorId } });
    if (w) await tx.ledgerEntry.create({ data: { walletId: w.id, userId: x.c.contributorId, type: 'protected_refund', amount: amt, counterpartyName: f.title, note: 'Remboursement cagnotte protégée', reference: ref } });
    await tx.protectedContribution.update({ where: { id: x.c.id }, data: { refundedKori: x.c.refundedKori + amt } });
    await notifyEvent(tx, x.c.contributorId, { category: 'money', kind: 'protected_refund', refId: f.id, title: 'Contribution remboursée', body: `« ${f.title} » : ${amt} ₭ t’ont été rendus.`, dedupeKey: `protected:${ref}` });
    total += amt;
  }
  return total;
}

export async function executeCancel(db, { fundId }, ctx) {
  return runMoneyTransaction(db, async (tx) => {
    const f = await lockFund(tx, fundId);
    if (f.status === 'cancelled') return { fundId: f.id, replayed: true };
    if (!['draft', 'funding', 'funded'].includes(f.status)) throw new CollectiveError('closed', `Cagnotte ${f.status}`, 409);
    const refunded = await refundRemaining(tx, f, `cancel:approval:${ctx.id}`);
    await tx.protectedMilestone.updateMany({ where: { fundId: f.id, status: { in: ['pending', 'approved'] } }, data: { status: 'cancelled' } });
    await tx.protectedFund.update({ where: { id: f.id }, data: { status: 'cancelled', refundedKori: f.refundedKori + refunded, closedAt: new Date() } });
    return { fundId: f.id, refundedKori: refunded };
  });
}

/** Scheduler: a fund that missed its goal by the deadline fails and everyone is refunded in full. */
export async function runProtectedMaintenance(now = new Date()) {
  if (!protectedEnabled()) return { skipped: 'protected_disabled' };
  const due = await prisma.protectedFund.findMany({ where: { status: 'funding', deadline: { lte: now } }, select: { id: true } });
  const out = { failed: 0, refundedKori: 0, errors: [] };
  for (const d of due) {
    try {
      await runMoneyTransaction(prisma, async (tx) => {
        const f = await lockFund(tx, d.id);
        if (f.status !== 'funding' || f.deadline > now) return;
        const r = await refundRemaining(tx, f, 'deadline_missed');
        await tx.protectedMilestone.updateMany({ where: { fundId: f.id, status: 'pending' }, data: { status: 'cancelled' } });
        await tx.protectedFund.update({ where: { id: f.id }, data: { status: 'failed', refundedKori: f.refundedKori + r, closedAt: now } });
        out.failed += 1;
        out.refundedKori += r;
      });
    } catch (e) {
      out.errors.push({ fundId: d.id, code: e.code ?? 'error' });
    }
  }
  return out;
}

export async function freezeFund(adminId, fundId, { reason }, frozen) {
  return prisma.$transaction(async (tx) => {
    const f = await lockFund(tx, fundId);
    if (!frozen && f.frozenReason?.startsWith(`by:${adminId}:`)) throw new CollectiveError('same_operator', 'Un autre opérateur doit lever le gel', 403);
    await tx.protectedFund.update({ where: { id: f.id }, data: frozen ? { frozenAt: new Date(), frozenReason: `by:${adminId}: ${String(reason).slice(0, 200)}` } : { frozenAt: null, frozenReason: null } });
    await tx.adminAuditLog.create({ data: { adminUserId: adminId, action: frozen ? 'protected.freeze' : 'protected.unfreeze', targetType: 'protected_fund', targetId: f.id, detailJson: JSON.stringify({ reason }) } });
    return { frozen };
  });
}

/* ── views ──────────────────────────────────────────────────────────────────────── */
export async function fundView(fundId, userId) {
  const f = await prisma.protectedFund.findUnique({ where: { id: String(fundId) }, include: { milestones: { orderBy: { seq: 'asc' }, include: { approvals: true } } } });
  if (!f) throw notFound();
  const owner = await recipientOwner(prisma, f);
  const insider = [f.organizerId, owner, ...parse(f.approverIdsJson)].includes(userId);
  if (f.status === 'draft' && !insider) throw notFound();
  const ids = [f.organizerId, f.recipientUserId, ...parse(f.approverIdsJson)].filter(Boolean);
  const users = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, handle: true, name: true } })).map((u) => [u.id, { handle: u.handle, name: u.name }]));
  const biz = f.recipientBusinessId ? await prisma.business.findUnique({ where: { id: f.recipientBusinessId }, select: { name: true } }) : null;
  const mine = await prisma.protectedContribution.findMany({ where: { fundId: f.id, contributorId: userId } });
  return {
    id: f.id, kind: f.kind, title: f.title, purpose: f.purpose, status: f.status, frozen: Boolean(f.frozenAt), goalKori: f.goalKori, raisedKori: f.raisedKori,
    releasedKori: f.releasedKori, refundedKori: f.refundedKori, deadline: f.deadline.toISOString(), organizer: users.get(f.organizerId) ?? null,
    recipient: f.recipientUserId ? users.get(f.recipientUserId) : { name: biz?.name ?? null, business: true }, recipientConsented: Boolean(f.recipientConsentAt),
    approvers: parse(f.approverIdsJson).map((a) => ({ ...users.get(a), accepted: parse(f.approverAcceptedJson).includes(a) })), approvalsRequired: f.approvalsRequired,
    milestones: f.milestones.map((m) => ({ seq: m.seq, title: m.title, amountKori: m.amountKori, status: m.status, approvals: m.approvals.filter((a) => a.decision === 'approve').length, releasedAt: m.releasedAt?.toISOString() ?? null })),
    contributors: await prisma.protectedContribution.count({ where: { fundId: f.id } }),
    myContributionKori: mine.reduce((s, c) => s + c.amountKori, 0), myRefundedKori: mine.reduce((s, c) => s + c.refundedKori, 0),
    role: { organizer: f.organizerId === userId, recipient: owner === userId, approver: parse(f.approverIdsJson).includes(userId) },
    disclosure: 'Cagnotte protégée : l’argent reste bloqué par les règles de K21 jusqu’au versement validé. Ce n’est ni une assurance ni un compte bancaire séquestre.',
  };
}

export async function listFunds({ kind = null } = {}) {
  const rows = await prisma.protectedFund.findMany({ where: { status: { in: ['funding', 'funded'] }, frozenAt: null, ...(kind ? { kind } : {}) }, orderBy: { createdAt: 'desc' }, take: 50 });
  return { funds: rows.map((f) => ({ id: f.id, kind: f.kind, title: f.title, status: f.status, goalKori: f.goalKori, raisedKori: f.raisedKori, deadline: f.deadline.toISOString() })) };
}
