/**
 * S-P + S-M mixed: the p2p scenario (send / double tap / retry-after-unknown / undo / reads) PLUS contested
 * money requests (two concurrent accepts by the payer on two workers, or accept ‖ deny) and contested merchant QR
 * charges (two payers racing, sometimes the owner cancelling at the same time). Operation content is a pure
 * function of (seed, op index), as in p2p.
 *
 * Audit, on top of p2p's: every request is paid at most once and its status matches the ledger (accepted ⇔ exactly
 * one entry under its reference); every charge is paid at most once and its status matches the ledger (paid ⇔
 * exactly one charge_payment entry; open / cancelled / expired ⇔ none).
 */
import { fundUser, prisma } from '../../../tests/helpers/db.js';
import { business, customer, signedIn } from '../../../tests/j3/helpers.js';
import { rngFor } from '../prng.mjs';
import * as p2p from './p2p.mjs';

export const name = 'mixed';
export const crons = p2p.crons;

export async function setup(cluster, { seed, users = 24 }) {
  const ctx = await p2p.setup(cluster, { seed, users });
  ctx.merchants = [];
  for (let i = 0; i < 4; i += 1) {
    const c = await customer({ koriBalance: 0 });
    const s = await signedIn(cluster.apiFor(`mlogin:${seed}:${i}`), c);
    const api = cluster.apiFor(`merchant:${seed}:${i}`);
    s.call = (method, p, body, extra = {}) =>
      api.client(method, p, { token: s.token, device: s.device, ip: s.ip, headers: { ...(extra.headers ?? {}) }, body: method === 'GET' ? undefined : body, worker: extra.worker });
    const biz = await business(s);
    ctx.merchants.push({ s, biz });
  }
  ctx.requests = [];
  ctx.charges = [];
  // Fund payers again so contested flows are not starved by the p2p traffic.
  for (const a of ctx.actors) await fundUser(a.s.id, 10_000);
  return ctx;
}

const key = (rng) => `lab-${Math.floor(rng() * 2 ** 48).toString(16).padStart(12, '0')}`;

export async function step(ctx, i, opts) {
  const rng = rngFor(opts.seed ^ 0x5bd1e995, i);
  const roll = rng();
  if (roll < 0.55) return p2p.step(ctx, i, opts);
  const { actors, merchants } = ctx;
  const a = actors[Math.floor(rng() * actors.length)];
  let b = actors[Math.floor(rng() * actors.length)];
  if (b === a) b = actors[(a.i + 1) % actors.length];
  const w = Math.floor(rng() * opts.apiWorkers);
  const out = [];
  const t0 = Date.now();
  if (roll < 0.75) {
    // Money request: a asks b; b accepts twice at once on two workers, or accepts ‖ denies.
    const req = await a.s.call('POST', 'transfers/request', { recipientHandle: b.s.handle, amount: 1 + Math.floor(rng() * 400) });
    if (req.status !== 201) { out.push({ op: i, kind: 'request_create', status: req.status, code: req.body?.code ?? null, network: Boolean(req.network), t0, ms: Date.now() - t0 }); return out; }
    ctx.requests.push(req.body.id);
    const deny = rng() < 0.3;
    const rs = await Promise.all([
      b.s.call('POST', `transfers/requests/${req.body.id}/accept`, {}, { worker: w }),
      deny ? b.s.call('POST', `transfers/requests/${req.body.id}/deny`, {}, { worker: (w + 1) % opts.apiWorkers })
        : b.s.call('POST', `transfers/requests/${req.body.id}/accept`, {}, { worker: (w + 1) % opts.apiWorkers }),
    ]);
    for (const r of rs) out.push({ op: i, kind: 'request_respond', requestId: req.body.id, status: r.status, code: r.body?.code ?? null, network: Boolean(r.network), t0, ms: Date.now() - t0 });
  } else {
    // Merchant charge: two payers race; sometimes the owner cancels at the same moment.
    const m = merchants[Math.floor(rng() * merchants.length)];
    const amountKori = 1 + Math.floor(rng() * 500);
    const ch = await m.s.call('POST', 'money/charges', { businessId: m.biz.id, amountKori });
    if (ch.status !== 201) { out.push({ op: i, kind: 'charge_create', status: ch.status, code: ch.body?.code ?? null, network: Boolean(ch.network), t0, ms: Date.now() - t0 }); return out; }
    ctx.charges.push(ch.body.code);
    const cancel = rng() < 0.25;
    const rs = await Promise.all([
      a.s.call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: amountKori }, { headers: { 'idempotency-key': key(rng) }, worker: w }),
      b.s.call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: amountKori }, { headers: { 'idempotency-key': key(rng) }, worker: (w + 1) % opts.apiWorkers }),
      ...(cancel ? [m.s.call('POST', `money/charges/${ch.body.code}/cancel`, {}, { worker: (w + 2) % opts.apiWorkers })] : []),
    ]);
    for (const r of rs) out.push({ op: i, kind: 'charge_race', code: ch.body.code, status: r.status, errCode: r.body?.code ?? null, network: Boolean(r.network), t0, ms: Date.now() - t0 });
  }
  return out;
}

export async function audit(ctx, records) {
  // Paid money requests are p2p_transfer entries under the request's own reference (no client key): known, not phantom.
  ctx.knownReferences = ctx.requests.length
    ? (await prisma.moneyRequest.findMany({ where: { id: { in: ctx.requests } }, select: { reference: true } })).map((r) => r.reference)
    : [];
  const base = await p2p.audit(ctx, records);
  const findings = [...base.findings];
  const stats = { ...base.stats, requests: ctx.requests.length, charges: ctx.charges.length, requestsPaid: 0, chargesPaid: 0 };
  if (ctx.requests.length) {
    const rows = await prisma.moneyRequest.findMany({ where: { id: { in: ctx.requests } }, select: { id: true, status: true, reference: true } });
    const entries = await prisma.journalEntry.groupBy({ by: ['reference'], where: { reference: { in: rows.map((r) => r.reference) }, kind: 'p2p_transfer' }, _count: true });
    const n = new Map(entries.map((e) => [e.reference, e._count]));
    for (const r of rows) {
      const c = n.get(r.reference) ?? 0;
      if (c > 1) findings.push({ check: 'exactly_once', id: 'request_paid_twice', request: r.id, n: c });
      if (r.status === 'accepted' && c !== 1) findings.push({ check: 'settlement', id: 'request_accepted_without_payment', request: r.id });
      if (r.status !== 'accepted' && c > 0) findings.push({ check: 'settlement', id: 'request_paid_but_not_accepted', request: r.id, status: r.status });
      if (r.status === 'accepted') stats.requestsPaid += 1;
    }
  }
  if (ctx.charges.length) {
    const rows = await prisma.merchantCharge.findMany({ where: { code: { in: ctx.charges } }, select: { code: true, status: true } });
    for (const r of rows) {
      const c = await prisma.journalEntry.count({ where: { kind: 'charge_payment', reference: { startsWith: `charge:${r.code}` } } });
      if (c > 1) findings.push({ check: 'exactly_once', id: 'charge_paid_twice', charge: r.code, n: c });
      if (r.status === 'paid' && c !== 1) findings.push({ check: 'settlement', id: 'charge_paid_without_entry', charge: r.code });
      if (r.status !== 'paid' && c > 0) findings.push({ check: 'settlement', id: 'charge_entry_but_not_paid', charge: r.code, status: r.status });
      if (r.status === 'paid') stats.chargesPaid += 1;
    }
  }
  return { findings, stats };
}
