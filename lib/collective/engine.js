import { reference } from '../../api/_lib/auth.js';
import { prisma } from '../prisma.js';
import { InsufficientFundsError, lockWallets, runMoneyTransaction } from '../wallet-atomic.js';
import { account, customer, move } from '../money-kernel/flows.js';
import { notifyEvent } from '../community/notify.js';
import {
  CollectiveError, FREQUENCIES, KINDS, LIMITS, POLICIES, addPeriod, assertEnabled, canonicalJson, drawOrder, rulesHashOf,
} from './contract.js';

/**
 * J11 collective money engine — lifecycle, money, votes, maintenance (rules: ./contract.js).
 * Every money step: one runMoneyTransaction, the group row locked FOR UPDATE first, J2 postings with
 * deterministic references, an append-only CollectivePayment row per posting, idempotent on the
 * member's key. Non-members always get 404 (a group's existence is private).
 */
const notFound = () => new CollectiveError('not_found', 'Groupe introuvable', 404);
const OPEN_OBLIGATION = ['open', 'partial', 'missed'];
const SETTLED_OBLIGATION = ['paid', 'late_paid'];
const PRE_ACTIVE = ['proposed', 'awaiting_acceptance'];

async function lockGroup(tx, groupId) {
  const rows = await tx.$queryRaw`SELECT id FROM "CollectiveGroup" WHERE id = ${String(groupId)} FOR UPDATE`;
  if (!rows.length) throw notFound();
  return tx.collectiveGroup.findUnique({ where: { id: String(groupId) }, include: { members: true } });
}
function memberOf(group, userId, statuses = ['joined']) {
  const m = group.members.find((x) => x.userId === userId);
  if (!m || !statuses.includes(m.status)) throw notFound();
  return m;
}
const joined = (group) => group.members.filter((m) => m.status === 'joined');
async function event(tx, groupId, actorType, actorId, action, detail = null) {
  await tx.collectiveEvent.create({ data: { groupId, actorType, actorId, action, detailJson: detail ? JSON.stringify(detail) : null } });
}
async function notify(tx, userIds, msg) {
  for (const u of new Set(userIds)) await notifyEvent(tx, u, { ...msg, dedupeKey: msg.dedupeKey ? `${msg.dedupeKey}:${u}` : null });
}
function assertActive(group) {
  if (group.status !== 'active') throw new CollectiveError('not_active', 'Le groupe n’est pas en cours', 409);
  if (group.frozenAt) throw new CollectiveError('group_frozen', 'Groupe gelé par K21 pendant une vérification : aucun mouvement d’argent', 423);
}
const int = (v) => Number.isSafeInteger(v);

/* ── lifecycle (no money) ───────────────────────────────────────────────────────── */

export async function createGroup(userId, b) {
  assertEnabled();
  if (!KINDS.includes(b.kind)) throw new CollectiveError('invalid', 'Type de groupe inconnu', 400);
  if (!int(b.contributionKori) || b.contributionKori < LIMITS.minContributionKori || b.contributionKori > LIMITS.maxContributionKori) {
    throw new CollectiveError('invalid_amount', 'Montant de cotisation invalide', 400);
  }
  if (!FREQUENCIES[b.frequency]) throw new CollectiveError('invalid', 'Fréquence inconnue', 400);
  const graceDays = b.graceDays ?? 3;
  if (!int(graceDays) || graceDays < 0 || graceDays > LIMITS.maxGraceDays) throw new CollectiveError('invalid', 'Délai de grâce invalide', 400);
  const goal = b.kind === 'goal';
  if (goal) {
    if (!int(b.cycleCount) || b.cycleCount < 1 || b.cycleCount > LIMITS.maxGoalCycles) throw new CollectiveError('invalid', 'Nombre de versements invalide', 400);
    if (!['anytime', 'end'].includes(b.withdrawPolicy)) throw new CollectiveError('invalid', 'Règle de retrait invalide', 400);
    if (b.targetKori != null && (!int(b.targetKori) || b.targetKori < b.contributionKori)) throw new CollectiveError('invalid', 'Objectif invalide', 400);
  }
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const g = await tx.collectiveGroup.create({
      data: {
        kind: b.kind, name: String(b.name).trim().slice(0, 60), organizerId: userId, contributionKori: b.contributionKori, frequency: b.frequency, graceDays,
        rotationMethod: goal ? 'none' : (b.rotationMethod === 'fixed' ? 'fixed' : 'draw'),
        targetKori: goal ? (b.targetKori ?? b.contributionKori * b.cycleCount) : null, withdrawPolicy: goal ? b.withdrawPolicy : null, cycleCount: goal ? b.cycleCount : null,
        members: { create: [{ userId, status: 'joined', joinedAt: now }] },
      },
    });
    await event(tx, g.id, 'user', userId, 'created', { kind: g.kind });
    return g;
  });
}

/** Membership changed after rules were proposed → the proposal is void; everyone must approve a new one. */
async function voidProposal(tx, group, why) {
  if (group.status !== 'awaiting_acceptance') return;
  await tx.collectiveMember.updateMany({ where: { groupId: group.id }, data: { acceptedRulesVersion: null, acceptedRulesHash: null, acceptedAt: null, position: null } });
  await tx.collectiveGroup.update({ where: { id: group.id }, data: { status: 'proposed', rulesHash: null, rulesJson: null } });
  await event(tx, group.id, 'system', null, 'rules_voided', { why });
}

