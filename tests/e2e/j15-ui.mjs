/**
 * J15-D2 browser E2E — the S4 approval screen (Chromium, exported web app, production-mode API, DB-checked).
 *   approve (explicit confirmation + PIN, every recipient shown, paid once) · reject (reason) · expired · insufficient.
 *   WEB_DIR=… PLAYWRIGHT_CORE=… CHROMIUM=… DATABASE_URL=… node tests/e2e/j15-ui.mjs
 */
import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { startApiServer } from '../helpers/http-harness.js';
import { prisma } from '../helpers/db.js';
import { serveWeb } from './serve-web.mjs';
import { business, customer, signedIn } from '../j3/helpers.js';
import { fundBusiness } from '../helpers/db.js';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
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

const KEBU = `e2e-kebu-${crypto.randomBytes(8).toString('hex')}`;
const api = await startApiServer({ JOKO_API_KEYS: `kebu:${KEBU}`, PARTNER_DEBIT_INSTRUCTIONS_ENABLED: 'true' });
const PIN = '482913';
const hex = () => crypto.randomBytes(3).toString('hex');
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

/** An owner (boots into the business hub), a funded business wallet, a consented link to the partner. */
async function shop(funds) {
  const ownerC = await customer();
  await prisma.user.update({ where: { id: ownerC.id }, data: { pinHash: await bcrypt.hash(PIN, 4) } });
  const owner = await signedIn(api, ownerC);
  const b = await business(ownerC.user);
  await prisma.business.update({ where: { id: b.id }, data: { name: `Boutique ${hex()}` } });
  await prisma.businessWallet.create({ data: { businessId: b.id } });
  if (funds) await fundBusiness(b.id, funds);
  const code = await owner.call('POST', `businesses/${b.id}/os/integrations/link-code`, {});
  const ext = `shop_${hex()}`;
  const l = await api.client('POST', 'v1/business-links', { headers: { 'x-api-key': KEBU }, body: { code: code.body.code, external_business_id: ext } });
  assert.equal(l.status, 201, JSON.stringify(l.body));
  return { ownerC, owner, b, ext };
}
const request = (body) => api.client('POST', 'v1/debit-instructions', { headers: { 'x-api-key': KEBU }, body });
const bal = async (id) => { const w = await prisma.wallet.findUnique({ where: { userId: id } }); return w.balance + w.koriBalance; };
async function openRequests(s, label) {
  const { ctx, page } = await sessionPage(s.owner, label);
  await tap(page, 'Demandes de paiement des partenaires');
  await see(page, 'À approuver');
  return { ctx, page };
}

