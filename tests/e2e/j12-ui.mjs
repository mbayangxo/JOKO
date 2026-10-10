/**
 * J12 browser-level E2E — weak network, lost responses, restarts (Chromium, exported web app, production-mode API).
 *
 *   1. LOST RESPONSE: a P2P send reaches the server and executes, but the response never comes back
 *      (and the client's automatic retry is cut too). The app must show "en vérification", NEVER "Envoyé !",
 *      and a second tap must not send a second payment.
 *   2. RESTART while the outcome is unknown: the page is reloaded with the network still cut for intent
 *      lookups. After reload the screen resumes the LOOKUP (never a re-submit), and only once the server
 *      answers does it say "Paiement effectué".
 *   3. AIRPLANE MODE before sending: nothing reaches the server; nothing is shown as sent; no money moves.
 *   4. ACCOUNT SWITCH on the same browser profile: user B never sees user A's pending payment.
 *
 * Every money assertion is checked in the DATABASE: exactly one debit, exactly one credit, J2 invariants.
 *
 *   WEB_DIR=<expo export dir> PLAYWRIGHT_CORE=<playwright-core> CHROMIUM=<chrome> DATABASE_URL=… node tests/e2e/j12-ui.mjs
 */
import '../helpers/setup.js';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
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
    results.push(['FAIL', name, String(e.message).slice(0, 300)]);
    log(`FAIL ${name}: ${String(e.message).slice(0, 300)}`);
    throw e;
  }
};

const api = await startApiServer();
const web = await serveWeb({ dir: process.env.WEB_DIR, apiPort: Number(new URL(api.base).port) });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const errors = [];
const PIN = '482913';

const sessionInit = ({ token, refresh, device }) => {
  sessionStorage.setItem('k21_access_token', token);
  sessionStorage.setItem('k21_refresh_token', refresh);
  sessionStorage.setItem('k21_device_id', device);
  sessionStorage.setItem('k21_pin_configured', '1');
  sessionStorage.setItem('k21_last_activity', String(Date.now()));
};
async function sessionPage(ctx, person, label) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${String(e).slice(0, 200)}`));
  await page.addInitScript(sessionInit, { token: person.token, refresh: person.refresh, device: person.device });
  await page.goto(`http://127.0.0.1:${web.port}/`);
  return page;
}
const tap = async (page, text, { exact = false, last = false } = {}) => {
  const all = page.getByText(text, { exact }).filter({ visible: true });
  const loc = last ? all.last() : all.first();
  await loc.waitFor({ state: 'visible', timeout: 20_000 });
  await loc.click();
};
const see = async (page, text, timeout = 20_000) => {
  try {
    await page.getByText(text).filter({ visible: true }).first().waitFor({ state: 'visible', timeout });
  } catch {
    const body = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
    throw new Error(`"${text}" not visible; screen: …${body.slice(-600)}`);
  }
};
const visible = async (page, text) => (await page.getByText(text).filter({ visible: true }).count()) > 0;
const bal = async (userId) => (await prisma.wallet.findUnique({ where: { userId } })).koriBalance;

async function openSend(page, toHandle) {
  await tap(page, 'Yónnee', { exact: true });
  await see(page, 'À qui ?');
  await tap(page, 'Handle', { exact: true });
  await page.getByPlaceholder('@handle').filter({ visible: true }).first().fill(`@${toHandle}`);
  await see(page, 'Continuer →');
  await page.waitForTimeout(900); // recipient lookup is debounced (400 ms) + network
  await tap(page, 'Continuer →');
  await see(page, 'Oui — Envoyer');
}
async function pinIfAsked(page) {
  const asked = await page.getByText('Confirme ton PIN').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false);
  if (asked) for (const d of PIN) await tap(page, d, { exact: true, last: true });
  return asked;
}