export async function inviteMembers(groupId, actorId, handles = []) {
  assertEnabled();
  return prisma.$transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    memberOf(group, actorId);
    if (group.organizerId !== actorId) throw new CollectiveError('forbidden', 'Seul l’organisateur invite', 403);
    if (!PRE_ACTIVE.includes(group.status)) throw new CollectiveError('not_forming', 'Le groupe a déjà démarré', 409);
    const clean = [...new Set(handles.map((h) => String(h).trim().replace(/^@/, '')).filter(Boolean))].slice(0, LIMITS.maxMembers);
    const users = await tx.user.findMany({ where: { handle: { in: clean.flatMap((h) => [h, `@${h}`]) } }, select: { id: true } });
    // Someone who blocked the organizer is silently skipped (they never see an invitation from them).
    const blocked = new Set((await tx.userBlock.findMany({ where: { blockerId: { in: users.map((u) => u.id) }, blockedUserId: actorId }, select: { blockerId: true } })).map((r) => r.blockerId));
    let invited = 0;
    for (const u of users) {
      if (u.id === actorId || blocked.has(u.id)) continue;
      const live = group.members.filter((m) => ['invited', 'joined'].includes(m.status)).length + invited;
      if (live >= LIMITS.maxMembers) throw new CollectiveError('too_many_members', `Maximum ${LIMITS.maxMembers} membres`, 409);
      const m = group.members.find((x) => x.userId === u.id);
      if (m && ['invited', 'joined'].includes(m.status)) continue;
      if (m) await tx.collectiveMember.update({ where: { id: m.id }, data: { status: 'invited', invitedById: actorId, joinedAt: null, leftAt: null } });
      else await tx.collectiveMember.create({ data: { groupId: group.id, userId: u.id, status: 'invited', invitedById: actorId } });
      invited += 1;
      await notifyEvent(tx, u.id, { category: 'community', kind: 'collective_invite', refId: group.id, title: 'Invitation à un groupe', body: `Tu es invité·e à « ${group.name} ». Rejoindre ne t’engage à rien : tu approuveras les règles avant toute cotisation.`, dedupeKey: `collective:${group.id}:invite:${Date.now()}` });
    }
    await event(tx, group.id, 'user', actorId, 'invited', { count: invited });
    return { invited };
  });
}

export async function respondToInvite(groupId, userId, accept) {
  assertEnabled();
  return prisma.$transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    const m = memberOf(group, userId, ['invited']);
    if (!PRE_ACTIVE.includes(group.status)) throw new CollectiveError('not_forming', 'Le groupe a déjà démarré', 409);
    await tx.collectiveMember.update({ where: { id: m.id }, data: accept ? { status: 'joined', joinedAt: new Date() } : { status: 'declined', leftAt: new Date() } });
    if (accept) await voidProposal(tx, group, 'member_joined');
    await event(tx, group.id, 'user', userId, accept ? 'joined' : 'declined');
    return { status: accept ? 'joined' : 'declined' };
  });
}

/** Before activation only. After activation, leaving is an `exit` vote (obligations are mutual). */
export async function leaveGroup(groupId, userId) {
  assertEnabled();
  return prisma.$transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    const m = memberOf(group, userId, ['invited', 'joined']);
    if (!PRE_ACTIVE.includes(group.status)) throw new CollectiveError('use_exit_vote', 'Le groupe a démarré : demande une sortie au vote des membres', 409);
    if (group.organizerId === userId) throw new CollectiveError('organizer_cancels', 'L’organisateur annule le groupe au lieu de le quitter', 409);
    await tx.collectiveMember.update({ where: { id: m.id }, data: { status: 'left', leftAt: new Date(), position: null } });
    if (m.status === 'joined') await voidProposal(tx, group, 'member_left');
    await event(tx, group.id, 'user', userId, 'left');
    return { status: 'left' };
  });
}

export async function removeMember(groupId, actorId, targetUserId) {
  assertEnabled();
  return prisma.$transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    memberOf(group, actorId);
    if (group.organizerId !== actorId) throw new CollectiveError('forbidden', 'Seul l’organisateur retire un membre', 403);
    if (!PRE_ACTIVE.includes(group.status)) throw new CollectiveError('not_forming', 'Après le démarrage, personne ne peut retirer un membre', 409);
    if (targetUserId === actorId) throw new CollectiveError('invalid', 'Annule le groupe à la place', 409);
    const m = group.members.find((x) => x.userId === targetUserId && ['invited', 'joined'].includes(x.status));
    if (!m) throw new CollectiveError('not_found', 'Membre introuvable', 404);
    await tx.collectiveMember.update({ where: { id: m.id }, data: { status: 'removed', leftAt: new Date(), position: null } });
    if (m.status === 'joined') await voidProposal(tx, group, 'member_removed');
    await event(tx, group.id, 'user', actorId, 'removed', { userId: targetUserId });
    return { status: 'removed' };
  });
}

/**
 * The organizer proposes the final rules for the CURRENT joined members. Rotation: `fixed` (an order the
 * organizer proposes; every member sees and approves it) or `draw` (random; the seed is in the rules so
 * anyone can verify the order). Nothing is "organizer first" by default.
 */
export async function proposeRules(groupId, actorId, { order = null, startAt = null } = {}) {
  assertEnabled();
  return prisma.$transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    memberOf(group, actorId);
    if (group.organizerId !== actorId) throw new CollectiveError('forbidden', 'Seul l’organisateur propose les règles', 403);
    if (!PRE_ACTIVE.includes(group.status)) throw new CollectiveError('not_forming', 'Les règles sont verrouillées', 409);
    const people = joined(group);
    if (people.length < LIMITS.minMembers) throw new CollectiveError('not_enough_members', `Il faut au moins ${LIMITS.minMembers} membres qui ont rejoint`, 409);
    const start = startAt ? new Date(startAt) : new Date(Date.now() + 86_400_000);
    if (Number.isNaN(start.getTime()) || start.getTime() < Date.now() - 60_000) throw new CollectiveError('invalid', 'Date de début invalide', 400);
    const ids = people.map((m) => m.userId);
    let rotation = null;
    let drawSeed = null;
    if (group.kind === 'rotating') {
      let ordered;
      if (group.rotationMethod === 'fixed') {
        if (!Array.isArray(order) || order.length !== ids.length || new Set(order).size !== ids.length || order.some((u) => !ids.includes(u))) {
          throw new CollectiveError('invalid_order', 'L’ordre doit contenir chaque membre une seule fois', 400);
        }
        ordered = order;
      } else {
        drawSeed = reference('SEED');
        ordered = drawOrder(ids, drawSeed);
      }
      rotation = ordered.map((userId, i) => ({ position: i + 1, userId }));
    }
    const cycleCount = group.kind === 'rotating' ? ids.length : group.cycleCount;
    const schedule = Array.from({ length: cycleCount }, (_, i) => {
      const dueAt = addPeriod(start, group.frequency, i);
      return { cycle: i + 1, dueAt, graceUntil: new Date(dueAt.getTime() + group.graceDays * 86_400_000) };
    });
    const rulesVersion = group.rulesVersion + 1;
    const rules = {
      v: 1, rulesVersion, groupId: group.id, kind: group.kind, name: group.name, organizerId: group.organizerId,
      contributionKori: group.contributionKori, frequency: group.frequency, graceDays: group.graceDays, cycleCount, startAt: start,
      members: [...ids].sort(), rotationMethod: group.rotationMethod, drawSeed, rotation, schedule,
      targetKori: group.targetKori, withdrawPolicy: group.withdrawPolicy, policies: POLICIES,
    };
    const rulesHash = rulesHashOf(rules);
    await tx.collectiveMember.updateMany({ where: { groupId: group.id }, data: { acceptedRulesVersion: null, acceptedRulesHash: null, acceptedAt: null, position: null } });
    if (rotation) for (const r of rotation) await tx.collectiveMember.update({ where: { groupId_userId: { groupId: group.id, userId: r.userId } }, data: { position: r.position } });
    await tx.collectiveGroup.update({ where: { id: group.id }, data: { status: 'awaiting_acceptance', rulesVersion, rulesHash, rulesJson: canonicalJson(rules), cycleCount, startAt: start } });
    await event(tx, group.id, 'user', actorId, 'rules_proposed', { rulesVersion, rulesHash });
    await notify(tx, ids.filter((u) => u !== actorId), { category: 'community', kind: 'collective_rules', refId: group.id, title: 'Règles à approuver', body: `Lis et approuve les règles de « ${group.name} ». Rien ne démarre sans l’accord de chaque membre.`, dedupeKey: `collective:${group.id}:rules:${rulesVersion}` });
    return { rulesVersion, rulesHash, rules: JSON.parse(canonicalJson(rules)) };
  });
}

