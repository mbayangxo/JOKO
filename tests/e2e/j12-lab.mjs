/**
 * J12 weak-network / low-end LAB — SIMULATED (desktop Chromium + DevTools emulation), NOT a physical device.
 *
 * Reproducible: fixed network profiles, seeded packet loss, fixed CPU throttle. Writes a JSON report
 * (LAB_REPORT=<path>) and prints one line per scenario. Money is ALWAYS checked in the database:
 *   no payment executes twice, nothing is shown as sent before the server confirms, invariants hold.
 *
 * Profiles (Chrome DevTools / WebPageTest conventions):
 *   2G          280 kbps down / 256 up / 800 ms RTT
 *   3G-unstable 750 kbps down / 250 up / 300 ms RTT, 10 % seeded request loss on /api, periodic 2 s drops
 *   low-end CPU 6× slowdown (proxy for an entry-level Android; memory pressure cannot be emulated)
 *
 * Scenarios: bundle weight; cold + warm load on 2G (+6× CPU); P2P under unstable 3G with loss; clock moved
 * ±; page killed mid-payment then reopened; device storage full; app frozen in background mid-check;
 * reconnect storm (40 clients retrying messages + intent lookups at once, API level).
 *
 *   WEB_DIR=… PLAYWRIGHT_CORE=… CHROMIUM=… DATABASE_URL=… [LAB_REPORT=…] node tests/e2e/j12-lab.mjs
 */
import '../helpers/setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import bcrypt from 'bcryptjs';
import { startApiServer } from '../helpers/http-harness.js';
import { prisma } from '../helpers/db.js';
import { serveWeb } from './serve-web.mjs';
import { customer, signedIn } from '../j3/helpers.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const log = (m) => process.stdout.write(`${m}\n`);
const report = { simulated: true, device: 'desktop Chromium with DevTools emulation — NOT a physical low-end Android', when: new Date().toISOString(), scenarios: {} };
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const data = (await fn()) ?? {};
    report.scenarios[name] = { pass: true, ms: Date.now() - t0, ...data };
    results.push(['PASS', name]);
    log(`PASS ${name} ${JSON.stringify(data)}`);
  } catch (e) {
    report.scenarios[name] = { pass: false, ms: Date.now() - t0, error: String(e.message).slice(0, 400) };
    results.push(['FAIL', name]);
    log(`FAIL ${name}: ${String(e.message).slice(0, 400)}`);
  }
};

const PROFILES = {
  '2G': { offline: false, latency: 800, downloadThroughput: (280 * 1000) / 8, uploadThroughput: (256 * 1000) / 8 },
  '3G-unstable': { offline: false, latency: 300, downloadThroughput: (750 * 1000) / 8, uploadThroughput: (250 * 1000) / 8 },
};
const PIN = '482913';

