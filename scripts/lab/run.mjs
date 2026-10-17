#!/usr/bin/env node
/**
 * J15 financial torture lab runner (LOCAL ONLY — never against a deployed database).
 *
 *   node scripts/lab/run.mjs --scenario p2p --seed 42 --ops 600 --concurrency 12 \
 *        --api 4 --cron 2 --faults scripts/lab/faults/crash-mix.json --out <dir>
 *   node scripts/lab/run.mjs --replay <dir>            # same seed, scenario, sizes and fault schedule
 *
 * Exit 0 = no new oracle finding and a clean outcome audit; 1 = a violation (details in <dir>/results.json).
 * Determinism: the CONTENT of every operation and the fault schedule are reproducible from the manifest;
 * the interleaving of concurrent operations (and so which request a per-process fault lands on) is not.
 */
import '../../tests/helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { prisma } from '../../lib/prisma.js';
import { startCluster } from './cluster.mjs';
import { runOracle } from './oracle.mjs';

const SCENARIOS = { p2p: () => import('./scenarios/p2p.mjs'), mixed: () => import('./scenarios/mixed.mjs') };

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : 'true';
    o[k] = v;
  }
  return o;
}

function guardLocal() {
  const url = new URL(process.env.DATABASE_URL.replace(/^postgres(ql)?:/, 'http:'));
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) || process.env.VERCEL || process.env.VERCEL_ENV) {
    console.error('The lab runs only against a local database.');
    process.exit(2);
  }
}