/** A member approves the EXACT rules they saw (hash). When every joined member has, the group starts. */
export async function acceptRules(groupId, userId, { rulesHash }) {
  assertEnabled();
  return prisma.$transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    const m = memberOf(group, userId);
    if (group.status !== 'awaiting_acceptance') throw new CollectiveError('no_rules_pending', 'Aucune règle en attente d’approbation', 409);
    if (!rulesHash || rulesHash !== group.rulesHash) throw new CollectiveError('rules_changed', 'Les règles ont changé : relis la nouvelle version', 409);
    if (m.acceptedRulesHash !== group.rulesHash) {
      await tx.collectiveMember.update({ where: { id: m.id }, data: { acceptedRulesVersion: group.rulesVersion, acceptedRulesHash: group.rulesHash, acceptedAt: new Date() } });
      await event(tx, group.id, 'user', userId, 'rules_accepted', { rulesVersion: group.rulesVersion });
    }
    const fresh = await tx.collectiveMember.findMany({ where: { groupId: group.id, status: 'joined' } });
    if (fresh.every((x) => x.acceptedRulesHash === group.rulesHash)) return { status: 'active', ...(await activate(tx, group, fresh)) };
    return { status: 'awaiting_acceptance', accepted: fresh.filter((x) => x.acceptedRulesHash === group.rulesHash).length, of: fresh.length };
  });
}

async function activate(tx, group, members) {
  const rules = JSON.parse(group.rulesJson);
  const now = new Date();
  await tx.collectiveGroup.update({ where: { id: group.id }, data: { status: 'active', currentCycle: 1, activatedAt: now } });
  const rows = [];
  for (const s of rules.schedule) {
    for (const m of members) rows.push({ groupId: group.id, cycle: s.cycle, userId: m.userId, dueAt: new Date(s.dueAt), graceUntil: new Date(s.graceUntil), amountDueKori: group.contributionKori });
  }
  await tx.collectiveObligation.createMany({ data: rows });
  await event(tx, group.id, 'system', null, 'activated', { rulesHash: group.rulesHash, obligations: rows.length });
  await notify(tx, members.map((m) => m.userId), { category: 'money', kind: 'collective_active', refId: group.id, title: 'Groupe démarré', body: `« ${group.name} » a démarré avec les règles que tout le monde a approuvées. Première échéance : ${new Date(rules.schedule[0].dueAt).toLocaleDateString('fr-SN')}.`, dedupeKey: `collective:${group.id}:active` });
  return { obligations: rows.length };
}

/** A member refuses the proposed rules: they leave, and the proposal is void for everyone. */
export async function declineRules(groupId, userId) {
  assertEnabled();
  return prisma.$transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    const m = memberOf(group, userId);
    if (group.status !== 'awaiting_acceptance') throw new CollectiveError('no_rules_pending', 'Aucune règle en attente', 409);
    if (group.organizerId === userId) throw new CollectiveError('organizer_cancels', 'L’organisateur annule le groupe au lieu de refuser', 409);
    await tx.collectiveMember.update({ where: { id: m.id }, data: { status: 'left', leftAt: new Date(), position: null } });
    await voidProposal(tx, group, 'rules_declined');
    await event(tx, group.id, 'user', userId, 'rules_declined');
    return { status: 'left' };
  });
}

/** Before activation, no money exists: the organizer may close the group. After activation: `cancel` vote only. */
export async function cancelBeforeStart(groupId, actorId) {
  assertEnabled();
  return prisma.$transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    memberOf(group, actorId);
    if (group.organizerId !== actorId) throw new CollectiveError('forbidden', 'Seul l’organisateur peut fermer le groupe avant le démarrage', 403);
    if (!PRE_ACTIVE.includes(group.status)) throw new CollectiveError('use_cancel_vote', 'Le groupe a démarré : l’annulation se décide au vote des membres', 409);
    await tx.collectiveGroup.update({ where: { id: group.id }, data: { status: 'cancelled', endedAt: new Date() } });
    await event(tx, group.id, 'user', actorId, 'cancelled_before_start');
    return { status: 'cancelled' };
  });
}

/* ── money ──────────────────────────────────────────────────────────────────────── */

async function debitCheck(tx, userId, amount) {
  const w = await tx.wallet.findUnique({ where: { userId } });
  if (!w) throw new CollectiveError('wallet_missing', 'Portefeuille introuvable', 400);
  await lockWallets(tx, [w.id]);
  const fresh = await tx.wallet.findUniqueOrThrow({ where: { id: w.id } });
  if (fresh.koriBalance < amount) throw new InsufficientFundsError('Solde insuffisant pour cotiser');
  return fresh;
}
async function historyLine(tx, userId, { type, amount, group, note, ref }) {
  const w = await tx.wallet.findUnique({ where: { userId } });
  if (w) await tx.ledgerEntry.create({ data: { walletId: w.id, userId, type, amount, counterpartyName: group.name, note, reference: ref } });
}
const potAccount = (tx, groupId) => account(tx, 'collectivePot', groupId);
const shareAccount = (tx, groupId, userId) => account(tx, 'collectiveShare', groupId, userId);
const recipientOf = (group, cycle) => group.members.find((m) => m.position === cycle && m.status === 'joined') ?? null;

