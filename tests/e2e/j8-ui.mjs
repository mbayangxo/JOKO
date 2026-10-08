/**
 * J8 browser-level E2E (Chromium, the exported web app, the production-mode API).
 * Three real signed-in people drive one distributor → merchant delivery THROUGH THE UI:
 *
 *   distributor  Business hub → Dispatch → "Expédier avec suivi" → choose driver → "Attribuer"
 *                → shipment → "Donner le code d’enlèvement au livreur"   (code read from the screen)
 *   driver       Marketplace → Mouvement → "Mes livraisons attribuées" → accept → pickup code
 *                → "Je suis arrivé"
 *   merchant     Business hub → "Réceptions fournisseurs à déclarer" → shipment → per-line receiving
 *                (2 damaged) → then maps the unmatched receipt to its OWN product
 *
 * Every assertion that matters is checked in the DATABASE afterwards (custody, proof,
 * stock, unmatched receipt, PO status) — the UI is never trusted on its own.
 *
 * Run (local, needs a web export and playwright-core):
 *   WEB_DIR=<expo export dir> PLAYWRIGHT_CORE=<path to playwright-core> CHROMIUM=<chrome path> \
 *   DATABASE_URL=... node tests/e2e/j8-ui.mjs
 */
import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { startApiServer } from '../helpers/http-harness.js';
import { prisma } from '../helpers/db.js';
import { serveWeb } from './serve-web.mjs';
import { fleetDriver, jokkoCourier, readyPo, shipmentFor } from '../j8/fixture.js';
import { business, customer, operator, signedIn } from '../j3/helpers.js';
import { fundUser } from '../helpers/db.js';
import crypto from 'node:crypto';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertLogisticsInvariants } from '../../lib/logistics/invariants.js';

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

const api = await startApiServer({ JOKKO_LOGISTICS_ENABLED: 'true' });
const web = await serveWeb({ dir: process.env.WEB_DIR, apiPort: Number(new URL(api.base).port) });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const errors = [];

async function sessionPage(person, label) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${String(e).slice(0, 200)}`));
  await page.addInitScript(({ token, refresh, device }) => {
    sessionStorage.setItem('k21_access_token', token);
    sessionStorage.setItem('k21_refresh_token', refresh);
    sessionStorage.setItem('k21_device_id', device);
    sessionStorage.setItem('k21_pin_configured', '1');
    sessionStorage.setItem('k21_last_activity', String(Date.now()));
  }, { token: person.token, refresh: person.refresh, device: person.device });
  await page.goto(`http://127.0.0.1:${web.port}/`);
  return page;
}
const tap = async (page, text, { exact = false, nth = 0 } = {}) => {
  const loc = page.getByText(text, { exact }).filter({ visible: true }).nth(nth); // stacked screens stay in the DOM, hidden
  await loc.waitFor({ state: 'visible', timeout: 20_000 });
  await loc.click();
};
const see = async (page, text) => {
  try {
    await page.getByText(text).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 20_000 });
  } catch (e) {
    const body = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
    throw new Error(`"${text}" not visible; screen: …${body.slice(-500)}`);
  }
};
const readCode = async (page) => {
  await see(page, 'usage unique');
  const body = await page.innerText('body');
  const m = body.match(/\n([A-HJ-NP-Z2-9]{8})\n/);
  if (!m) throw new Error(`no code on screen: ${body.slice(0, 300)}`);
  return m[1];
};
const typeCode = async (page, label, code) => {
  const input = page.getByLabel(label).first();
  await input.waitFor({ state: 'visible', timeout: 20_000 });
  await input.fill(code);
  await tap(page, 'Valider le code');
};

