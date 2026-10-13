/**
 * J13 browser-level E2E (Chromium, exported web app, production-mode API). Money is always checked in the DB.
 *
 *   1. Jekkal donation, reply lost (validates bb10ac2): the server executes the donation, the reply is cut.
 *      The screen shows "vérification", never "Merci pour ton don"; a second tap sends nothing; the intent
 *      lookup — not a re-send — confirms; exactly one contribution, donor debited once.
 *   2. A donation the server answers 202 (held for review) is announced as pending, never as a success.
 *   3. Wallet history status chips; a failed history load is an error with retry, never "no operations".
 *   4. A balance that could not be refreshed is flagged until it refreshes.
 *   5. A trade-invoice notification routes to the invoices.
 *   6. A slow-network double tap on a GlowButton sends one request.
 *   7. Recipient renamed/reclaimed after confirmation: refused, nobody paid (J13-F12).
 *   8. A notification to another account's parcel reveals nothing.
 *
 *   WEB_DIR=… PLAYWRIGHT_CORE=… CHROMIUM=… DATABASE_URL=… node tests/e2e/j13-ui.mjs
 */
import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { startApiServer } from '../helpers/http-harness.js';
import { prisma } from '../helpers/db.js';
import { serveWeb } from './serve-web.mjs';
import { customer, signedIn } from '../j3/helpers.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import bcrypt from 'bcryptjs';

const PIN = '482913';

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
const contributions = (campaignId) => prisma.solidarityContribution.count({ where: { campaignId } });
const spentBy = async (id, w0) => {
  const w = await prisma.wallet.findUnique({ where: { userId: id } });
  return (w0.balance - w.balance) + (w0.koriBalance - w.koriBalance);
};

async function campaignFor(donorUser, title) {
  const creator = await signedIn(api, await customer({ koriBalance: 0 }));
  const r = await creator.call('POST', 'jekkal/campaigns', { title, goalAmount: 50_000 });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  await prisma.notification.create({ data: { userId: donorUser.id, title: `Nouvelle collecte : ${title}`, body: 'Participe si tu peux.', kind: 'jekkal', refId: r.body.id, category: 'community' } });
  return r.body;
}
async function openCampaign(page, title) {
  await tap(page, 'Alertes', { exact: true });
  await see(page, `Nouvelle collecte : ${title}`); // the title is shown (J13-F2)
  await tap(page, 'Voir', { exact: true }); // a Jëkkal notification opens its campaign (J13-F3)
  await see(page, 'Contribuer');
}