/** Money currently in the rotating pot for `cycle` (= what the J2 pot account must hold). */
async function cyclePot(tx, groupId, cycle) {
  const rows = await tx.collectivePayment.groupBy({ by: ['kind'], where: { groupId, cycle }, _sum: { amountKori: true } });
  const sum = (k) => rows.find((r) => r.kind === k)?._sum.amountKori ?? 0;
  return sum('contribution') - sum('refund') - sum('payout') - sum('catch_up');
}

/**
 * The member pays their OLDEST unpaid obligation (whole or part). Rotating: into the pot; a payment for a
 * cycle that already paid out goes straight on to that cycle's recipient (catch-up). Goal: into the member's
 * own share. Idempotent on the member's key; a replay with a different amount is refused.
 */
export async function contribute(groupId, userId, { amountKori = null, idempotencyKey }) {
  assertEnabled();
  if (!idempotencyKey || String(idempotencyKey).length < 8) throw new CollectiveError('idempotency_required', 'Clé d’idempotence requise', 400);
  const key = `${userId}:${String(idempotencyKey).slice(0, 80)}`;
  return runMoneyTransaction(prisma, async (tx) => {
    const group = await lockGroup(tx, groupId);
    memberOf(group, userId);
    const prior = await tx.collectivePayment.findUnique({ where: { idempotencyKey: key } });
    if (prior) {
      if (prior.groupId !== group.id || (amountKori != null && amountKori !== prior.amountKori)) throw new CollectiveError('idempotency_conflict', 'Cette clé a déjà servi pour un autre paiement', 409);
      return { payment: prior, replayed: true };
    }
    assertActive(group);
    const ob = await tx.collectiveObligation.findFirst({ where: { groupId: group.id, userId, status: { in: OPEN_OBLIGATION }, cycle: { lte: group.currentCycle } }, orderBy: { cycle: 'asc' } });
    if (!ob) throw new CollectiveError('nothing_due', 'Tu es à jour : rien à payer pour le moment', 409);
    const remaining = ob.amountDueKori - ob.amountPaidKori;
    const amount = amountKori ?? remaining;
    if (!int(amount) || amount < 1 || amount > remaining) throw new CollectiveError('invalid_amount', `Montant entre 1 et ${remaining} ₭`, 400);
    await debitCheck(tx, userId, amount);
    const now = new Date();
    const late = now > ob.graceUntil;
    const ref = reference('COLC');
    const to = group.kind === 'goal' ? await shareAccount(tx, group.id, userId) : await potAccount(tx, group.id);
    await move(tx, { from: await customer(tx, userId), to, amount, reference: `${ref}-J`, kind: 'collective_contribution', actor: { type: 'user', id: userId }, authorization: `member_explicit:${group.rulesHash}` });
    await historyLine(tx, userId, { type: 'collective_contribution', amount: -amount, group, note: `Cotisation · cycle ${ob.cycle}`, ref });
    const payment = await tx.collectivePayment.create({ data: { groupId: group.id, cycle: ob.cycle, userId, kind: 'contribution', amountKori: amount, late, reference: ref, idempotencyKey: key } });
    const paid = ob.amountPaidKori + amount;
    const status = paid === ob.amountDueKori ? (late || ob.status === 'missed' ? 'late_paid' : 'paid') : (late ? 'missed' : 'partial');
    await tx.collectiveObligation.update({ where: { id: ob.id }, data: { amountPaidKori: paid, status, paidAt: paid === ob.amountDueKori ? now : null } });
    await event(tx, group.id, 'user', userId, 'contribution', { cycle: ob.cycle, amountKori: amount, late });

    let catchUp = null;
    let payout = null;
    if (group.kind === 'rotating') {
      const released = await tx.collectivePayout.findUnique({ where: { groupId_cycle: { groupId: group.id, cycle: ob.cycle } } });
      if (released) catchUp = await forwardCatchUp(tx, group, ob.cycle, released.recipientId, amount, ref);
      else if (ob.cycle === group.currentCycle) payout = await releaseIfComplete(tx, group, { type: 'system', id: 'rules' });
    }
    return { payment, obligation: { cycle: ob.cycle, paidKori: paid, dueKori: ob.amountDueKori, status }, catchUp, payout };
  });
}

/** A late payment for a cycle that already paid out goes to the member who was short-paid, through the pot. */
async function forwardCatchUp(tx, group, cycle, recipientId, amount, ref) {
  await move(tx, { from: await potAccount(tx, group.id), to: await customer(tx, recipientId), amount, reference: `${ref}-CU-J`, kind: 'collective_catch_up', actor: { type: 'system', id: 'collective-rules' }, authorization: `rotation_rule:${group.rulesHash}:cycle:${cycle}` });
  await historyLine(tx, recipientId, { type: 'collective_payout', amount, group, note: `Rattrapage · cycle ${cycle}`, ref: `${ref}-CU` });
  await tx.collectivePayment.create({ data: { groupId: group.id, cycle, userId: recipientId, kind: 'catch_up', amountKori: amount, reference: `${ref}-CU` } });
  await event(tx, group.id, 'system', null, 'catch_up', { cycle, amountKori: amount, recipientId });
  await notifyEvent(tx, recipientId, { category: 'money', kind: 'collective_payout', refId: group.id, title: 'Rattrapage reçu', body: `Un retard du cycle ${cycle} de « ${group.name} » vient de t’être versé.`, dedupeKey: `collective:${ref}:cu` });
  return { cycle, amountKori: amount, recipientId };
}

async function openDisputeOn(tx, groupId, cycle) {
  return tx.collectiveDispute.findFirst({ where: { groupId, cycle, status: { in: ['open', 'awaiting_settlement'] } } });
}

/** Pays the current cycle to the rotation's recipient when every obligation of the cycle is settled. */
async function releaseIfComplete(tx, group, actor) {
  const cycle = group.currentCycle;
  if (await openDisputeOn(tx, group.id, cycle)) return null;
  const obs = await tx.collectiveObligation.findMany({ where: { groupId: group.id, cycle } });
  const live = obs.filter((o) => o.status !== 'cancelled' && o.status !== 'refunded');
  if (!live.length || !live.every((o) => SETTLED_OBLIGATION.includes(o.status))) return null;
  if (!recipientOf(group, cycle)) return null;
  return payCycle(tx, group, cycle, 'full', actor);
}