let x;
let sh;
try {
  x = await readyPo(api, { packs: 2 }); // 24 units, paid, ready
  const driverS = await fleetDriver(api, x.sup.b);
  const sup = await sessionPage(x.sup.owner, 'distributor');
  const drv = await sessionPage(driverS, 'driver');
  const mer = await sessionPage(x.m.owner, 'merchant');

  await step('distributor: Dispatch shows the paid PO and hands it to a TRACKED shipment', async () => {
    await tap(sup, 'Dispatch : expéditions & tournées');
    await see(sup, x.po.reference);
    await tap(sup, 'Expédier avec suivi');
    await see(sup, 'Expédition créée');
    sh = await shipmentFor(x.po.id);
    assert.ok(sh, 'a shipment exists in the database');
    assert.equal(sh.status, 'ready_for_pickup');
  });

  await step('distributor: assigns their own driver from the Expéditions tab', async () => {
    await tap(sup, 'Expéditions', { exact: true });
    await tap(sup, driverS.user.name ?? driverS.user.handle ?? 'Membre');
    await tap(sup, 'Attribuer', { exact: true });
    await see(sup, 'Livreur attribué');
    const a = await prisma.courierAssignment.findFirst({ where: { shipmentId: sh.id, status: 'active' } });
    assert.equal(a.courierUserId, driverS.id);
    assert.equal(a.acceptedAt, null, 'offered, not yet accepted');
  });

  await step('driver: sees the OFFERED course (no open marketplace) and accepts it', async () => {
    await tap(drv, 'Plus', { exact: true }); // home quick actions → more actions
    await tap(drv, 'Mouvement', { exact: true });
    await tap(drv, 'Mes livraisons attribuées');
    await see(drv, 'Proposées — à accepter ou refuser');
    await tap(drv, sh.reference, { exact: false });
    await tap(drv, 'Accepter', { exact: true });
    await see(drv, 'Course acceptée');
    assert.ok((await prisma.courierAssignment.findFirst({ where: { shipmentId: sh.id, status: 'active' } })).acceptedAt);
  });

  await step('distributor: opens the shipment and issues the pickup code; driver types it → custody moves to the courier', async () => {
    await tap(sup, sh.reference, { exact: false });
    await tap(sup, 'Donner le code d’enlèvement au livreur');
    const code = await readCode(sup);
    await typeCode(drv, 'Code d’enlèvement (donné par l’expéditeur)', code);
    await see(drv, 'Enlèvement confirmé');
    const s = await prisma.shipment.findUnique({ where: { id: sh.id } });
    assert.deepEqual([s.status, s.custody, s.custodianUserId], ['picked_up', 'courier', driverS.id]);
  });

  await step('driver: wrong code is refused and nothing moves', async () => {
    await typeCode(drv, 'Code de livraison (donné par le destinataire)', 'AAAAAAAA');
    await see(drv, 'Code invalide');
    assert.equal((await prisma.shipment.findUnique({ where: { id: sh.id } })).status, 'picked_up');
  });

  await step('driver: arrives; merchant records per-line receiving (22 good, 2 damaged) → delivered with receiver proof', async () => {
    await tap(drv, 'Je suis arrivé');
    await see(drv, 'Arrivée notée');
    await tap(mer, 'Réceptions fournisseurs à déclarer →');
    await tap(mer, sh.reference, { exact: false });
    await see(mer, 'Réception article par article');
    // Commercial order and payment are shown SEPARATELY from receiving.
    await see(mer, 'La réception des marchandises et le paiement sont deux choses séparées');
    await mer.getByLabel('Moins Reçus en bon état').first().click();
    await mer.getByLabel('Moins Reçus en bon état').first().click();
    await mer.getByLabel('Plus Abîmés').first().click();
    await mer.getByLabel('Plus Abîmés').first().click();
    await tap(mer, 'Enregistrer la réception');
    await see(mer, 'Réception enregistrée');
    const s = await prisma.shipment.findUnique({ where: { id: sh.id } });
    assert.deepEqual([s.status, s.deliveryProof], ['delivered', 'receiver_receiving']);
    const po = await prisma.purchaseOrder.findUnique({ where: { id: x.po.id } });
    assert.equal(po.status, 'disputed', 'a damaged line never becomes a false "complete"');
  });

  await step('merchant: received units wait as UNMATCHED (no stock contamination); mapping to its own product adds 22 once', async () => {
    const own = await prisma.product.create({ data: { businessId: x.m.b.id, title: 'Huile 1L — rayon', price: 1700, inventory: 0 } });
    await mer.getByLabel('Retour').filter({ visible: true }).last().click(); // in-app back → list refreshes on focus
    await see(mer, 'Reçu — à associer à mon catalogue');
    await tap(mer, 'Toucher pour choisir ton produit', { exact: false });
    await tap(mer, 'Huile 1L — rayon');
    await see(mer, 'unité(s) ajoutées');
    assert.equal((await prisma.product.findUnique({ where: { id: own.id } })).inventory, 22);
    assert.equal(await prisma.unmatchedReceipt.count({ where: { shipmentId: sh.id, status: 'pending' } }), 0);
  });

  await step('customer: a consumer delivery order is a verified J8 shipment; the customer gives the code in the app; the order becomes delivered', async () => {
    const shopOwnerC = await customer();
    const shopOwner = await signedIn(api, shopOwnerC);
    const shop = await business(shopOwnerC.user);
    const item = (await shopOwner.call('POST', `businesses/${shop.id}/os/catalog`, { title: 'Yassa', priceKori: 300, initialStock: 5 })).body;
    const buyerC = await customer();
    await fundUser(buyerC.id, 3000);
    const buyer = await signedIn(api, buyerC);
    const o = (await buyer.call('POST', 'marketplace/orders', { businessId: shop.id, items: [{ productId: item.id, quantity: 1 }], fulfillmentType: 'delivery', dropoff: { area: 'Médina', address: 'Rue 11' } }, { headers: { 'idempotency-key': `k-${crypto.randomBytes(6).toString('hex')}` } })).body;
    const req = await prisma.fulfilmentRequest.findFirst({ where: { sourceSystem: 'jokko_order', sourceId: o.orderId } });
    const csh = await prisma.shipment.findFirst({ where: { requestId: req.id } });
    // The shop owner delivers themselves (own fleet) — pickup via API, the CUSTOMER side through the UI.
    const as = await shopOwner.call('POST', `logistics/shipments/${csh.id}/assign`, { courierUserId: shopOwner.id });
    assert.equal(as.status, 200, JSON.stringify(as.body));
    const pc = (await shopOwner.call('POST', `logistics/shipments/${csh.id}/codes`, { purpose: 'pickup' })).body;
    const pu = await shopOwner.call('POST', `logistics/shipments/${csh.id}/pickup`, { code: pc.code });
    assert.equal(pu.status, 200, JSON.stringify(pu.body));
    const cus = await sessionPage(buyer, 'customer');
    await tap(cus, 'Plus', { exact: true });
    await tap(cus, 'Mouvement', { exact: true });
    await tap(cus, 'Mes réceptions');
    await tap(cus, csh.reference, { exact: false });
    await see(cus, 'Enlevée — chez le livreur');
    const body = await cus.innerText('body');
    assert.ok(!body.includes('Rue 11'), 'the customer view is area-level; the precise address is only for the courier');
    await tap(cus, 'Donner mon code de livraison');
    const code = await readCode(cus);
    const d = await shopOwner.call('POST', `logistics/shipments/${csh.id}/deliver`, { code });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal((await prisma.order.findUnique({ where: { id: o.orderId } })).status, 'delivered');
  });

  await step('courier earnings: after a verified Jokko delivery the Gains tab shows the held earning (24 h hold), nothing payable yet', async () => {
    const y = await readyPo(api, { packs: 1 });
    const ops = await operator(api, ['logistics_ops']);
    await y.sup.owner.call('POST', `businesses/${y.sup.b.id}/b2b/purchase-orders/${y.po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'jokko_logistics' });
    const js = await shipmentFor(y.po.id);
    const c = await jokkoCourier(api);
    await ops.call('POST', `admin/logistics/shipments/${js.id}/accept`, {});
    await y.sup.owner.call('POST', `logistics/shipments/${js.id}/ready`, {});
    await ops.call('POST', `admin/logistics/shipments/${js.id}/assign`, { courierUserId: c.id });
    const pc = (await y.sup.owner.call('POST', `logistics/shipments/${js.id}/codes`, { purpose: 'pickup' })).body;
    await c.call('POST', `logistics/shipments/${js.id}/pickup`, { code: pc.code });
    const dc = (await y.m.owner.call('POST', `logistics/shipments/${js.id}/codes`, { purpose: 'delivery' })).body;
    await c.call('POST', `logistics/shipments/${js.id}/deliver`, { code: dc.code });
    const cp = await sessionPage(c, 'jokko-courier');
    await tap(cp, 'Plus', { exact: true });
    await tap(cp, 'Mouvement', { exact: true });
    await tap(cp, 'Mes livraisons attribuées');
    await tap(cp, 'Gains', { exact: true });
    await see(cp, 'En attente (24 h ou litige)');
    const text = await cp.innerText('body');
    assert.match(text, /En attente : \D*120\b/);
    assert.match(text, /Disponible : \D*0\b/);
    const btn = cp.getByText('Verser le disponible sur mon portefeuille').first();
    assert.equal(await btn.isVisible(), true);
    // Disabled: nothing releasable — pressing it does nothing (no request, no money moved).
    const before = (await prisma.wallet.findUnique({ where: { userId: c.id } })).koriBalance;
    await btn.click({ force: true });
    assert.equal((await prisma.wallet.findUnique({ where: { userId: c.id } })).koriBalance, before);
  });

  await step('no uncaught page errors in any session', async () => {
    assert.deepEqual(errors, []);
  });
  await assertInvariants(prisma);
  await assertLogisticsInvariants(prisma);
  log('INVARIANTS OK');
} finally {
  log(JSON.stringify({ passed: results.filter((r) => r[0] === 'PASS').length, failed: results.filter((r) => r[0] === 'FAIL').length }));
  await browser.close();
  web.close();
  await api.stop();
  await prisma.$disconnect();
}
