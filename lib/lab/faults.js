/**
 * J15 L0 — deterministic fault injection for the financial torture lab.
 *
 * INERT unless BOTH JOKKO_LAB=true AND JOKKO_LAB_ALLOW=local-only, and never on Vercel (VERCEL / VERCEL_ENV set).
 * When active, a schedule file (JOKKO_LAB_FAULT_FILE, JSON, re-read when it changes) names faults per point:
 *   { "faults": [ { "point": "money.before_commit", "nth": [3, 7], "action": "crash" },
 *                 { "point": "ratelimit.partner", "always": true, "action": "throw", "code": "db_unavailable" },
 *                 { "point": "provider.callback", "every": 5, "action": "delay", "ms": 400 } ] }
 * Hits are counted per process and per point, so the same schedule + the same request order reproduces the same
 * faults (replay). Every fired fault is appended to JOKKO_LAB_EVENT_LOG before it acts (a crash is logged first).
 *   crash  → SIGKILL of this process (as kill -9: no cleanup, no response)
 *   throw  → LabFaultError (an infrastructure failure at that point)
 *   delay  → wait `ms` (slow dependency / lock holder)
 */
import fs from 'node:fs';

export const labEnabled = () =>
  process.env.JOKKO_LAB === 'true' && process.env.JOKKO_LAB_ALLOW === 'local-only' && !process.env.VERCEL && !process.env.VERCEL_ENV;

export class LabFaultError extends Error {
  constructor(point, code = 'lab_fault') {
    super(`lab fault at ${point}`);
    this.name = 'LabFaultError';
    this.code = code;
    this.point = point;
  }
}

let cache = { file: null, mtimeMs: -1, faults: [] };
const counters = new Map();

function schedule() {
  const file = process.env.JOKKO_LAB_FAULT_FILE;
  if (!file) return [];
  try {
    const st = fs.statSync(file);
    if (cache.file !== file || cache.mtimeMs !== st.mtimeMs) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = { file, mtimeMs: st.mtimeMs, faults: Array.isArray(parsed?.faults) ? parsed.faults : [] };
    }
    return cache.faults;
  } catch {
    return [];
  }
}

function record(entry) {
  const log = process.env.JOKKO_LAB_EVENT_LOG;
  if (!log) return;
  try {
    fs.appendFileSync(log, `${JSON.stringify({ t: Date.now(), pid: process.pid, worker: process.env.JOKKO_LAB_WORKER ?? null, ...entry })}\n`);
  } catch { /* the lab log is best-effort; the fault still fires */ }
}

/** A named point in a money path. No-op (one boolean check) outside the lab. */
export async function labPoint(point, ctx = {}) {
  if (!labEnabled()) return;
  const n = (counters.get(point) ?? 0) + 1;
  counters.set(point, n);
  for (const f of schedule()) {
    if (f.point !== point) continue;
    const hit = f.always || (Array.isArray(f.nth) && f.nth.includes(n)) || (f.every && n % f.every === 0);
    if (!hit) continue;
    record({ point, n, action: f.action, ctx });
    if (f.action === 'crash') process.kill(process.pid, 'SIGKILL');
    if (f.action === 'throw') throw new LabFaultError(point, f.code);
    if (f.action === 'delay') await new Promise((r) => setTimeout(r, Number(f.ms) || 100));
  }
}

export function labCounters() {
  return Object.fromEntries(counters);
}