async function payCycle(tx, group, cycle, basis, actor) {
  const recipient = recipientOf(group, cycle);
  if (!recipient) throw new CollectiveError('no_recipient', 'Aucun bénéficiaire actif pour ce cycle', 409);
  const amount = await cyclePot(tx, group.id, cycle);
  const potBal = (await potAccount(tx, group.id)).balance;
  if (Number(potBal) !== amount) throw new CollectiveError('pot_mismatch', 'Le pot ne correspond pas aux paiements : vérification K21 requise', 409);
  if (amount <= 0) throw new CollectiveError('empty_pot', 'Rien à verser pour ce cycle', 409);
  const ref = reference('COLP');
  await tx.collectivePayout.create({ data: { groupId: group.id, cycle, recipientId: recipient.userId, amountKori: amount, basis, reference: ref } });
  await move(tx, { from: await potAccount(tx, group.id), to: await customer(tx, recipient.userId), amount, reference: `${ref}-J`, kind: 'collective_payout', actor, authorization: `rotation_rule:${group.rulesHash}:cycle:${cycle}:${basis}` });
  await tx.collectivePayment.create({ data: { groupId: group.id, cycle, userId: recipient.userId, kind: 'payout', amountKori: amount, reference: ref } });
  await historyLine(tx, recipient.userId, { type: 'collective_payout', amount, group, note: `Pot du cycle ${cycle}`, ref });
  await event(tx, group.id, actor.type, actor.id, 'payout', { cycle, amountKori: amount, recipientId: recipient.userId, basis });
  await notifyEvent(tx, recipient.userId, { category: 'money', kind: 'collective_payout', refId: group.id, title: 'Tu as reçu le pot', body: `Le pot du cycle ${cycle} de « ${group.name} » t’a été versé.`, dedupeKey: `collective:${group.id}:payout:${cycle}` });
  await advance(tx, group, cycle);
  return { cycle, amountKori: amount, recipientId: recipient.userId, basis };
}

/** Next cycle; cycles whose obligations were all cancelled (an exited recipient) are skipped. */
async function advance(tx, group, fromCycle) {
  let next = fromCycle + 1;
  while (next <= group.cycleCount) {
    const live = await tx.collectiveObligation.count({ where: { groupId: group.id, cycle: next, status: { notIn: ['cancelled', 'refunded'] } } });
    if (live > 0 && recipientOf(group, next)) break;
    next += 1;
  }
  if (next > group.cycleCount) {
    await tx.collectiveGroup.update({ where: { id: group.id }, data: { status: 'completed', endedAt: new Date(), currentCycle: group.cycleCount } });
    await event(tx, group.id, 'system', null, 'completed');
    group.status = 'completed';
  } else {
    await tx.collectiveGroup.update({ where: { id: group.id }, data: { currentCycle: next } });
    group.currentCycle = next;
  }
}

/** Any member (or the scheduler) may ask: the rules decide; the destination is never chosen by a person. */
export async function releaseCycle(groupId, userId) {
  assertEnabled();
  return runMoneyTransaction(prisma, async (tx) => {
    const group = await lockGroup(tx, groupId);
    memberOf(group, userId);
    assertActive(group);
    if (group.kind !== 'rotating') throw new CollectiveError('invalid', 'Pas de pot dans une épargne objectif', 409);
    if (await openDisputeOn(tx, group.id, group.currentCycle)) throw new CollectiveError('disputed', 'Un litige bloque ce cycle', 409);
    const r = await releaseIfComplete(tx, group, { type: 'user', id: userId });
    if (!r) throw new CollectiveError('cycle_incomplete', 'Toutes les cotisations du cycle ne sont pas payées. Aucun versement anticipé.', 409);
    return r;
  });
}

/** Goal savings: a member withdraws from THEIR OWN share only, under the accepted unlock rule. */
export async function withdrawShare(groupId, userId, { amountKori = null, idempotencyKey }) {
  assertEnabled();
  if (!idempotencyKey || String(idempotencyKey).length < 8) throw new CollectiveError('idempotency_required', 'Clé d’idempotence requise', 400);
  const key = `${userId}:${String(idempotencyKey).slice(0, 80)}`;
  return runMoneyTransaction(prisma, async (tx) => {
    const group = await lockGroup(tx, groupId);
    memberOf(group, userId, ['joined', 'exited']);
    const prior = await tx.collectivePayment.findUnique({ where: { idempotencyKey: key } });
    if (prior) return { payment: prior, replayed: true };
    if (group.kind !== 'goal') throw new CollectiveError('invalid', 'Retrait possible seulement en épargne objectif', 409);
    if (group.frozenAt) throw new CollectiveError('group_frozen', 'Groupe gelé par K21 pendant une vérification', 423);
    if (group.withdrawPolicy === 'end' && group.status === 'active') throw new CollectiveError('locked_until_end', 'Selon les règles acceptées, l’épargne se retire à la fin', 409);
    const share = await shareAccount(tx, group.id, userId);
    const bal = Number(share.balance);
    const amount = amountKori ?? bal;
    if (!int(amount) || amount < 1 || amount > bal) throw new CollectiveError('invalid_amount', `Montant entre 1 et ${bal} ₭`, 400);
    return returnShare(tx, group, userId, amount, key);
  });
}

async function returnShare(tx, group, userId, amount, key = null) {
  const ref = reference('COLW');
  await move(tx, { from: await shareAccount(tx, group.id, userId), to: await customer(tx, userId), amount, reference: `${ref}-J`, kind: 'collective_withdrawal', actor: { type: 'user', id: userId }, authorization: 'own_share' });
  await historyLine(tx, userId, { type: 'collective_withdrawal', amount, group, note: 'Retrait de ton épargne', ref });
  const payment = await tx.collectivePayment.create({ data: { groupId: group.id, cycle: group.currentCycle, userId, kind: 'withdrawal', amountKori: amount, reference: ref, idempotencyKey: key } });
  await event(tx, group.id, 'user', userId, 'withdrawal', { amountKori: amount });
  return { payment };
}

/* ── votes (the only way to change course after activation) ─────────────────────── */

const TOPICS = ['extend_grace', 'partial_release', 'cancel', 'exit'];

