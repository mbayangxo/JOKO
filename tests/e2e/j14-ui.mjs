/**
 * J14 browser-level E2E (Chromium, exported web app, production-mode API). Stored state is checked in the DB.
 *
 *   S0-1. Scheduled transfer: the person is looked up and shown, nothing is saved before confirmation, and the
 *         confirmed ACCOUNT id is what gets stored.
 *   S0-2. "Ce n’est pas la bonne personne" saves nothing.
 *
 *   WEB_DIR=… PLAYWRIGHT_CORE=… CHROMIUM=… DATABASE_URL=… node tests/e2e/j14-ui.mjs
 */
import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { startApiServer } from '../helpers/http-harness.js';
import { prisma } from '../helpers/db.js';
import { serveWeb } from './serve-web.mjs';
import { customer, signedIn } from '../j3/helpers.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const log = (m) => process.stdout.write(`${m}\n`);
const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push(['PASS', name]);
    log(`PASS ${name}`);
  } catch (e) {
    results.push(['FAIL', name]);
    log(`FAIL ${name}: ${String(e.message).slice(0, 600)}`);
    throw e;
  }
};

const api = await startApiServer();
const web = await serveWeb({ dir: process.env.WEB_DIR, apiPort: Number(new URL(api.base).port) });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const errors = [];

async function sessionPage(person, label) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${String(e).slice(0, 200)}`));
  await page.addInitScript(() => {
    window.__seen = [];
    const t0 = performance.now();
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        const t = (n.textContent ?? '').trim();
        if (t && t.length < 160) window.__seen.push(`${Math.round(performance.now() - t0)}ms ${t}`);
      }
      if (window.__seen.length > 400) window.__seen.splice(0, 200);
    }).observe(document, { childList: true, subtree: true });
  });
  await page.addInitScript(({ token, refresh, device }) => {
    sessionStorage.setItem('k21_access_token', token);
    sessionStorage.setItem('k21_refresh_token', refresh);
    sessionStorage.setItem('k21_device_id', device);
    sessionStorage.setItem('k21_pin_configured', '1');
    sessionStorage.setItem('k21_last_activity', String(Date.now()));
  }, { token: person.token, refresh: person.refresh, device: person.device });
  await page.goto(`http://127.0.0.1:${web.port}/`);
  return { ctx, page };
}
const tap = async (page, text, { exact = false, last = false } = {}) => {
  const all = page.getByText(text, { exact }).filter({ visible: true });
  const loc = last ? all.last() : all.first();
  try {
    await loc.waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    const body = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
    throw new Error(`tap "${text}" not visible; screen: …${body.slice(-500)}`);
  }
  await loc.click();
};
const see = async (page, text, timeout = 20_000) => {
  try {
    await page.getByText(text).filter({ visible: true }).first().waitFor({ state: 'visible', timeout });
  } catch {
    const body = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
    const seen = await page.evaluate(() => (window.__seen ?? []).slice(-12)).catch(() => []);
    throw new Error(`"${text}" not visible; screen: …${body.slice(-500)} | seen: ${JSON.stringify(seen)}`);
  }
};
const seenEver = (page, text) => page.evaluate((t) => (window.__seen ?? []).some((s) => s.includes(t)), text);
try {
  await step('S0 scheduled transfer: the person is shown and confirmed before saving; the confirmed ACCOUNT is stored', async () => {
    const a = await customer({ koriBalance: 20_000 });
    const A = await signedIn(api, a);
    const b = await customer();
    const h = `sched${Date.now().toString(36).slice(-6)}`;
    await prisma.user.update({ where: { id: b.id }, data: { handle: h, name: 'Moussa Ndiaye' } });
    const { ctx, page } = await sessionPage(A, 's0-sched');
    await tap(page, 'Plus', { exact: true });
    await tap(page, 'Paiements programmés');
    await tap(page, 'Envoyer à quelqu\'un régulièrement');
    await page.getByPlaceholder('@handle destinataire').filter({ visible: true }).first().fill(`@${h}`);
    await tap(page, 'Vérifier le destinataire');
    await see(page, 'Programmer un envoi à Moussa Ndiaye ?');
    assert.equal(await prisma.scheduledPayment.count({ where: { userId: a.id } }), 0, 'nothing saved before confirmation');
    await tap(page, "Oui, programmer l'envoi");
    await see(page, 'Envoi planifié');
    const row = await prisma.scheduledPayment.findFirst({ where: { userId: a.id } });
    assert.equal(row?.recipientId, b.id, 'the confirmed account is stored');
    await ctx.close();
  });

  await step('S0 scheduled transfer: "Ce n’est pas la bonne personne" saves nothing', async () => {
    const a = await customer({ koriBalance: 20_000 });
    const A = await signedIn(api, a);
    const b = await customer();
    const { ctx, page } = await sessionPage(A, 's0-cancel');
    await tap(page, 'Plus', { exact: true });
    await tap(page, 'Paiements programmés');
    await tap(page, 'Envoyer à quelqu\'un régulièrement');
    await page.getByPlaceholder('@handle destinataire').filter({ visible: true }).first().fill(`@${b.handle}`);
    await tap(page, 'Vérifier le destinataire');
    await tap(page, 'Ce n’est pas la bonne personne');
    await page.waitForTimeout(1000);
    assert.equal(await prisma.scheduledPayment.count({ where: { userId: a.id } }), 0);
    await see(page, 'Vérifier le destinataire');
    await ctx.close();
  });

  await step('no uncaught page errors', async () => {
    assert.deepEqual(errors, []);
  });
  await assertInvariants(prisma);
  log('INVARIANTS OK');
} finally {
  log(JSON.stringify({ passed: results.filter((r) => r[0] === 'PASS').length, failed: results.filter((r) => r[0] === 'FAIL').length }));
  await browser.close();
  web.close();
  await api.stop();
  await prisma.$disconnect();
}
