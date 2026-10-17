import { prisma } from '../prisma.js';
import { cashLimits, agentTransactionCap } from './limits.js';
import { normalizeStatus } from './lifecycle.js';
import { commissionSummary } from './commission.js';
import { cashView } from './cash.js';

/**
 * J6.8 liquidity, J6.10 reconciliation (hard gate), J6.11 support inspection.
 * Read-only. There is no "make it match" action anywhere here: corrections are
 * authorized compensating entries (maker-checker adjustments / review
 * resolutions) and every mismatch becomes an explicit ReconciliationException.
 */
const num = (v) => Number(v ?? 0);
const accBal = async (db, code) => num((await db.ledgerAccount.findUnique({ where: { code } }))?.balance);
const OPEN_CASH_IN_HELD = ['agent_bound', 'customer_confirmed', 'needs_review'];
const OPEN_CASH_OUT_HELD = ['funds_held', 'agent_bound', 'customer_authorized', 'needs_review', 'risk_hold'];

// ── J6.8 liquidity ──────────────────────────────────────────────────────────

export async function liquidityView(db = prisma, { now = new Date() } = {}) {
  const L = cashLimits();
  const agents = await db.agentProfile.findMany({ where: { status: { in: ['active', 'suspended'] } }, orderBy: { agentCode: 'asc' } });
  const since7 = new Date(now.getTime() - 7 * 86_400_000);
  const rows = [];
  for (const a of agents) {
    const [held, pendingIn, pendingOut, vol, report] = await Promise.all([
      accBal(db, `agent:${a.id}:float_held`),
      db.agentCashTransaction.aggregate({ where: { agentId: a.id, kind: 'cash_in', state: { in: OPEN_CASH_IN_HELD } }, _sum: { amountXof: true }, _count: true }),
      db.agentCashTransaction.aggregate({ where: { agentId: a.id, kind: 'cash_out', state: { in: ['agent_bound', 'customer_authorized', 'needs_review'] } }, _sum: { amountXof: true }, _count: true }),
      db.agentCashTransaction.groupBy({ by: ['kind'], where: { agentId: a.id, state: 'completed', completedAt: { gte: since7 } }, _sum: { amountXof: true }, _count: true }),
      db.agentCashReport.findFirst({ where: { agentId: a.id }, orderBy: { createdAt: 'desc' } }),
    ]);
    const inflightOut = pendingOut._sum.amountXof ?? 0;
    const v = Object.fromEntries(vol.map((g) => [g.kind, { amountXof: g._sum.amountXof ?? 0, count: g._count }]));
    rows.push({
      agentId: a.id,
      agentCode: a.agentCode,
      status: normalizeStatus(a.status),
      tier: a.tier,
      electronicFloat: { availableXof: a.floatBalance, heldXof: held, limitXof: a.floatLimit, source: 'ledger' },
      pending: { cashIn: { count: pendingIn._count, amountXof: pendingIn._sum.amountXof ?? 0 }, cashOut: { count: pendingOut._count, amountXof: inflightOut } },
      cashOutCapacityXof: Math.max(0, a.floatLimit - a.floatBalance - inflightOut),
      lowFloat: a.floatBalance < L.lowFloatXof,
      demand7d: { cashIn: v.cash_in ?? { amountXof: 0, count: 0 }, cashOut: v.cash_out ?? { amountXof: 0, count: 0 } },
      replenishment: {
        needsElectronicFloat: a.floatBalance < L.lowFloatXof,
        // e-float near its limit = the agent has paid out a lot of cash and holds little.
        likelyNeedsPhysicalCash: a.floatLimit - a.floatBalance - inflightOut < L.lowFloatXof,
        basis: 'ledger float only — physical cash is not observed',
      },
      physicalCash: report ? { amountXof: report.amountXof, reportedAt: report.createdAt.toISOString(), source: 'self_reported', authoritative: false } : null,
    });
  }
  return { generatedAt: now.toISOString(), agents: rows, rebalancing: 'ARCHITECTED-DORMANT', cashPrediction: 'NOT IMPLEMENTED' };
}

// ── J6.10 reconciliation ────────────────────────────────────────────────────