async function receivedIds(tx, groupId) {
  return new Set((await tx.collectivePayout.findMany({ where: { groupId }, select: { recipientId: true } })).map((p) => p.recipientId));
}

export async function openVote(groupId, userId, { topic, days = null }) {
  assertEnabled();
  if (!TOPICS.includes(topic)) throw new CollectiveError('invalid', 'Sujet de vote inconnu', 400);
  return runMoneyTransaction(prisma, async (tx) => {
    const group = await lockGroup(tx, groupId);
    memberOf(group, userId);
    assertActive(group);
    const cycle = group.currentCycle;
    const people = joined(group).map((m) => m.userId);
    let eligible;
    let threshold = 'unanimous';
    let subjectUser = null;
    const payload = { cycle };
    if (topic === 'extend_grace') {
      if (!int(days) || days < 1 || days > LIMITS.maxGraceDays) throw new CollectiveError('invalid', `Prolongation de 1 à ${LIMITS.maxGraceDays} jours`, 400);
      payload.days = days;
      eligible = people;
      threshold = 'majority';
    } else if (topic === 'partial_release') {
      if (group.kind !== 'rotating') throw new CollectiveError('invalid', 'Pas de pot dans une épargne objectif', 409);
      const obs = await tx.collectiveObligation.findMany({ where: { groupId: group.id, cycle, status: { notIn: ['cancelled', 'refunded'] } } });
      if (obs.every((o) => SETTLED_OBLIGATION.includes(o.status))) throw new CollectiveError('cycle_complete', 'Le cycle est complet : le versement suit la règle normale', 409);
      if (obs.some((o) => o.graceUntil > new Date())) throw new CollectiveError('grace_running', 'Le délai de grâce du cycle n’est pas fini', 409);
      if (await cyclePot(tx, group.id, cycle) <= 0) throw new CollectiveError('empty_pot', 'Rien à verser', 409);
      const recipient = recipientOf(group, cycle);
      eligible = [...new Set([...obs.filter((o) => SETTLED_OBLIGATION.includes(o.status)).map((o) => o.userId), ...(recipient ? [recipient.userId] : [])])];
    } else if (topic === 'cancel') {
      const got = await receivedIds(tx, group.id);
      eligible = group.kind === 'rotating' ? people.filter((u) => !got.has(u)) : people;
      if (!eligible.length) throw new CollectiveError('invalid', 'Tout le monde a déjà reçu : le groupe se termine normalement', 409);
    } else {
      // exit: the member asks to leave; the others decide. Never after receiving the pot (obligations stay).
      if ((await receivedIds(tx, group.id)).has(userId)) throw new CollectiveError('received_cannot_exit', 'Tu as déjà reçu le pot : tes cotisations restantes restent dues', 409);
      subjectUser = userId;
      eligible = people.filter((u) => u !== userId);
    }
    if (!eligible.includes(userId) && topic !== 'exit') throw new CollectiveError('not_eligible', 'Tu ne fais pas partie des votants pour ce sujet', 403);
    const existing = await tx.collectiveVote.findFirst({ where: { groupId: group.id, topic, cycle, status: 'open', subjectUser } });
    if (existing) return { vote: existing, replayed: true };
    const vote = await tx.collectiveVote.create({
      data: { groupId: group.id, cycle, topic, proposedBy: userId, subjectUser, payloadJson: JSON.stringify({ ...payload, threshold }), eligibleJson: JSON.stringify(eligible), expiresAt: new Date(Date.now() + LIMITS.voteDays * 86_400_000) },
    });
    await event(tx, group.id, 'user', userId, 'vote_opened', { voteId: vote.id, topic, cycle });
    if (eligible.includes(userId)) await tx.collectiveBallot.create({ data: { voteId: vote.id, userId, choice: 'yes' } });
    await notify(tx, eligible.filter((u) => u !== userId), { category: 'community', kind: 'collective_vote', refId: group.id, title: 'Vote dans ton groupe', body: `Un vote est ouvert dans « ${group.name} ». Ta voix compte : rien ne change sans la règle de vote acceptée.`, dedupeKey: `collective:vote:${vote.id}` });
    const outcome = await evaluate(tx, group, vote);
    return { vote: await tx.collectiveVote.findUnique({ where: { id: vote.id } }), outcome };
  });
}

export async function castBallot(voteId, userId, choice) {
  assertEnabled();
  if (!['yes', 'no'].includes(choice)) throw new CollectiveError('invalid', 'Choix invalide', 400);
  const v0 = await prisma.collectiveVote.findUnique({ where: { id: String(voteId) } });
  if (!v0) throw notFound();
  return runMoneyTransaction(prisma, async (tx) => {
    const group = await lockGroup(tx, v0.groupId);
    memberOf(group, userId);
    const vote = await tx.collectiveVote.findUnique({ where: { id: v0.id } });
    if (vote.status !== 'open') return { vote, replayed: true };
    if (vote.expiresAt <= new Date()) throw new CollectiveError('vote_expired', 'Vote expiré', 409);
    if (!JSON.parse(vote.eligibleJson).includes(userId)) throw new CollectiveError('not_eligible', 'Tu ne fais pas partie des votants pour ce sujet', 403);
    const had = await tx.collectiveBallot.findUnique({ where: { voteId_userId: { voteId: vote.id, userId } } });
    if (had) return { vote, replayed: true };
    await tx.collectiveBallot.create({ data: { voteId: vote.id, userId, choice } });
    await event(tx, group.id, 'user', userId, 'ballot', { voteId: vote.id });
    if (group.status !== 'active' || group.frozenAt) return { vote };
    const outcome = await evaluate(tx, group, vote);
    return { vote: await tx.collectiveVote.findUnique({ where: { id: vote.id } }), outcome };
  });
}