try {
  const aC = await customer({ koriBalance: 50_000 });
  const bC = await customer({ koriBalance: 0 });
  const cC = await customer({ koriBalance: 50_000 });
  for (const u of [aC, cC]) await prisma.user.update({ where: { id: u.id }, data: { pinHash: await bcrypt.hash(PIN, 4) } });
  const A = await signedIn(api, aC);
  const C = await signedIn(api, cC);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let page = await sessionPage(ctx, A, 'A');
  const a0 = await bal(A.id);
  const b0 = await bal(bC.id);
  let sendHits = 0;
  let executed = 0;
  let intentsCut = true;
  let serverAnswer = null;

  await step('lost response: the server executes, the reply is lost → "en vérification", never "Envoyé !", no second payment', async () => {
    await page.route('**/api/transfers/send', async (route) => {
      // The PIN challenge (403 step_up_required, nothing executed) passes through untouched; the
      // PIN-confirmed request is the one that executes — and its answer is lost.
      if (!route.request().headers()['x-step-up-token']) return route.continue();
      sendHits += 1;
      if (sendHits === 1) {
        const r = await route.fetch(); // reaches the server and executes …
        executed += 1;
        serverAnswer = `${r.status()} ${(await r.text()).slice(0, 300)}`;
      }
      await route.abort('failed'); // … but the client never gets the answer (and its auto-retry is cut too)
    });
    await page.route('**/api/money/intents/**', (route) => (intentsCut ? route.abort('failed') : route.continue()));
    await openSend(page, bC.handle);
    await tap(page, 'Oui — Envoyer');
    await pinIfAsked(page);
    await see(page, 'Vérification du paiement en cours');
    assert.ok(!(await visible(page, 'Envoyé !')), 'never shown as sent before the server confirms');
    // a nervous second tap while checking must not fire a second payment
    await page.getByText('Oui — Envoyer').filter({ visible: true }).first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(1500);
    assert.equal(executed, 1);
    assert.equal(await bal(A.id), a0 - 5000, `debited exactly once on the server (server said: ${serverAnswer})`);
    assert.equal(await bal(bC.id), b0 + 5000);
    const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('k21_pending_intents_v1') ?? '[]'));
    assert.equal(pending.length, 1, 'the unknown outcome is remembered for lookup');
    assert.deepEqual(Object.keys(pending[0]).sort(), ['createdAt', 'flow', 'key', 'userId'], 'a lookup handle only — no amount, no recipient');
  });

  await step('restart while unknown: the app resumes the LOOKUP (never re-sends) and confirms only from the server', async () => {
    await page.reload();
    await openSend(page, bC.handle).catch(() => {}); // land on the Send screen again (the banner shows at the top)
    await see(page, 'Un paiement précédent est en vérification');
    assert.ok(!(await visible(page, 'Paiement effectué')), 'still unknown while lookups fail');
    intentsCut = false; // network back
    await see(page, 'Paiement effectué', 40_000);
    assert.equal(sendHits <= 2, true, `no re-submit after restart (send hits: ${sendHits})`);
    assert.equal(executed, 1);
    assert.equal(await bal(A.id), a0 - 5000, 'still exactly one debit');
    const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('k21_pending_intents_v1') ?? '[]'));
    assert.equal(pending.length, 0, 'resolved → forgotten');
  });

  await step('airplane mode before sending: nothing is sent, nothing is shown as sent, no money moves', async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.reload();
    await openSend(page, bC.handle);
    const before = await bal(A.id);
    await ctx.setOffline(true);
    await tap(page, 'Oui — Envoyer');
    await pinIfAsked(page);
    await page.waitForTimeout(4000);
    assert.ok(!(await visible(page, 'Envoyé !')), 'offline: never shown as sent');
    await ctx.setOffline(false);
    await see(page, 'Le paiement n’a pas été reçu', 45_000); // the intent lookup proves nothing executed
    assert.equal(await bal(A.id), before, 'no money moved');
  });

  await step('account switch on the same browser: user C never sees user A’s pending payment', async () => {
    await page.evaluate(({ k, userId }) => localStorage.setItem('k21_pending_intents_v1', JSON.stringify([{ key: k, userId, flow: 'p2p', createdAt: Date.now() }])), { k: 'k-a-private-intent', userId: A.id });
    await page.close();
    page = await sessionPage(ctx, C, 'C');
    let lookups = 0;
    await page.route('**/api/money/intents/**', (route) => {
      lookups += 1;
      return route.continue();
    });
    await openSend(page, bC.handle);
    await page.waitForTimeout(3000);
    assert.ok(!(await visible(page, 'Un paiement précédent')), 'C is not shown A’s pending payment');
    assert.equal(lookups, 0, 'C’s session never looks up A’s intent');
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
