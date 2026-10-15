#!/usr/bin/env node
/**
 * J15 L1 S-K: kernel storm across PROCESSES (local only). P child processes each fire N concurrent spends
 * from ONE shared customer balance (and, in the same transactions' neighbourhood, credits into one hot
 * recipient), directly through the J2 kernel (runMoneyTransaction + move), with the lab fault points live
 * (ledger.post errors, slow commits). Exactly the multi-process contention a single test process cannot show.
 *
 *   node scripts/lab/kernel-storm.mjs --procs 4 --per 250 --fund 200000 --seed 7 --faults <file> --out <dir>
 *
 * Proof obligations: Σ successful spends ≤ funding; final balance = funding − Σ successes exactly; no
 * negative balance; every refusal is InsufficientFunds (or the injected fault), never a silent partial;
 * oracle clean on one snapshot after the storm.
 */
import '../../tests/helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../lib/prisma.js';
import { runMoneyTransaction } from '../../lib/wallet-atomic.js';
import { customer as customerAccount, move, testFund } from '../../lib/money-kernel/flows.js';
import { InsufficientFundsError } from '../../lib/money-kernel/errors.js';
import { createUserWithWallet } from '../../tests/helpers/db.js';
import { rngFor } from './prng.mjs';
import { runOracle } from './oracle.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []));
const self = fileURLToPath(import.meta.url);

async function child() {
  const { src, sinks, per, seed, proc } = JSON.parse(args.child);
  const lat = [];
  const out = { ok: 0, okKori: 0, insufficient: 0, injected: 0, other: 0, otherSamples: [] };
  await Promise.all(Array.from({ length: per }, async (_, j) => {
    const rng = rngFor(seed, proc * 100_000 + j);
    const amount = 1 + Math.floor(rng() * 2000);
    const to = sinks[Math.floor(rng() * sinks.length)];
    const t0 = performance.now();
    try {
      await runMoneyTransaction(prisma, async (tx) => move(tx, {
        from: await customerAccount(tx, src), to: await customerAccount(tx, to), amount, reference: `KS-${seed}-${proc}-${j}`, kind: 'p2p_transfer', actor: { type: 'user', id: src },
      }));
      out.ok += 1;
      out.okKori += amount;
    } catch (e) {
      if (e instanceof InsufficientFundsError) out.insufficient += 1;
      else if (e?.name === 'LabFaultError') out.injected += 1;
      else { out.other += 1; if (out.otherSamples.length < 3) out.otherSamples.push(String(e?.code ?? e?.message ?? e).slice(0, 160)); }
    } finally {
      lat.push(performance.now() - t0);
    }
  }));
  out.lat = lat;
  process.stdout.write(`${JSON.stringify(out)}\n`);
  await prisma.$disconnect();
}

async function parent() {
  const procs = Number(args.procs ?? 4);
  const per = Number(args.per ?? 250);
  const fund = Number(args.fund ?? 200_000);
  const seed = Number(args.seed ?? 7);
  const runDir = path.resolve(args.out ?? `lab-runs/kernel-storm-${seed}-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });
  const faultFile = args.faults ? path.resolve(args.faults) : null;
  const src = await createUserWithWallet({ koriBalance: 0 });
  await runMoneyTransaction(prisma, (tx) => testFund(tx, { userId: src.id, amount: fund, reference: `KS-FUND-${seed}-${Date.now()}` }));
  const sinks = [];
  for (let i = 0; i < 8; i += 1) sinks.push((await createUserWithWallet({ koriBalance: 0 })).id);
  const before = await runOracle(prisma);
  const sig = (f) => `${f.check}:${f.id}:${f.detail ?? ''}`;
  const pre = new Set(before.findings.map(sig));
  const env = { ...process.env, JOKKO_LAB: 'true', JOKKO_LAB_ALLOW: 'local-only', JOKKO_LAB_EVENT_LOG: path.join(runDir, 'faults.jsonl'), ...(faultFile ? { JOKKO_LAB_FAULT_FILE: faultFile } : {}) };
  delete env.VERCEL; delete env.VERCEL_ENV;
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: procs }, (_, proc) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [self, '--child', JSON.stringify({ src: src.id, sinks, per, seed, proc })], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    let se = '';
    c.stdout.on('data', (d) => { so += d; });
    c.stderr.on('data', (d) => { se += d; });
    c.on('exit', (code) => (code === 0 ? resolve(JSON.parse(so.trim().split('\n').pop())) : reject(new Error(`child ${proc} exit ${code}: ${se.slice(-800)}`))));
  })));
  const wallMs = Date.now() - t0;
  const okKori = results.reduce((s, r) => s + r.okKori, 0);
  const acct = await prisma.ledgerAccount.findUnique({ where: { code: `customer:${src.id}:available` } });
  const finalBalance = Number(acct.balance);
  const after = await runOracle(prisma);
  const fresh = after.findings.filter((f) => !pre.has(sig(f)));
  const lat = results.flatMap((r) => r.lat).sort((a, b) => a - b);
  const pct = (p) => Math.round(lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]);
  const findings = [];
  if (finalBalance !== fund - okKori) findings.push({ id: 'balance_mismatch', expected: fund - okKori, finalBalance });
  if (okKori > fund) findings.push({ id: 'overspend', okKori, fund });
  if (finalBalance < 0) findings.push({ id: 'negative', finalBalance });
  const other = results.reduce((s, r) => s + r.other, 0);
  if (other) findings.push({ id: 'unexpected_errors', n: other, samples: results.flatMap((r) => r.otherSamples).slice(0, 5) });
  findings.push(...fresh.map((f) => ({ id: `oracle:${f.check}:${f.id}`, detail: f.detail })));
  const report = {
    verdict: findings.length ? 'VIOLATION' : 'CLEAN',
    seed, procs, per, fund, wallMs,
    attempts: procs * per,
    ok: results.reduce((s, r) => s + r.ok, 0), okKori, insufficient: results.reduce((s, r) => s + r.insufficient, 0), injected: results.reduce((s, r) => s + r.injected, 0), other,
    finalBalance, latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99), max: Math.round(lat[lat.length - 1]) },
    oracleMs: after.ms, findings,
  };
  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  await prisma.$disconnect();
  process.exit(findings.length ? 1 : 0);
}

if (args.child) await child();
else await parent();