const api = await startApiServer();
const web = await serveWeb({ dir: process.env.WEB_DIR, apiPort: Number(new URL(api.base).port), compress: true, cache: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const errors = [];

const sessionInit = ({ token, refresh, device }) => {
  sessionStorage.setItem('k21_access_token', token);
  sessionStorage.setItem('k21_refresh_token', refresh);
  sessionStorage.setItem('k21_device_id', device);
  sessionStorage.setItem('k21_pin_configured', '1');
  sessionStorage.setItem('k21_last_activity', String(Date.now()));
};
async function open(ctx, person, label, { profile = null, cpu = 1, init = null } = {}) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${String(e).slice(0, 200)}`));
  if (init) await page.addInitScript(init.fn, init.arg);
  await page.addInitScript(sessionInit, { token: person.token, refresh: person.refresh, device: person.device });
  const cdp = await ctx.newCDPSession(page);
  if (profile) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', PROFILES[profile]);
  }
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  return { page, cdp };
}
const tap = async (page, text, { exact = false, last = false, timeout = 60_000 } = {}) => {
  const all = page.getByText(text, { exact }).filter({ visible: true });
  const loc = last ? all.last() : all.first();
  await loc.waitFor({ state: 'visible', timeout });
  await loc.click();
};
const see = async (page, text, timeout = 60_000) => {
  try {
    await page.getByText(text).filter({ visible: true }).first().waitFor({ state: 'visible', timeout });
  } catch {
    const body = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
    throw new Error(`"${text}" not visible; screen: …${body.slice(-500)}`);
  }
};
const visible = async (page, text) => (await page.getByText(text).filter({ visible: true }).count()) > 0;
const bal = async (id) => (await prisma.wallet.findUnique({ where: { userId: id } })).koriBalance;
async function pinIfAsked(page) {
  const asked = await page.getByText('Confirme ton PIN').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
  if (asked) for (const d of PIN) await tap(page, d, { exact: true, last: true });
}
async function openSend(page, toHandle) {
  await tap(page, 'Yónnee', { exact: true });
  await see(page, 'À qui ?');
  await tap(page, 'Handle', { exact: true });
  await page.getByPlaceholder('@handle').filter({ visible: true }).first().fill(`@${toHandle}`);
  await page.waitForTimeout(2500);
  await tap(page, 'Continuer →');
  await see(page, 'Oui — Envoyer');
}
async function payer() {
  const a = await customer({ koriBalance: 100_000 });
  await prisma.user.update({ where: { id: a.id }, data: { pinHash: await bcrypt.hash(PIN, 4) } });
  const b = await customer();
  return { A: await signedIn(api, a), B: b };
}
/** Waits until the send attempt has a server verdict on screen; returns which. */
async function verdict(page, timeout = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await visible(page, 'Envoyé !')) return 'sent';
    if (await visible(page, 'Paiement effectué')) return 'sent';
    if (await visible(page, 'n’a pas été reçu')) return 'not_received';
    if (await visible(page, 'refusée')) return 'refused';
    await page.waitForTimeout(500);
  }
  return 'still_checking';
}

try {
  await step('bundle weight (web build)', async () => {
    const dir = path.join(process.env.WEB_DIR, '_expo/static/js/web');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    let raw = 0;
    let gz = 0;
    for (const f of files) {
      const b = fs.readFileSync(path.join(dir, f));
      raw += b.length;
      gz += gzipSync(b, { level: 9 }).length;
    }
    const secs = (bytes, kbps, rttMs) => Math.round((bytes * 8) / (kbps * 1000) + rttMs / 1000);
    return { rawKB: Math.round(raw / 1024), gzipKB: Math.round(gz / 1024), estFirstDownloadSeconds: { '2G': secs(gz, 280, 800), '3G': secs(gz, 750, 300) } };
  });

  await step('cold + warm load on 2G with 6× CPU (low-end proxy)', async () => {
    const { A } = await payer();
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const { page } = await open(ctx, A, 'load', { profile: '2G', cpu: 6 });
    let t0 = Date.now();
    await page.goto(`http://127.0.0.1:${web.port}/`, { timeout: 600_000 });
    await see(page, 'Yónnee', 600_000);
    const cold = Date.now() - t0;
    t0 = Date.now();
    await page.reload({ timeout: 600_000 });
    await see(page, 'Yónnee', 600_000);
    const warm = Date.now() - t0;
    await ctx.close();
    return { coldMs: cold, warmMs: warm };
  });

  await step('P2P under unstable 3G with 10 % seeded request loss: each payment at most once, never "sent" early', async () => {
    const { A, B } = await payer();
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const { page, cdp } = await open(ctx, A, 'loss', { profile: '3G-unstable', cpu: 4 });
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let dropped = 0;
    let executedAndLost = 0;
    await page.route('**/api/**', async (route) => {
      if (rnd() < 0.1) {
        dropped += 1;
        if (route.request().method() !== 'GET' && rnd() < 0.5) {
          executedAndLost += 1;
          await route.fetch().catch(() => {}); // reached the server, reply lost
        }
        return route.abort('failed');
      }
      return route.continue();
    });
    const flap = setInterval(async () => {
      await cdp.send('Network.emulateNetworkConditions', { ...PROFILES['3G-unstable'], offline: true }).catch(() => {});
      setTimeout(() => cdp.send('Network.emulateNetworkConditions', PROFILES['3G-unstable']).catch(() => {}), 2000);
    }, 12_000);
    const a0 = await bal(A.id);
    const outcomes = [];
    try {
      await page.goto(`http://127.0.0.1:${web.port}/`, { timeout: 300_000 });
      for (let i = 0; i < 3; i += 1) {
        await openSend(page, B.handle);
        await tap(page, 'Oui — Envoyer');
        await pinIfAsked(page);
        outcomes.push(await verdict(page));
        await page.goto(`http://127.0.0.1:${web.port}/`, { timeout: 300_000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }
    } finally {
      clearInterval(flap);
    }
    await page.waitForTimeout(3000);
    const debits = (a0 - (await bal(A.id))) / 5000;
    const sent = outcomes.filter((o) => o === 'sent').length;
    const unknown = outcomes.filter((o) => o === 'still_checking').length;
    assert.ok(Number.isInteger(debits), `whole payments only (${debits})`);
    assert.ok(debits <= outcomes.length, `never more debits (${debits}) than payment attempts (${outcomes.length})`);
    assert.ok(debits >= sent && debits <= sent + unknown, `every "sent" is a real debit; no silent extra debit (debits ${debits}, sent ${sent}, unknown ${unknown})`);
    await ctx.close();
    return { attempts: outcomes.length, outcomes, debits, droppedRequests: dropped, executedButReplyLost: executedAndLost };
  });

  for (const skewH of [+48, -12]) {
    await step(`clock moved ${skewH > 0 ? '+' : ''}${skewH} h during an uncertain payment: lookup resumes, paid once`, async () => {
      const { A, B } = await payer();
      const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
      const skew = { fn: (ms) => { const D = Date; const off = ms; class S extends D { constructor(...a) { super(...(a.length ? a : [D.now() + off])); } static now() { return D.now() + off; } } globalThis.Date = S; }, arg: skewH * 3600_000 };
      const { page } = await open(ctx, A, `clock${skewH}`, { init: skew });
      let hits = 0;
      await page.route('**/api/transfers/send', async (route) => {
        if (!route.request().headers()['x-step-up-token']) return route.continue();
        hits += 1;
        if (hits === 1) await route.fetch();
        return route.abort('failed');
      });
      await page.route('**/api/money/intents/**', (route) => route.abort('failed'));
      const a0 = await bal(A.id);
      await page.goto(`http://127.0.0.1:${web.port}/`);
      await openSend(page, B.handle);
      await tap(page, 'Oui — Envoyer');
      await pinIfAsked(page);
      await see(page, 'Vérification du paiement en cours');
      await page.close();
      // the clock is "fixed" again and the network is back: a fresh page of the same app
      const { page: p2 } = await open(ctx, A, `clock${skewH}-after`);
      await p2.goto(`http://127.0.0.1:${web.port}/`);
      await openSend(p2, B.handle).catch(() => {});
      await see(p2, 'Paiement effectué', 90_000);
      assert.equal(a0 - (await bal(A.id)), 5000, 'debited exactly once');
      await ctx.close();
    });
  }

  await step('page killed mid-payment, reopened: no second payment, outcome recovered from the server', async () => {
    const { A, B } = await payer();
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const { page } = await open(ctx, A, 'kill', { profile: '3G-unstable' });
    const a0 = await bal(A.id);
    await page.goto(`http://127.0.0.1:${web.port}/`, { timeout: 300_000 });
    await openSend(page, B.handle);
    let resolveSent;
    const sent = new Promise((r) => { resolveSent = r; });
    await page.route('**/api/transfers/send', async (route) => {
      if (!route.request().headers()['x-step-up-token']) return route.continue();
      resolveSent();
      await new Promise((r) => setTimeout(r, 1500)); // in flight when the app dies
      return route.continue();
    });
    await tap(page, 'Oui — Envoyer');
    await pinIfAsked(page);
    await sent;
    await page.close({ runBeforeUnload: false }); // "process killed"
    const { page: p2 } = await open(ctx, A, 'kill-after');
    await p2.goto(`http://127.0.0.1:${web.port}/`);
    await openSend(p2, B.handle).catch(() => {});
    await p2.waitForTimeout(8000);
    const debited = (a0 - (await bal(A.id))) / 5000;
    assert.ok(debited <= 1, `at most one debit (${debited})`);
    assert.ok(!(await visible(p2, 'Envoyé !')), 'the reopened app does not claim a success it did not see');
    await ctx.close();
    return { debitedPayments: debited };
  });

  await step('device storage full: the app keeps working, payments stay single, nothing crashes', async () => {
    const { A, B } = await payer();
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const full = { fn: () => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (this === window.localStorage) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } return orig.call(this, k, v); }; }, arg: null };
    const { page } = await open(ctx, A, 'full', { init: full });
    const a0 = await bal(A.id);
    const before = errors.length;
    await page.goto(`http://127.0.0.1:${web.port}/`);
    await openSend(page, B.handle);
    await tap(page, 'Oui — Envoyer');
    await pinIfAsked(page);
    const v = await verdict(page, 60_000);
    assert.equal(v, 'sent');
    assert.equal(a0 - (await bal(A.id)), 5000);
    assert.equal(errors.length, before, `no uncaught errors: ${errors.slice(before).join(' | ')}`);
    await ctx.close();
  });

  await step('app frozen in the background while checking, then foregrounded: resolves from the server, paid once', async () => {
    const { A, B } = await payer();
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const { page, cdp } = await open(ctx, A, 'bg');
    let hits = 0;
    await page.route('**/api/transfers/send', async (route) => {
      if (!route.request().headers()['x-step-up-token']) return route.continue();
      hits += 1;
      if (hits === 1) await route.fetch();
      return route.abort('failed');
    });
    const a0 = await bal(A.id);
    await page.goto(`http://127.0.0.1:${web.port}/`);
    await openSend(page, B.handle);
    await tap(page, 'Oui — Envoyer');
    await pinIfAsked(page);
    await see(page, 'Vérification du paiement en cours');
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await new Promise((r) => setTimeout(r, 10_000));
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    const v = await verdict(page, 60_000);
    assert.equal(v, 'sent');
    assert.equal(a0 - (await bal(A.id)), 5000, 'once');
    await ctx.close();
  });

  await step('reconnect storm: 40 clients replay queued messages ×3 and intent lookups ×3 at once (API level)', async () => {
    const people = [];
    for (let i = 0; i < 20; i += 1) {
      const a = await customer();
      const b = await customer();
      await prisma.userFriend.createMany({ data: [{ userId: a.id, friendId: b.id }, { userId: b.id, friendId: a.id }] });
      const A = await signedIn(api, a);
      const t = await A.call('POST', 'mbolo/threads', { memberHandles: [b.handle] });
      people.push({ A, threadId: t.body.id, cid: `cm-${crypto.randomBytes(8).toString('hex')}`, key: `intent-${crypto.randomBytes(8).toString('hex')}` });
    }
    const t0 = Date.now();
    const calls = [];
    for (const p of people) {
      for (let k = 0; k < 3; k += 1) {
        calls.push(p.A.call('POST', `mbolo/threads/${p.threadId}/messages`, { body: 'De retour en ligne', kind: 'text', clientMessageId: p.cid }).then((r) => ({ kind: 'msg', s: r.status, ms: Date.now() - t0 })));
        calls.push(p.A.call('GET', `money/intents/${p.key}`).then((r) => ({ kind: 'intent', s: r.status, ms: Date.now() - t0 })));
      }
    }
    const rs = await Promise.all(calls);
    const s5xx = rs.filter((r) => r.s >= 500).length;
    const limited = rs.filter((r) => r.s === 429).length;
    const lat = rs.map((r) => r.ms).sort((x, y) => x - y);
    const p95 = lat[Math.floor(lat.length * 0.95)];
    let dup = 0;
    for (const p of people) if ((await prisma.mboloMessage.count({ where: { threadId: p.threadId } })) > 1) dup += 1;
    assert.equal(s5xx, 0, 'no server errors under the storm');
    assert.equal(dup, 0, 'no duplicated message');
    return { requests: rs.length, status5xx: s5xx, rateLimited429: limited, p95ms: p95, duplicateThreads: dup };
  });

  await step('no uncaught page errors in any lab session', async () => {
    assert.deepEqual(errors, []);
  });
  await assertInvariants(prisma);
  log('INVARIANTS OK');
} finally {
  report.summary = { passed: results.filter((r) => r[0] === 'PASS').length, failed: results.filter((r) => r[0] === 'FAIL').length };
  if (process.env.LAB_REPORT) fs.writeFileSync(process.env.LAB_REPORT, JSON.stringify(report, null, 2));
  log(JSON.stringify(report.summary));
  await browser.close();
  web.close();
  await api.stop();
  await prisma.$disconnect();
  if (report.summary.failed) process.exitCode = 1;
}