async function refs(db, prefix) {
  const rows = await db.journalEntry.findMany({ where: { reference: { startsWith: prefix } }, select: { reference: true } });
  return new Set(rows.map((r) => r.reference));
}

function txExpectation(t, have) {
  const hold = have.has(`${t.reference}-HOLD`);
  const done = have.has(`${t.reference}-COMPLETE`);
  const rel = have.has(`${t.reference}-RELEASE`);
  const problems = [];
  if (t.state === 'completed') {
    if (!done) problems.push('completed without completion posting');
    if (rel) problems.push('completed AND released');
    if (!hold) problems.push('completed without hold');
  } else if (['cancelled', 'declined', 'expired', 'released'].includes(t.state)) {
    if (done) problems.push(`${t.state} but completion posted`);
    if (hold && !rel) problems.push(`${t.state} but hold never released`);
    if (rel && !hold) problems.push('release without hold');
  } else {
    if (done) problems.push(`open (${t.state}) but completion posted`);
    if (rel) problems.push(`open (${t.state}) but released`);
    const mustHold = t.kind === 'cash_out' ? OPEN_CASH_OUT_HELD.includes(t.state) : OPEN_CASH_IN_HELD.includes(t.state);
    if (mustHold && !hold) problems.push(`open (${t.state}) without hold`);
  }
  return problems;
}

export async function reconcileAgents(db = prisma, { record = true } = {}) {
  const exceptions = [];
  const add = (kind, ref, detail, amount = null) => exceptions.push({ kind, ref, detail, amount });
  const agents = await db.agentProfile.findMany();
  for (const a of agents) {
    const ledgerFloat = await accBal(db, `agent:${a.id}:float`);
    if (ledgerFloat !== a.floatBalance && (await db.ledgerAccount.findUnique({ where: { code: `agent:${a.id}:float` } }))) {
      add('agent_float_projection', a.id, `ledger ${ledgerFloat} ≠ projection ${a.floatBalance}`, ledgerFloat - a.floatBalance);
    }
    const held = await accBal(db, `agent:${a.id}:float_held`);
    const openIn = await db.agentCashTransaction.aggregate({ where: { agentId: a.id, kind: 'cash_in', state: { in: OPEN_CASH_IN_HELD } }, _sum: { amountXof: true } });
    if (held !== (openIn._sum.amountXof ?? 0)) add('agent_float_held_mismatch', a.id, `held ${held} ≠ open bound cash-ins ${openIn._sum.amountXof ?? 0}`, held - (openIn._sum.amountXof ?? 0));
    const comm = await accBal(db, `agent:${a.id}:commission`);
    const s = await commissionSummary(db, a.id);
    if (comm !== s.accrued.amountKori) add('agent_commission_mismatch', a.id, `commission account ${comm} ≠ accrued ${s.accrued.amountKori}`, comm - s.accrued.amountKori);
    if (normalizeStatus(a.status) === 'terminated' && (ledgerFloat > 0 || comm > 0)) add('terminated_agent_owed', a.id, `terminated agent still owed float ${ledgerFloat} XOF / commission ${comm} ₭ — finance settles`);
  }
  const txs = await db.agentCashTransaction.findMany({ select: { id: true, reference: true, kind: true, state: true, amountXof: true, amountKori: true, agentId: true, commissionKori: true } });
  const have = new Set([...(await refs(db, 'JCI-')), ...(await refs(db, 'JCO-'))]);
  for (const t of txs) {
    for (const p of txExpectation(t, have)) add('agent_tx_posting', t.reference, p, t.amountXof);
  }
  // Commissions ↔ completed eligible transactions (one row per completed tx, none for others).
  const comms = await db.agentCommission.findMany({ select: { txId: true, status: true, amountKori: true, ledgerReference: true } });
  const byTx = new Map(comms.map((c) => [c.txId, c]));
  for (const t of txs) {
    const c = byTx.get(t.id);
    if (t.state === 'completed' && !c) add('agent_commission_missing', t.reference, 'completed transaction has no commission decision');
    if (t.state !== 'completed' && c) add('agent_commission_orphan', t.reference, `commission for a ${t.state} transaction`);
    if (c && ['accrued', 'settled', 'clawed_back'].includes(c.status) && !(await db.journalEntry.findUnique({ where: { reference: c.ledgerReference ?? '' } }))) {
      add('agent_commission_unposted', t.reference, `commission ${c.status} without accrual posting`);
    }
  }
  if (record) {
    for (const e of exceptions) {
      await db.reconciliationException.upsert({
        where: { kind_provider_providerReference: { kind: e.kind, provider: 'agent_network', providerReference: e.ref } },
        create: { kind: e.kind, provider: 'agent_network', providerReference: e.ref, amountMinor: e.amount == null ? null : BigInt(Math.trunc(e.amount)), currency: 'XOF', detail: e.detail.slice(0, 500) },
        update: {},
      });
    }
  }
  const totals = await db.agentCashTransaction.groupBy({ by: ['kind', 'state'], _sum: { amountXof: true }, _count: true });
  return { ok: exceptions.length === 0, agents: agents.length, transactions: txs.length, exceptions, totals: totals.map((g) => ({ kind: g.kind, state: g.state, count: g._count, amountXof: g._sum.amountXof ?? 0 })) };
}

