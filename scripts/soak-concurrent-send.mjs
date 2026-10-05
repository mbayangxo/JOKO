#!/usr/bin/env node
/**
 * J4 item P — soak the concurrent-send workload of tests/load/concurrent.test.js
 * to catch the intermittent ~1/1000 failure and record exactly what it is.
 *
 * Usage (LOCAL database only):
 *   DATABASE_URL=postgres://…localhost… node scripts/soak-concurrent-send.mjs \
 *     --rounds 20 --senders 1000 --concurrency 10 [--retry none|transient] [--out file.json]
 *
 * Each round: a FRESH recipient (so the recipient's ledger account is created
 * by the racing sends themselves, as in the load test) and N funded senders
 * all sending to it. Records for every failure: error class, Prisma / Postgres
 * code, meta, message, first stack frames; and after every round asserts no
 * money was lost or duplicated. Never weakens the workload: the default is the
 * load test's own retry policy (`transient`); `none` shows raw frequency.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { prisma } from '../lib/prisma.js';
import { transferNational } from '../lib/wallet-atomic.js';
import { testFund } from '../lib/money-kernel/index.js';
import { checkInvariants } from '../lib/money-kernel/invariants.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const ROUNDS = Number(arg('rounds', 10));
const SENDERS = Number(arg('senders', 1000));
const CONCURRENCY = Number(arg('concurrency', 10));
const RETRY = arg('retry', 'transient');
const OUT = arg('out', null);
const AMOUNT = 250;
const START = 1000;

const host = new URL(process.env.DATABASE_URL.replace(/^postgres(ql)?:/, 'http:')).hostname;
if (!/^(localhost|127\.0\.0\.1)$/.test(host)) throw new Error('soak only runs on a local database');

function isTransient(error) {
  const msg = String(error?.message ?? '');
  return error?.code === 'P1017' || /Server has closed the connection|unexpected message from server|prepared statement|Timed out|Can't reach database/i.test(msg);
}
async function withRetry(fn) {
  if (RETRY === 'none') return { value: await fn(), attempts: 1 };
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      return { value: await fn(), attempts: i + 1 };
    } catch (e) {
      if (!isTransient(e)) throw e;
      last = e;
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
  }
  throw last;
}
async function pool(tasks, limit) {
  const out = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        const t0 = Date.now();
        try {
          const r = await tasks[i]();
          out[i] = { ok: true, ms: Date.now() - t0, attempts: r?.attempts ?? 1 };
        } catch (error) {
          out[i] = { ok: false, ms: Date.now() - t0, error };
        }
      }
    }),
  );
  return out;
}
function describe(error) {
  const cause = error?.cause ?? error?.meta?.driverAdapterError?.cause;
  return {
    name: error?.name ?? null,
    ctor: error?.constructor?.name ?? null,
    code: error?.code ?? null,
    meta: error?.meta ?? null,
    pgCode: cause?.originalCode ?? cause?.code ?? error?.meta?.code ?? null,
    message: String(error?.message ?? '').trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400),
    emptyMessage: !String(error?.message ?? '').trim(),
    stack: String(error?.stack ?? '').split('\n').slice(1, 6).map((l) => l.trim()),
  };
}
const uniquePhone = () => `+22177${crypto.randomInt(1e6, 9999999)}${crypto.randomInt(10, 99)}`;

const summary = { rounds: ROUNDS, senders: SENDERS, concurrency: CONCURRENCY, retry: RETRY, sends: 0, failures: [], retriedOk: 0, roundStats: [] };
const t0 = Date.now();
for (let round = 1; round <= ROUNDS; round++) {
  const rid = crypto.randomUUID();
  const rw = crypto.randomUUID();
  await prisma.user.create({ data: { id: rid, phone: uniquePhone(), name: 'Soak recipient', country: 'SN', verificationTier: 3 } });
  await prisma.wallet.create({ data: { id: rw, userId: rid, currency: 'XOF' } });
  const senders = Array.from({ length: SENDERS }, () => ({ userId: crypto.randomUUID(), walletId: crypto.randomUUID() }));
  await prisma.user.createMany({ data: senders.map((s, i) => ({ id: s.userId, phone: uniquePhone(), name: `Soak ${i}`, country: 'SN', verificationTier: 2 })) });
  await prisma.wallet.createMany({ data: senders.map((s) => ({ id: s.walletId, userId: s.userId, currency: 'XOF' })) });
  const funded = await pool(
    senders.map((s) => () => withRetry(() => prisma.$transaction((tx) => testFund(tx, { userId: s.userId, amount: START, reference: `SOAKF-${s.userId}` })))),
    CONCURRENCY,
  );
  if (funded.some((r) => !r.ok)) throw funded.find((r) => !r.ok).error;

  const started = Date.now();
  const results = await pool(
    senders.map((s) => () =>
      withRetry(() =>
        prisma.$transaction(
          (tx) =>
            transferNational(tx, {
              amount: AMOUNT,
              senderWalletId: s.walletId,
              recipientWalletId: rw,
              senderUserId: s.userId,
              recipientUserId: rid,
              reference: `SOAK-${s.userId}`,
              senderLedger: { type: 'send' },
              recipientLedger: { type: 'receive' },
            }),
          { maxWait: 120_000, timeout: 60_000 },
        ),
      ),
    ),
    CONCURRENCY,
  );
  const failed = results.map((r, i) => ({ ...r, i })).filter((r) => !r.ok);
  summary.sends += SENDERS;
  summary.retriedOk += results.filter((r) => r.ok && r.attempts > 1).length;

  // Money check: every failure rolled back completely; every success exactly once.
  const okCount = SENDERS - failed.length;
  const rec = await prisma.wallet.findUnique({ where: { id: rw } });
  const entries = await prisma.journalEntry.count({ where: { reference: { in: senders.map((s) => `SOAK-${s.userId}`) } } });
  const failedIds = failed.map((f) => senders[f.i].walletId);
  const failedBal = failedIds.length ? await prisma.wallet.findMany({ where: { id: { in: failedIds } }, select: { koriBalance: true } }) : [];
  const moneyOk = rec.koriBalance === okCount * AMOUNT && entries === okCount && failedBal.every((w) => w.koriBalance === START);
  for (const f of failed) {
    summary.failures.push({ round, index: f.i, ms: f.ms, rolledBack: failedBal.length ? true : null, ...describe(f.error) });
  }
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const stat = { round, failed: failed.length, moneyOk, wallMs: Date.now() - started, p50: ms[Math.floor(ms.length / 2)], p99: ms[Math.floor(ms.length * 0.99)], max: ms[ms.length - 1] };
  summary.roundStats.push(stat);
  console.log(JSON.stringify(stat));
  if (!moneyOk) {
    console.error('MONEY MISMATCH — stopping', { rec: rec.koriBalance, okCount, entries });
    break;
  }
}
const inv = await checkInvariants(prisma);
summary.invariants = inv.ok ? 'ok' : inv.violations.map((v) => v.id);
summary.elapsedS = Math.round((Date.now() - t0) / 1000);
summary.failureRate = summary.failures.length / summary.sends;
summary.byCode = summary.failures.reduce((m, f) => ((m[`${f.ctor}:${f.code ?? '-'}:${f.pgCode ?? '-'}`] = (m[`${f.ctor}:${f.code ?? '-'}:${f.pgCode ?? '-'}`] ?? 0) + 1), m), {});
console.log(JSON.stringify({ ...summary, failures: summary.failures.slice(0, 10) }, null, 2));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
await prisma.$disconnect();
// Non-zero on any failure, money mismatch or invariant violation (gate use).
process.exitCode = summary.failures.length === 0 && summary.invariants === 'ok' && summary.roundStats.every((r) => r.moneyOk) ? 0 : 1;