export async function runLab(opts) {
  guardLocal();
  const runDir = path.resolve(opts.out ?? `lab-runs/${opts.scenario}-${opts.seed}-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });
  const faults = opts.faultsJson ?? (opts.faults ? JSON.parse(fs.readFileSync(opts.faults, 'utf8')) : { faults: [] });
  const manifest = {
    scenario: opts.scenario,
    seed: Number(opts.seed),
    ops: Number(opts.ops ?? 300),
    durationMs: opts.durationMs ? Number(opts.durationMs) : null, // soak: run by time instead of op count
    windowSec: Number(opts.windowSec ?? 900),
    concurrency: Number(opts.concurrency ?? 8),
    api: Number(opts.api ?? 4),
    cron: Number(opts.cron ?? 2),
    users: Number(opts.users ?? 24),
    merchants: Number(opts.merchants ?? 4),
    oracleMs: Number(opts.oracleMs ?? 1000),
    cronMs: Number(opts.cronMs ?? 2000),
    leaseMs: Number(opts.leaseMs ?? 3000),
    faults,
    commit: (() => { try { return execSync('git rev-parse HEAD').toString().trim(); } catch { return null; } })(),
    dirty: (() => { try { return execSync('git status --porcelain -- lib api prisma scripts/lab').toString().trim().length > 0; } catch { return null; } })(),
    node: process.version,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const faultFile = path.join(runDir, 'faults.active.json');
  fs.writeFileSync(faultFile, JSON.stringify({ faults: [] })); // armed only after setup

  const scenario = await SCENARIOS[manifest.scenario]();
  const cluster = await startCluster({ apiWorkers: manifest.api, cronWorkers: manifest.cron, runDir, faultFile, extraEnv: { IDEMPOTENCY_STALE_LEASE_MS: String(manifest.leaseMs) } });
  const oracleRuns = [];
  const records = [];
  let stop = false;
  let violation = null;
  try {
    const baseline = await runOracle(prisma);
    const sig = (f) => `${f.check}:${f.id}:${f.detail ?? ''}`;
    const preexisting = new Set(baseline.findings.map(sig));
    const ctx = await scenario.setup(cluster, { seed: manifest.seed, users: manifest.users, merchants: manifest.merchants });
    ctx.startedAt = new Date();
    fs.writeFileSync(faultFile, JSON.stringify(faults)); // arm the schedule

    const oracleLoop = (async () => {
      while (!stop) {
        const r = await runOracle(prisma, { since: ctx.startedAt }).catch((e) => ({ ok: false, findings: [{ check: 'oracle', id: 'oracle_error', detail: String(e).slice(0, 300) }], ms: 0 }));
        const fresh = r.findings.filter((f) => !preexisting.has(sig(f)));
        oracleRuns.push({ t: Date.now(), ms: r.ms, fresh: fresh.length });
        if (oracleRuns.length % 60 === 0) {
          // Checkpoint the evidence (an environment restart loses the in-memory samples); a partial run is never a pass.
          try { fs.writeFileSync(path.join(runDir, 'checkpoint.json'), JSON.stringify({ t: new Date().toISOString(), latencyWindows: cluster.windowReport(manifest.windowSec), latency: cluster.latencyReport(), oracleRuns: oracleRuns.length, restarts: cluster.restarts(), rssMb: cluster.rss() })); } catch { /* best-effort */ }
          try { fs.appendFileSync(path.join(runDir, 'progress.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), opsIssued: next, records: records.length, oracleRuns: oracleRuns.length, oracleMaxMs: Math.max(...oracleRuns.map((x) => x.ms)), restarts: cluster.restarts(), rssMb: cluster.rss() })}\n`); } catch { /* progress is best-effort */ }
        }
        if (fresh.length) { violation = { during: true, findings: fresh }; stop = true; break; }
        await new Promise((res) => setTimeout(res, manifest.oracleMs));
      }
    })();
    let cronTick = 0;
    const cronLoop = (async () => {
      while (!stop) {
        for (const name of scenario.crons ?? []) await cluster.runCron(cronTick, name);
        cronTick += 1;
        await new Promise((res) => setTimeout(res, manifest.cronMs));
      }
    })();

    let next = 0;
    const lanes = Array.from({ length: manifest.concurrency }, async () => {
      while (!stop) {
        const i = next;
        next += 1;
        if (manifest.durationMs ? Date.now() - ctx.startedAt.getTime() >= manifest.durationMs : i >= manifest.ops) return;
        const recs = await scenario.step(ctx, i, { seed: manifest.seed, apiWorkers: manifest.api });
        records.push(...recs);
      }
    });
    await Promise.all(lanes);
    const loadDone = Date.now();
    const phase = (name) => console.error(`[lab] ${new Date().toISOString()} ${name}`);
    // Client observations first: a post-load phase that dies still leaves what the audit needs.
    fs.writeFileSync(path.join(runDir, 'records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n'));
    phase(`load done, ${records.length} records written; quiesce`);
    // Quiesce: disarm faults, let every worker come back, run the reconciliation jobs, then judge.
    fs.writeFileSync(faultFile, JSON.stringify({ faults: [] }));
    await Promise.all([...cluster.api, ...cluster.cron].map((w) => w.url()));
    // Every abandoned key is now older than the lease: the reconciliation jobs must converge all of them.
    await new Promise((res) => setTimeout(res, manifest.leaseMs + 500));
    for (let k = 0; k < manifest.cron * 2; k += 1) for (const name of scenario.crons ?? []) await cluster.runCron(k, name);
    stop = true;
    await Promise.all([oracleLoop, cronLoop]);
    phase('final oracle');
    const final = await runOracle(prisma, { since: ctx.startedAt });
    const finalFresh = final.findings.filter((f) => !preexisting.has(sig(f)));
    phase('outcome audit');
    const audit = await scenario.audit(ctx, records);
    phase('audit done');
    const firedByPoint = {};
    for (const f of cluster.faultLog()) firedByPoint[`${f.point}:${f.action}`] = (firedByPoint[`${f.point}:${f.action}`] ?? 0) + 1;
    const results = {
      verdict: !violation && finalFresh.length === 0 && audit.findings.length === 0 ? 'CLEAN' : 'VIOLATION',
      manifest,
      durationMs: loadDone - ctx.startedAt.getTime(),
      ops: manifest.durationMs ? next : Math.min(next, manifest.ops),
      requests: records.length,
      oracle: { runs: oracleRuns.length, maxMs: Math.max(0, ...oracleRuns.map((r) => r.ms)), preexisting: [...preexisting], duringLoad: violation, final: finalFresh },
      audit,
      faultsFired: firedByPoint,
      restarts: cluster.restarts(),
      workerEvents: cluster.events.map((e) => ({ ...e, tail: undefined })),
      latency: cluster.latencyReport(),
      latencyWindows: cluster.windowReport(manifest.windowSec),
    };
    fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(runDir, 'worker-events.json'), JSON.stringify(cluster.events, null, 2));
    return { runDir, results };
  } finally {
    stop = true;
    await cluster.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv.slice(2));
  let opts = o;
  if (o.replay) {
    const m = JSON.parse(fs.readFileSync(path.join(o.replay, 'manifest.json'), 'utf8'));
    opts = { ...m, faultsJson: m.faults, out: o.out ?? `${o.replay.replace(/\/$/, '')}-replay-${Date.now()}` };
  }
  if (!opts.scenario) opts.scenario = 'p2p';
  if (!opts.seed) opts.seed = String(Math.floor(Math.random() * 2 ** 31));
  const { runDir, results } = await runLab(opts);
  console.log(JSON.stringify({ runDir, verdict: results.verdict, ops: results.ops, requests: results.requests, durationMs: results.durationMs, audit: results.audit.stats, auditFindings: results.audit.findings.length, oracle: { runs: results.oracle.runs, maxMs: results.oracle.maxMs, final: results.oracle.final.length, during: Boolean(results.oracle.duringLoad) }, faultsFired: results.faultsFired, restarts: results.restarts }, null, 1));
  await prisma.$disconnect();
  process.exit(results.verdict === 'CLEAN' ? 0 : 1);
}