// ── J6.11 support / ops inspection (read-only) ──────────────────────────────

export async function agentOverview(db = prisma, agentId) {
  const a = await db.agentProfile.findUnique({ where: { id: agentId } });
  if (!a) return null;
  const [events, sp, org, txs, comm, exc, report] = await Promise.all([
    db.agentStatusEvent.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' } }),
    a.servicePointId ? db.agentServicePoint.findUnique({ where: { id: a.servicePointId } }) : null,
    a.organizationId ? db.agentOrganization.findUnique({ where: { id: a.organizationId } }) : null,
    db.agentCashTransaction.findMany({ where: { agentId }, orderBy: { createdAt: 'desc' }, take: 30 }),
    commissionSummary(db, agentId),
    db.reconciliationException.findMany({ where: { provider: 'agent_network', status: 'open', OR: [{ providerReference: agentId }] }, take: 50 }),
    db.agentCashReport.findFirst({ where: { agentId }, orderBy: { createdAt: 'desc' } }),
  ]);
  return {
    agent: {
      id: a.id, agentCode: a.agentCode, displayName: a.displayName, agentType: a.agentType, tier: a.tier, status: normalizeStatus(a.status),
      lifecycle: events.map((e) => ({ from: e.fromStatus, to: e.toStatus, actorType: e.actorType, actorId: e.actorId, reason: e.reason, at: e.createdAt.toISOString() })),
      suspensionReason: a.suspensionReason, terminationReason: a.terminationReason,
    },
    organization: org ? { id: org.id, kind: org.kind, name: org.name, status: org.status } : null,
    servicePoint: sp ? { id: sp.id, name: sp.name, publicAddress: sp.publicAddress, status: sp.status, cashIn: sp.cashIn, cashOut: sp.cashOut, merchantAssist: sp.merchantAssist, merchantAssistPermitted: sp.merchantAssistPermitted } : null,
    float: { availableXof: a.floatBalance, heldXof: await accBal(db, `agent:${a.id}:float_held`), limitXof: a.floatLimit, source: 'ledger' },
    limits: { cashInPerTransactionXof: agentTransactionCap(a, 'cash_in'), cashOutPerTransactionXof: agentTransactionCap(a, 'cash_out') },
    commissions: comm,
    transactions: await Promise.all(txs.map((t) => cashView(t, 'agent'))),
    riskHolds: txs.filter((t) => ['risk_hold', 'needs_review'].includes(t.state)).map((t) => ({ id: t.id, reference: t.reference, state: t.state, riskReasons: t.riskReasons ? JSON.parse(t.riskReasons) : [] })),
    reconciliationExceptions: exc.map((e) => ({ id: e.id, kind: e.kind, detail: e.detail, createdAt: e.createdAt.toISOString() })),
    physicalCash: report ? { amountXof: report.amountXof, reportedAt: report.createdAt.toISOString(), source: 'self_reported' } : null,
  };
}