try {
  await step('Jekkal donation, reply lost: "vérification", never thanks early, one donation, confirmed by lookup', async () => {
    const d = await customer({ koriBalance: 50_000 });
    const D = await signedIn(api, d);
    const title = `Frais médicaux ${Date.now().toString(36).slice(-4)}`;
    const c = await campaignFor(d, title);
    const { ctx, page } = await sessionPage(D, 'donor');
    let posts = 0;
    let lookupsCut = true;
    await page.route('**/api/jekkal/campaigns/*/contribute', async (route) => {
      posts += 1;
      if (posts === 1) await route.fetch(); // the donation executes on the server …
      return route.abort('failed'); // … the reply (and the client's automatic retry) is lost
    });
    await page.route('**/api/money/intents/**', (route) => (lookupsCut ? route.abort('failed') : route.continue()));
    const w0 = await prisma.wallet.findUnique({ where: { userId: d.id } });
    await openCampaign(page, title);
    await page.getByPlaceholder('Montant').filter({ visible: true }).first().fill('1000');
    await tap(page, 'Contribuer', { exact: true });
    await see(page, 'Vérification du paiement en cours');
    assert.equal(await seenEver(page, 'Merci pour ton don'), false, 'no thanks before the server confirms');
    await page.getByText('Contribuer', { exact: true }).filter({ visible: true }).first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(1500);
    assert.equal(posts <= 2, true, `a second tap while checking sends nothing (posts ${posts})`);
    assert.equal(await contributions(c.id), 1, 'executed once on the server');
    lookupsCut = false; // network back: the lookup — not a re-send — answers
    // The server-confirmed outcome (via the lookup) is announced by the thanks — absent until now.
    await see(page, 'Merci pour ton don', 45_000);
    await see(page, 'Derniers dons');
    assert.equal(await contributions(c.id), 1, 'still exactly one contribution');
    assert.ok((await spentBy(d.id, w0)) > 0, 'debited');
    const once = await spentBy(d.id, w0);
    await page.waitForTimeout(2500);
    assert.equal(await spentBy(d.id, w0), once, 'never debited a second time');
    await ctx.close();
  });

  await step('a donation answered "held for review" (202) is announced as pending — never as a success', async () => {
    const d = await customer({ koriBalance: 50_000 });
    const D = await signedIn(api, d);
    const title = `Cantine ${Date.now().toString(36).slice(-4)}`;
    await campaignFor(d, title);
    const { ctx, page } = await sessionPage(D, 'held');
    await page.route('**/api/jekkal/campaigns/*/contribute', (route) =>
      // A client-side view of a risk hold: no money is touched by this fabricated answer.
      route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ status: 'pending_review', message: 'Opération en vérification par K21. Ne la renouvelle pas.' }) }));
    await openCampaign(page, title);
    await page.getByPlaceholder('Montant').filter({ visible: true }).first().fill('1000');
    await tap(page, 'Contribuer', { exact: true });
    await see(page, 'Opération en vérification par K21');
    await page.waitForTimeout(1500);
    assert.equal(await seenEver(page, 'Merci pour ton don'), false, 'a held donation is never thanked as completed');
    await ctx.close();
  });

  await step('wallet history: a completed send reads "✓ Effectué"; a failed load is an error with retry — never "Aucune opération"', async () => {
    const a = await customer({ koriBalance: 20_000 });
    const A = await signedIn(api, a);
    const b = await customer();
    const sent = await A.call('POST', 'transfers/send', { recipientHandle: b.handle, amount: 700 }, { headers: { 'idempotency-key': `e2e-j13-${Date.now()}` } });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const { ctx, page } = await sessionPage(A, 'wallet');
    let cut = true;
    await page.route('**/api/money/activity**', (route) => (cut ? route.abort('failed') : route.continue()));
    await tap(page, 'Mon portefeuille');
    await see(page, 'Impossible de charger ton historique');
    assert.equal(await seenEver(page, 'Aucune opération'), false, 'a failed load never claims an empty history');
    cut = false;
    await tap(page, 'Réessayer', { exact: true });
    await see(page, '✓ Effectué');
    await see(page, '−700 ₭');
    await ctx.close();
  });

  await step('a balance that could not be refreshed is flagged, and the flag clears once it refreshes', async () => {
    const a = await customer({ koriBalance: 5_000 });
    const A = await signedIn(api, a);
    const { ctx, page } = await sessionPage(A, 'stale');
    await see(page, 'Mon portefeuille');
    let cut = true;
    await page.route('**/api/wallet', (route) => (cut ? route.abort('failed') : route.continue()));
    await tap(page, 'Mon portefeuille');
    // The back arrow is icon-only: found by its accessible name (J13 accessibility labels), not by text.
    await page.getByRole('button', { name: 'Retour', exact: true }).filter({ visible: true }).first().click({ timeout: 20_000 });
    await see(page, 'Solde peut-être pas à jour');
    cut = false;
    await tap(page, 'Solde peut-être pas à jour');
    await page.getByText('Solde peut-être pas à jour').first().waitFor({ state: 'detached', timeout: 20_000 });
    await ctx.close();
  });

  await step('a trade-invoice notification opens the invoices (J13-F5) instead of falling back to Home', async () => {
    const a = await customer();
    const A = await signedIn(api, a);
    await prisma.notification.create({ data: { userId: a.id, title: 'Facture B2B à payer', body: 'Une facture t’attend.', kind: 'trade_invoice', category: 'money' } });
    const { ctx, page } = await sessionPage(A, 'notif');
    await tap(page, 'Alertes', { exact: true });
    await see(page, 'Facture B2B à payer');
    await tap(page, 'Voir', { exact: true });
    await see(page, 'Factures B2B');
    await ctx.close();
  });

  await step('slow network: a double tap on "Lancer la collecte" creates exactly one campaign (J13-F11)', async () => {
    const a = await customer();
    const A = await signedIn(api, a);
    const { ctx, page } = await sessionPage(A, 'double');
    let posts = 0;
    await page.route('**/api/jekkal/campaigns', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      await new Promise((r) => setTimeout(r, 2500)); // a slow 2G round trip
      return route.continue();
    });
    await tap(page, 'Plus', { exact: true });
    await tap(page, 'Jëkkal', { exact: true });
    const title = `Puits ${Date.now().toString(36).slice(-4)}`;
    await page.getByPlaceholder('Ex: Frais médicaux pour Awa').filter({ visible: true }).first().fill(title);
    const btn = page.getByText('Lancer la collecte', { exact: true }).filter({ visible: true }).first();
    await btn.click();
    await btn.click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(4000);
    assert.equal(posts, 1, `one request on the wire (posts ${posts})`);
    assert.equal(await prisma.solidarityCampaign.count({ where: { title } }), 1, 'exactly one campaign');
    await ctx.close();
  });

  await step('recipient renamed + handle reclaimed after confirmation → refused, nobody paid, the sender must look again (J13-F12)', async () => {
    const a = await customer({ koriBalance: 20_000 });
    const A = await signedIn(api, a);
    const b = await customer();
    const c = await customer();
    const handle = `awa${Date.now().toString(36).slice(-6)}`;
    await prisma.user.update({ where: { id: b.id }, data: { handle, name: 'Awa Diop' } });
    await prisma.user.update({ where: { id: a.id }, data: { pinHash: await bcrypt.hash(PIN, 4) } });
    const { ctx, page } = await sessionPage(A, 'rebind');
    await tap(page, 'Yónnee', { exact: true });
    await see(page, 'À qui ?');
    await tap(page, 'Handle', { exact: true });
    await page.getByPlaceholder('@handle').filter({ visible: true }).first().fill(`@${handle}`);
    await see(page, 'Continuer →');
    await page.waitForTimeout(900);
    await tap(page, 'Continuer →');
    await see(page, 'Oui c\'est bien Awa Diop'); // the verified recipient is shown and must be confirmed
    // Between confirmation screen and tap: B renames, C takes the handle.
    await prisma.user.update({ where: { id: b.id }, data: { handle: `${handle}_old` } });
    await prisma.user.update({ where: { id: c.id }, data: { handle, name: 'Quelqu’un d’autre' } });
    const w = async (id) => { const x = await prisma.wallet.findUnique({ where: { userId: id } }); return x.balance + x.koriBalance; };
    const [a0, b0, c0] = [await w(a.id), await w(b.id), await w(c.id)];
    await tap(page, 'Oui — Envoyer');
    // J13-4: the binding is checked at confirmation, so the refusal usually comes BEFORE any PIN prompt; if a
    // PIN is asked first, a correct PIN must still not get the payment to the wrong account.
    const first = await Promise.race([
      page.getByText('Confirme ton PIN').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'pin'),
      page.getByText('Le destinataire a changé').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'refused'),
    ]).catch(() => 'nothing');
    if (first === 'pin') {
      for (const d of PIN) await tap(page, d, { exact: true, last: true });
      await see(page, 'Le destinataire a changé');
    }
    assert.ok(first !== 'nothing', 'neither a PIN prompt nor a refusal appeared');
    assert.equal(await seenEver(page, 'Le destinataire a changé'), true, 'the refusal is shown to the sender');
    await see(page, 'À qui ?'); // back to choosing the recipient: the stale one was dropped
    await page.waitForTimeout(1500);
    assert.deepEqual([await w(a.id), await w(b.id), await w(c.id)], [a0, b0, c0], 'no money moved for anyone');
    assert.equal(await seenEver(page, 'Envoyé'), false, 'never shown as sent');
    await ctx.close();
  });

  await step('a notification pointing at another account\'s parcel shows none of it (server refuses; navigation bypasses nothing)', async () => {
    const a = await customer();
    const A = await signedIn(api, a);
    const b = await customer();
    const hx = Date.now().toString(36).slice(-5);
    const hub = await prisma.deliveryHub.create({ data: { name: `Point ${hx}`, code: `PT-${hx}`, address: 'Rue 3', city: 'Dakar', lat: 14.7, lng: -17.4 } });
    const theirs = await prisma.hubParcel.create({ data: { reference: `HP-SECRET-${hx}`, ownerId: b.id, hubId: hub.id, status: 'at_hub', originCountry: 'FR', description: `Colis privé ${hx}`, pickupCode: '918273' } });
    await prisma.notification.create({ data: { userId: a.id, title: 'Ton colis est arrivé', body: 'Viens le chercher.', kind: 'hub_parcel', refId: theirs.id, category: 'orders' } });
    const { ctx, page } = await sessionPage(A, 'xparcel');
    await tap(page, 'Alertes', { exact: true });
    await see(page, 'Ton colis est arrivé');
    await tap(page, 'Voir', { exact: true });
    await see(page, 'Accès refusé');
    await page.waitForTimeout(1500);
    for (const leak of [`HP-SECRET-${hx}`, '918273', `Colis privé ${hx}`]) {
      assert.equal(await seenEver(page, leak), false, `leaked ${leak}`);
    }
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