async function evaluate(tx, group, vote) {
  const eligible = JSON.parse(vote.eligibleJson);
  const { threshold, days } = JSON.parse(vote.payloadJson);
  const ballots = await tx.collectiveBallot.findMany({ where: { voteId: vote.id } });
  const yes = ballots.filter((b) => b.choice === 'yes' && eligible.includes(b.userId)).length;
  const no = ballots.filter((b) => b.choice === 'no' && eligible.includes(b.userId)).length;
  const n = eligible.length;
  const passed = threshold === 'majority' ? yes * 2 > n : yes === n;
  const failed = threshold === 'majority' ? no * 2 >= n : no > 0;
  if (!passed && !failed) return null;
  await tx.collectiveVote.update({ where: { id: vote.id }, data: { status: passed ? 'passed' : 'failed', decidedAt: new Date() } });
  await event(tx, group.id, 'system', null, passed ? 'vote_passed' : 'vote_failed', { voteId: vote.id, topic: vote.topic, yes, no, of: n });
  if (!passed) return { passed: false };
  if (vote.topic === 'extend_grace') return { passed: true, applied: await extendGrace(tx, group, vote.cycle, days) };
  if (vote.topic === 'partial_release') {
    if (vote.cycle !== group.currentCycle || (await openDisputeOn(tx, group.id, vote.cycle))) return { passed: true, applied: null };
    return { passed: true, applied: await payCycle(tx, group, vote.cycle, 'partial_vote', { type: 'system', id: `vote:${vote.id}` }) };
  }
  if (vote.topic === 'cancel') return { passed: true, applied: await cancelActive(tx, group, `vote:${vote.id}`) };
  return { passed: true, applied: await exitMember(tx, group, vote.subjectUser, `vote:${vote.id}`, 'exited') };
}

async function extendGrace(tx, group, cycle, days) {
  const obs = await tx.collectiveObligation.findMany({ where: { groupId: group.id, cycle, status: { in: OPEN_OBLIGATION } } });
  const now = new Date();
  for (const o of obs) {
    const graceUntil = new Date(o.graceUntil.getTime() + days * 86_400_000);
    const status = graceUntil > now ? (o.amountPaidKori > 0 ? 'partial' : 'open') : o.status;
    await tx.collectiveObligation.update({ where: { id: o.id }, data: { graceUntil, status } });
  }
  return { cycle, days, obligations: obs.length };
}

/** Refund every payment still in the pot for `cycle` to the person who made it (exact, once). */
async function refundCycle(tx, group, cycle, why) {
  const pays = await tx.collectivePayment.findMany({ where: { groupId: group.id, cycle, kind: 'contribution' } });
  const refunded = new Set((await tx.collectivePayment.findMany({ where: { groupId: group.id, cycle, kind: 'refund' }, select: { reference: true } })).map((r) => r.reference));
  let total = 0;
  for (const p of pays) {
    const ref = `${p.reference}-RF`;
    if (refunded.has(ref)) continue;
    await move(tx, { from: await potAccount(tx, group.id), to: await customer(tx, p.userId), amount: p.amountKori, reference: `${ref}-J`, kind: 'collective_refund', actor: { type: 'system', id: why }, authorization: why });
    await tx.collectivePayment.create({ data: { groupId: group.id, cycle, userId: p.userId, kind: 'refund', amountKori: p.amountKori, reference: ref } });
    await historyLine(tx, p.userId, { type: 'collective_refund', amount: p.amountKori, group, note: `Remboursement · cycle ${cycle}`, ref });
    total += p.amountKori;
  }
  await tx.collectiveObligation.updateMany({ where: { groupId: group.id, cycle, status: { notIn: ['cancelled', 'refunded'] }, amountPaidKori: { gt: 0 } }, data: { status: 'refunded' } });
  await tx.collectiveObligation.updateMany({ where: { groupId: group.id, cycle, status: { notIn: ['cancelled', 'refunded'] }, amountPaidKori: 0 }, data: { status: 'cancelled' } });
  return total;
}

/** Positions for the record: what each member put in vs received. A negative position is a recorded debt — never auto-debited. */
async function statement(tx, groupId) {
  const rows = await tx.collectivePayment.groupBy({ by: ['userId', 'kind'], where: { groupId }, _sum: { amountKori: true } });
  const out = {};
  for (const r of rows) {
    const s = (out[r.userId] ??= { paidKori: 0, receivedKori: 0 });
    if (r.kind === 'contribution') s.paidKori += r._sum.amountKori;
    if (['refund', 'payout', 'catch_up', 'withdrawal'].includes(r.kind)) s.receivedKori += r._sum.amountKori;
  }
  return Object.entries(out).map(([userId, s]) => ({ userId, ...s, netKori: s.receivedKori - s.paidKori }));
}

async function cancelActive(tx, group, why) {
  let refundedKori = 0;
  if (group.kind === 'rotating') {
    if (!(await tx.collectivePayout.findUnique({ where: { groupId_cycle: { groupId: group.id, cycle: group.currentCycle } } }))) refundedKori = await refundCycle(tx, group, group.currentCycle, why);
  } else {
    for (const m of group.members) {
      const bal = Number((await shareAccount(tx, group.id, m.userId)).balance);
      if (bal > 0) { await returnShare(tx, group, m.userId, bal); refundedKori += bal; }
    }
  }
  await tx.collectiveObligation.updateMany({ where: { groupId: group.id, cycle: { gte: group.currentCycle }, status: { in: OPEN_OBLIGATION } }, data: { status: 'cancelled' } });
  await tx.collectiveGroup.update({ where: { id: group.id }, data: { status: 'cancelled', endedAt: new Date() } });
  const st = await statement(tx, group.id);
  await event(tx, group.id, 'system', null, 'cancelled', { why, refundedKori, statement: st });
  await notify(tx, joined(group).map((m) => m.userId), { category: 'money', kind: 'collective_cancelled', refId: group.id, title: 'Groupe annulé', body: `« ${group.name} » est annulé par vote. Le pot en cours a été remboursé à ceux qui l’avaient payé. Ton relevé est dans le groupe.`, dedupeKey: `collective:${group.id}:cancelled` });
  group.status = 'cancelled';
  return { refundedKori, statement: st };
}

/**
 * A member leaves an active group (vote `exit`, or an operator ruling `skip_recipient`). They have not
 * received the pot. Their future obligations are cancelled; their own turn is skipped for everyone. If
 * their turn is the current cycle, that cycle's pot is refunded to its payers. What they already paid
 * is a recorded claim in the statement (no money is taken from anyone).
 */
