#!/usr/bin/env node
// Usage: node scripts/lab/score-soak.mjs <run dir>. T4 here compares the last window that has data; see JOKKO-J15-LAB.md (use the last FULL window when the final one is only the in-flight tail).
// Scores an L6 soak run against the pre-registered thresholds T1–T7 (docs/JOKKO-J15-LAB.md).
import fs from 'node:fs';
const dir = process.argv[2];
const r = JSON.parse(fs.readFileSync(`${dir}/results.json`, 'utf8'));
const prog = fs.readFileSync(`${dir}/progress.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const W = r.latencyWindows.filter((w) => Object.keys(w.routes).length);
const p99 = (w, route) => w.routes[route]?.p99 ?? null;
const series = (route) => W.map((w) => p99(w, route));
const maxOf = (a) => Math.max(...a.filter((x) => x != null));
const T3R = ['POST money/charges/:id/pay', 'POST transfers/requests/:id/accept', 'POST transfers/:id/undo'];
const out = {};
out.windows = W.length;
out.T1 = { worst: maxOf(series('POST transfers/send')), budget: 750 };
out.T2 = { worst: maxOf(series('GET money/home')), budget: 450 };
out.T3 = { worst: Object.fromEntries(T3R.map((k) => [k, maxOf(series(k))])), budget: 1000 };
const ratio = (route) => { const s = series(route).filter((x) => x != null); return +(s[s.length - 1] / s[0]).toFixed(2); };
out.T4 = { send: ratio('POST transfers/send'), home: ratio('GET money/home'), budget: 1.5, note: 'last window vs first full window' };
let total = 0, fivexx = 0, lost = 0;
for (const v of Object.values(r.latency)) for (const [s, n] of Object.entries(v.statuses)) { total += n; if (/^5/.test(s)) fivexx += n; if (s === 'network') lost += n; }
out.T5 = { answered5xx: fivexx, requests: total, pct: +(100 * fivexx / total).toFixed(4), lostWithWorker: lost, budgetPct: 0.1 };
out.T6 = { oracleDuringLoad: r.oracle.duringLoad?.findings?.length ?? 0, oracleFinal: r.oracle.final?.length ?? 0, audit: r.audit.findings.length, stuck: r.audit.stats.stuckInProgress };
// T7: same process (no restart between the 30-min sample and the last sample).
const t0 = Date.parse(r.manifest.startedAt ?? prog[0].t) - (r.manifest.startedAt ? 0 : 15 * 60_000);
const at30 = prog.find((p) => Date.parse(p.t) - t0 >= 30 * 60_000) ?? prog[prog.length - 1];
let last = prog[prog.length - 1];
try { const c = JSON.parse(fs.readFileSync(`${dir}/checkpoint.json`, 'utf8')); if (c.rssMb && Date.parse(c.t) > Date.parse(last.t)) last = { t: c.t, rssMb: c.rssMb, restarts: c.restarts }; } catch {}
const eligible = Object.keys(last.rssMb).filter((k) => k.startsWith('api-') && at30.restarts[k] === last.restarts[k]);
out.T7 = { at30: at30.t, last: last.t, eligible: Object.fromEntries(eligible.map((k) => [k, { mb30: at30.rssMb[k], mbEnd: last.rssMb[k], ratio: +(last.rssMb[k] / at30.rssMb[k]).toFixed(2) }])), maxApiRssAnySample: Math.max(...prog.flatMap((p) => Object.entries(p.rssMb).filter(([k]) => k.startsWith('api-')).map(([, v]) => v))), budget: 2, supplementaryCronSameProcess: Object.fromEntries(Object.keys(last.rssMb).filter((k) => k.startsWith('cron-') && at30.restarts[k] === last.restarts[k]).map((k) => [k, +(last.rssMb[k] / at30.rssMb[k]).toFixed(2)])) };
const pass = {
  T1: out.T1.worst <= 750, T2: out.T2.worst <= 450, T3: Object.values(out.T3.worst).every((x) => !(x > 1000)),
  T4: out.T4.send <= 1.5 && out.T4.home <= 1.5, T5: out.T5.pct <= 0.1,
  T6: !out.T6.oracleDuringLoad && !out.T6.oracleFinal && !out.T6.audit && !out.T6.stuck,
  T7: eligible.length ? eligible.every((k) => out.T7.eligible[k].ratio <= 2) : 'not evaluable (every API worker restarted in between)',
};
console.log(JSON.stringify({ verdict: r.verdict, durationMin: Math.round(r.durationMs / 60000), ops: r.ops, requests: r.requests, ...out, pass, restarts: r.restarts, faultsFired: r.faultsFired, auditStats: r.audit.stats, oracle: { runs: r.oracle.runs, maxMs: r.oracle.maxMs } }, null, 1));