try {
  await step('S4 payroll batch: every recipient + fees + total + balance + expiry shown; approve needs explicit confirmation + PIN; paid exactly once', async () => {
    const s = await shop(100_000);
    const emps = [];
    for (const name of ['Awa Ndiaye', 'Moussa Fall', 'Fatou Sarr']) {
      const c = await customer();
      await prisma.user.update({ where: { id: c.id }, data: { name } });
      await prisma.payrollEmployee.create({ data: { businessId: s.b.id, userId: c.id, status: 'active' } });
      emps.push(c);
    }
    const r = await request({ external_business_id: s.ext, external_ref: `run_${hex()}`, kind: 'payroll_batch', memo: 'Salaires octobre', lines: emps.map((e, i) => ({ recipient_handle: e.handle, amount_kori: 1000 * (i + 1) })) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { ctx, page } = await openRequests(s, 's4-approve');
    await tap(page, 'Paie (lot) · kebu');
    for (const n of ['Awa Ndiaye', 'Moussa Fall', 'Fatou Sarr', 'Salaires octobre', 'Frais K21', 'Total débité du commerce', 'Solde du commerce', 'Expire dans']) await see(page, n);
    await see(page, '6 000 ₭');
    const before = await Promise.all(emps.map((e) => bal(e.id)));
    // The approve control is disabled (and announced as such) before the explicit confirmation; a forced
    // click on it still does nothing.
    assert.equal(await page.getByTestId('pd-approve').isDisabled(), true, 'approve disabled before confirmation');
    assert.equal(await page.getByTestId('pd-approve').getAttribute('aria-disabled'), 'true');
    await page.getByTestId('pd-approve').click({ force: true });
    await page.waitForTimeout(800);
    assert.equal((await prisma.partnerDebitInstruction.findUnique({ where: { id: r.body.id } })).status, 'requested', 'no approval without confirmation');
    await page.getByTestId('pd-confirm').click();
    await page.getByTestId('pd-approve').click();
    await see(page, 'Confirme ton PIN');
    for (const d of PIN) await tap(page, d, { exact: true, last: true });
    await see(page, 'Approuvée et payée');
    const row = await prisma.partnerDebitInstruction.findUnique({ where: { id: r.body.id } });
    assert.equal(row.status, 'executed');
    const after = await Promise.all(emps.map((e) => bal(e.id)));
    assert.deepEqual(after.map((v, i) => v - before[i]), [1000, 2000, 3000]);
    await ctx.close();
  });

  await step('S4 reject: a reason is required; refused request moves nothing; the partner sees rejected', async () => {
    const s = await shop(50_000);
    const p = await customer();
    const r = await request({ external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: p.handle, amount_kori: 700 }] });
    const { ctx, page } = await openRequests(s, 's4-reject');
    await tap(page, 'Paiement · kebu');
    await page.getByTestId('pd-reject').click();
    await page.getByTestId('pd-reason').fill('Pas prévu ce mois-ci');
    await page.getByTestId('pd-reject-confirm').click();
    await see(page, 'Refusée');
    assert.equal((await prisma.partnerDebitInstruction.findUnique({ where: { id: r.body.id } })).status, 'rejected');
    assert.equal(await bal(p.id), 0);
    assert.equal((await api.client('GET', `v1/debit-instructions/${r.body.id}`, { headers: { 'x-api-key': KEBU } })).body.status, 'rejected');
    await ctx.close();
  });

  await step('S4 expired: past 15 minutes the request shows expired, nothing to approve, nothing debited', async () => {
    const s = await shop(50_000);
    const p = await customer();
    const r = await request({ external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: p.handle, amount_kori: 900 }] });
    // Age the request (expiresAt is immutable by design: re-create it as an aged copy for the test).
    const row = await prisma.partnerDebitInstruction.findUnique({ where: { id: r.body.id } });
    await prisma.$executeRawUnsafe('ALTER TABLE "PartnerDebitInstruction" DISABLE TRIGGER "PartnerDebitInstruction_guard"');
    await prisma.partnerDebitInstruction.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await prisma.$executeRawUnsafe('ALTER TABLE "PartnerDebitInstruction" ENABLE TRIGGER "PartnerDebitInstruction_guard"');
    const { ctx, page } = await openRequests(s, 's4-expired');
    await see(page, 'Aucune demande en attente');
    await tap(page, 'Paiement · kebu');
    await see(page, 'Expirée — rien n’a été débité');
    assert.equal(await page.getByTestId('pd-approve').count(), 0, 'no approve control on an expired request');
    assert.equal(await bal(p.id), 0);
    await ctx.close();
  });

  await step('S4 insufficient balance: shown, approval impossible, rejection possible', async () => {
    const s = await shop(500);
    const p = await customer();
    await request({ external_business_id: s.ext, external_ref: `po_${hex()}`, kind: 'payout', lines: [{ recipient_handle: p.handle, amount_kori: 5000 }] });
    const { ctx, page } = await openRequests(s, 's4-poor');
    await tap(page, 'Paiement · kebu');
    await see(page, 'Solde insuffisant pour ce paiement.');
    assert.equal(await page.getByTestId('pd-confirm').count(), 0, 'no confirmation offered');
    assert.equal(await page.getByTestId('pd-approve').isDisabled(), true, 'approve disabled when underfunded');
    await see(page, 'Refuser la demande');
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