async function exitMember(tx, group, userId, why, status) {
  const m = group.members.find((x) => x.userId === userId && x.status === 'joined');
  if (!m) return null;
  let refundedKori = 0;
  if (group.kind === 'goal') {
    const bal = Number((await shareAccount(tx, group.id, userId)).balance);
    if (bal > 0) await returnShare(tx, group, userId, bal);
    refundedKori = bal;
  }
  // What they already paid into the current pot stays there for its recipient; nothing more is due from them.
  await tx.collectiveObligation.updateMany({ where: { groupId: group.id, userId, cycle: { gte: group.currentCycle }, status: { in: OPEN_OBLIGATION } }, data: { status: 'cancelled' } });
  const turn = m.position;
  await tx.collectiveMember.update({ where: { id: m.id }, data: { status, leftAt: new Date() } });
  m.status = status;
  if (group.kind === 'rotating' && turn) {
    if (turn === group.currentCycle) {
      refundedKori = await refundCycle(tx, group, turn, why);
      await advance(tx, group, turn);
    } else {
      await tx.collectiveObligation.updateMany({ where: { groupId: group.id, cycle: turn, status: { in: OPEN_OBLIGATION } }, data: { status: 'cancelled' } });
    }
  }
  const st = (await statement(tx, group.id)).find((s) => s.userId === userId) ?? { userId, paidKori: 0, receivedKori: 0, netKori: 0 };
  await event(tx, group.id, 'system', null, status === 'exited' ? 'member_exited' : 'member_skipped', { userId, why, refundedKori, position: turn, claim: st });
  return { userId, refundedKori, claim: st };
}

/* ── disputes (member side) ─────────────────────────────────────────────────────── */

export async function openDispute(groupId, userId, { reason }) {
  assertEnabled();
  return prisma.$transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    memberOf(group, userId);
    if (group.status !== 'active') throw new CollectiveError('not_active', 'Le groupe n’est pas en cours', 409);
    const existing = await openDisputeOn(tx, group.id, group.currentCycle);
    if (existing) return { dispute: existing, replayed: true };
    const d = await tx.collectiveDispute.create({ data: { groupId: group.id, cycle: group.currentCycle, openedBy: userId, reason: String(reason).slice(0, 1000) } });
    await event(tx, group.id, 'user', userId, 'dispute_opened', { disputeId: d.id, cycle: d.cycle });
    await notify(tx, joined(group).map((x) => x.userId), { category: 'money', kind: 'collective_dispute', refId: group.id, title: 'Litige ouvert', body: `Un membre a ouvert un litige sur le cycle ${d.cycle} de « ${group.name} ». Le versement de ce cycle attend la décision de K21.`, dedupeKey: `collective:dispute:${d.id}` });
    return { dispute: d };
  });
}

/* ── internals used by operator rulings (lib/collective/ops.js) ─────────────────── */
export const _internal = { lockGroup, payCycle, refundCycle, exitMember, cyclePot, statement, event, advance, releaseIfComplete, potAccount, shareAccount, returnShare };

/* ── maintenance (scheduler) ────────────────────────────────────────────────────── */

/**
 * Idempotent sweep. Marks missed obligations (private reminder to the member only), expires votes,
 * advances goal cycles by the calendar and closes finished goal groups (each share goes back to its
 * owner), and pays any complete rotating cycle that a closed dispute had held.
 */
export async function runCollectiveMaintenance(now = new Date()) {
  if (process.env.JOKKO_COLLECTIVE_ENABLED !== 'true') return { skipped: 'collective_disabled' };
  const out = { missed: 0, reminded: 0, votesExpired: 0, released: 0, goalsCompleted: 0, errors: [] };
  out.votesExpired = (await prisma.collectiveVote.updateMany({ where: { status: 'open', expiresAt: { lte: now } }, data: { status: 'expired', decidedAt: now } })).count;
  const missed = await prisma.collectiveObligation.findMany({ where: { status: { in: ['open', 'partial'] }, graceUntil: { lt: now }, group: { status: 'active' } }, take: 2000 });
  for (const o of missed) {
    const u = await prisma.collectiveObligation.updateMany({ where: { id: o.id, status: { in: ['open', 'partial'] } }, data: { status: 'missed' } });
    if (u.count) {
      out.missed += 1;
      await notifyEvent(prisma, o.userId, { category: 'money', kind: 'collective_missed', refId: o.groupId, title: 'Cotisation en retard', body: `Ta cotisation du cycle ${o.cycle} est en retard. Tu peux toujours la payer : rien n’est prélevé automatiquement.`, dedupeKey: `collective:missed:${o.id}` });
    }
  }
  const soon = await prisma.collectiveObligation.findMany({ where: { status: { in: ['open', 'partial'] }, dueAt: { lte: new Date(now.getTime() + 2 * 86_400_000), gt: now }, group: { status: 'active' } }, take: 2000 });
  for (const o of soon) {
    if (await notifyEvent(prisma, o.userId, { category: 'money', kind: 'collective_due', refId: o.groupId, title: 'Cotisation bientôt due', body: `Ta cotisation du cycle ${o.cycle} est due le ${o.dueAt.toLocaleDateString('fr-SN')}.`, dedupeKey: `collective:due:${o.id}` })) out.reminded += 1;
  }
  const groups = await prisma.collectiveGroup.findMany({ where: { status: 'active', frozenAt: null }, select: { id: true, kind: true } });
  for (const g of groups) {
    try {
      await runMoneyTransaction(prisma, async (tx) => {
        const group = await lockGroup(tx, g.id);
        if (group.status !== 'active' || group.frozenAt) return;
        if (group.kind === 'rotating') {
          if (await releaseIfComplete(tx, group, { type: 'system', id: 'scheduler' })) out.released += 1;
          return;
        }
        const rules = JSON.parse(group.rulesJson);
        const reached = rules.schedule.filter((s) => new Date(s.dueAt) <= now).map((s) => s.cycle);
        const cur = Math.max(1, ...reached);
        if (cur !== group.currentCycle) await tx.collectiveGroup.update({ where: { id: group.id }, data: { currentCycle: cur } });
        const last = rules.schedule[rules.schedule.length - 1];
        if (new Date(last.graceUntil) < now) {
          group.currentCycle = cur;
          for (const m of group.members) {
            const bal = Number((await shareAccount(tx, group.id, m.userId)).balance);
            if (bal > 0) await returnShare(tx, group, m.userId, bal);
          }
          await tx.collectiveGroup.update({ where: { id: group.id }, data: { status: 'completed', endedAt: now } });
          await event(tx, group.id, 'system', null, 'completed', { returnedShares: true });
          out.goalsCompleted += 1;
        }
      });
    } catch (e) {
      out.errors.push({ groupId: g.id, code: e.code ?? 'error' });
    }
  }
  return out;
}
