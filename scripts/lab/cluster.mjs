/**
 * J15 lab cluster: N API worker processes + M cron worker processes, all separate Node processes with their
 * own Prisma pools on ONE Postgres, each running the real Vercel entry (api/index.js) in NODE_ENV=production
 * with the lab fault hooks enabled (JOKKO_LAB=true, JOKKO_LAB_ALLOW=local-only).
 *
 * - Supervisor: a worker that dies (an injected `crash` = SIGKILL, or anything else) is restarted on a new
 *   port; requests in flight on it see a network error, which the driver records as an UNKNOWN outcome.
 * - Routing: every call carries a routing key; worker = hash(key) mod N, so the same actor sequence always
 *   hits the same workers (replay). Retries can be pinned to a different worker on purpose.
 * - Latency: per route template (ids collapsed), every call, in ms.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_ENV, SCRUB } from '../../tests/helpers/http-harness.js';
import { normalizeDatabaseUrl } from '../../lib/db-url.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = path.join(root, 'tests/helpers/prod-api-server.mjs');

export const routeTemplate = (method, p) =>
  `${method} ${p.split('?')[0].split('/').map((seg) => (/^[a-z0-9_-]{16,}$/i.test(seg) || /\d{3,}/.test(seg) || /^TXN-/.test(seg) ? ':id' : seg)).join('/')}`;

function hashIndex(key, n) {
  return crypto.createHash('sha256').update(String(key)).digest().readUInt32BE(0) % n;
}

class Worker {
  constructor(name, env, events) {
    this.name = name;
    this.env = env;
    this.events = events;
    this.base = null;
    this.restarts = 0;
    this.stopping = false;
    this.ready = null;
  }

  start() {
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SERVER], { env: { ...this.env, JOKKO_LAB_WORKER: this.name }, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let logs = '';
      const timer = setTimeout(() => reject(new Error(`${this.name} did not start:\n${logs.slice(-2000)}`)), 30_000);
      child.stderr.on('data', (d) => { logs = (logs + d).slice(-20_000); });
      child.stdout.on('data', (d) => {
        logs = (logs + d).slice(-20_000);
        const m = String(d).match(/LISTENING (\d+)/);
        if (m && !this.base) {
          clearTimeout(timer);
          this.base = `http://127.0.0.1:${m[1]}`;
          resolve(this.base);
        }
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        this.base = null;
        if (this.stopping) return;
        this.restarts += 1;
        this.events.push({ t: Date.now(), worker: this.name, event: 'exit', code, signal, restart: this.restarts, tail: logs.slice(-600) });
        // Supervisor: restart after a short pause (a real platform restarts the instance).
        setTimeout(() => { if (!this.stopping) this.start().catch((e) => this.events.push({ t: Date.now(), worker: this.name, event: 'restart_failed', error: String(e).slice(0, 300) })); }, 150);
      });
    });
    return this.ready;
  }

  async url() {
    if (this.base) return this.base;
    return this.ready;
  }

  stop() {
    this.stopping = true;
    if (!this.child || this.child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.kill('SIGTERM');
      setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    });
  }
}

export async function startCluster({ apiWorkers = 4, cronWorkers = 2, runDir, faultFile, extraEnv = {} } = {}) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  Object.assign(env, BASE_ENV, {
    DATABASE_URL: normalizeDatabaseUrl(process.env.DATABASE_URL),
    JOKKO_LAB: 'true',
    JOKKO_LAB_ALLOW: 'local-only',
    JOKKO_LAB_EVENT_LOG: path.join(runDir, 'faults.jsonl'),
    ...(faultFile ? { JOKKO_LAB_FAULT_FILE: faultFile } : {}),
  }, extraEnv);
  const events = [];
  const api = Array.from({ length: apiWorkers }, (_, i) => new Worker(`api-${i}`, env, events));
  const cron = Array.from({ length: cronWorkers }, (_, i) => new Worker(`cron-${i}`, env, events));
  await Promise.all([...api, ...cron].map((w) => w.start()));

  const latency = new Map();
  const t0 = Date.now();
  const samples = []; // [secondsSinceStart, route, ms, status] for windowed (soak) reports
  const note = (route, ms, status) => {
    samples.push([Math.floor((Date.now() - t0) / 1000), route, ms, status]);
    const l = latency.get(route) ?? { ms: [], statuses: {} };
    l.ms.push(ms);
    l.statuses[status] = (l.statuses[status] ?? 0) + 1;
    latency.set(route, l);
  };

  async function request(worker, method, p, { token, body, headers = {}, device, ip } = {}) {
    const t0 = performance.now();
    const route = routeTemplate(method, p);
    let base;
    try {
      base = await Promise.race([worker.url(), new Promise((_, rej) => setTimeout(() => rej(new Error('worker_down')), 10_000))]);
      const res = await fetch(`${base}/api/${p}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-proto': 'https',
          ...(ip ? { 'x-forwarded-for': ip } : {}),
          ...(device ? { 'x-device-id': device } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = text; }
      note(route, performance.now() - t0, res.status);
      return { status: res.status, body: json, headers: Object.fromEntries(res.headers), worker: worker.name };
    } catch (error) {
      // No response: the outcome is UNKNOWN to this client (worker killed mid-request, timeout, reset).
      note(route, performance.now() - t0, 'network');
      return { status: 0, network: true, error: String(error?.cause?.code ?? error?.name ?? error).slice(0, 120), body: null, worker: worker.name };
    }
  }

  /** A test-helper-compatible `api` ({ client }) whose calls route by key. */
  const apiFor = (routingKey) => {
    let seq = 0;
    return {
      client: (method, p, opts = {}) => {
        seq += 1;
        const w = api[opts.worker ?? hashIndex(`${routingKey}:${seq}`, api.length)];
        return request(w, method, p, opts);
      },
    };
  };

  const cronSecret = BASE_ENV.CRON_SECRET;
  const runCron = (i, name) => request(cron[i % cron.length], 'POST', `cron/${name}`, { headers: { authorization: `Bearer ${cronSecret}` } });

  const latencyReport = () => {
    const out = {};
    for (const [route, l] of latency) {
      const s = [...l.ms].sort((a, b) => a - b);
      const pct = (p) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null);
      out[route] = { n: s.length, p50: pct(50), p95: pct(95), p99: pct(99), max: s.length ? Math.round(s[s.length - 1]) : null, statuses: l.statuses };
    }
    return out;
  };

  /** Per time window (seconds) and route: n, p50, p95, p99, errors (5xx / network). */
  const windowReport = (windowSec, routes) => {
    const byW = new Map();
    for (const [sec, route, ms, status] of samples) {
      if (routes && !routes.includes(route)) continue;
      const w = Math.floor(sec / windowSec);
      const m = byW.get(w) ?? new Map();
      const l = m.get(route) ?? { ms: [], errors: 0 };
      // Latency of answered requests only; a request lost with a killed worker is an error, not a latency.
      if (status !== 'network') l.ms.push(ms);
      if (status === 'network' || status >= 500) l.errors += 1;
      m.set(route, l);
      byW.set(w, m);
    }
    return [...byW.entries()].sort((a, b) => a[0] - b[0]).map(([w, m]) => ({
      window: w,
      fromSec: w * windowSec,
      routes: Object.fromEntries([...m.entries()].map(([route, l]) => {
        const v = [...l.ms].sort((a, b) => a - b);
        const pct = (p) => Math.round(v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))]);
        return [route, { n: v.length, p50: v.length ? pct(50) : null, p95: v.length ? pct(95) : null, p99: v.length ? pct(99) : null, errors: l.errors }];
      })),
    }));
  };

  return {
    windowReport,
    api,
    cron,
    events,
    apiFor,
    request,
    runCron,
    latencyReport,
    restarts: () => Object.fromEntries([...api, ...cron].map((w) => [w.name, w.restarts])),
    /** Resident memory per worker (MB), for leak / drift detection over a soak. */
    rss: () => Object.fromEntries([...api, ...cron].map((w) => {
      try { return [w.name, Math.round(Number(fs.readFileSync(`/proc/${w.child.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024)]; } catch { return [w.name, null]; }
    })),
    faultLog: () => {
      const f = env.JOKKO_LAB_EVENT_LOG;
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    stop: () => Promise.all([...api, ...cron].map((w) => w.stop())),
  };
}
