/**
 * J9 browser-level E2E (Chromium, the exported web app + ops console, the production-mode API).
 * Real signed-in people drive one piece of paid work THROUGH THE UI:
 *
 *   employer   Business hub → "Recruter & missions" → publish a short mission → review the applicant
 *              → "Faire une offre — bloquer …" → PIN step-up (the money is escrowed BEFORE acceptance)
 *   worker     Plus → Mouvement → Travail → "Trouver du travail" → apply → read the exact terms →
 *              accept → submit evidence → (after the ruling and hold) pay out to the wallet
 *   employer   contests the submitted work ("Contester")
 *   work ops   ops console → Work → rules for the worker (prompted reason)
 *   finance    ops console → Work → "Approve & execute" (maker/checker settlement)
 *   employer   a posting asking workers for a fee is held for review and invisible to workers
 *
 * Every assertion that matters is checked in the DATABASE (escrow, offer, assignment, dispute,
 * earning, wallet) — the UI is never trusted on its own. J2 + J9 invariants at the end.
 *
 *   WEB_DIR=<expo export dir> PLAYWRIGHT_CORE=<playwright-core> CHROMIUM=<chrome> DATABASE_URL=… node tests/e2e/j9-ui.mjs
 */
import '../helpers/setup.js';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { startApiServer } from '../helpers/http-harness.js';
import { prisma } from '../helpers/db.js';
import { serveWeb } from './serve-web.mjs';
import { operator } from '../j3/helpers.js';
import { employer, worker } from '../j9/fixture.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertWorkInvariants } from '../../lib/work/invariants.js';
import { runWorkMaintenance } from '../../lib/work/money.js';

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

const api = await startApiServer({ JOKKO_WORK_MONEY_ENABLED: 'true' });
const web = await serveWeb({ dir: process.env.WEB_DIR, apiPort: Number(new URL(api.base).port) });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const errors = [];
const PIN = '482913';

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
async function opsPage(op, label, answers) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${String(e).slice(0, 200)}`));
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt') await d.accept(answers.shift() ?? '');
    else await d.accept();
  });
  await page.addInitScript((token) => localStorage.setItem('k21_admin_token', token), op.token);
  await page.goto(`http://127.0.0.1:${web.port}/admin/`);
  return page;
}
const tap = async (page, text, { exact = false, nth = 0, last = false } = {}) => {
  const all = page.getByText(text, { exact }).filter({ visible: true });
  const loc = last ? all.last() : all.nth(nth); // stacked screens stay in the DOM, hidden
  await loc.waitFor({ state: 'visible', timeout: 20_000 });
  await loc.click();
};
const see = async (page, text) => {
  try {
    await page.getByText(text).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    const body = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
    throw new Error(`"${text}" not visible; screen: …${body.slice(-600)}`);
  }
};
const fill = async (page, label, value) => {
  const input = page.getByLabel(label, { exact: true }).filter({ visible: true }).first();
  await input.waitFor({ state: 'visible', timeout: 20_000 });
  await input.fill(value);
};
const until = async (fn, what) => {
  for (let i = 0; i < 40; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
};

try {
  const e = await employer(api);
  await prisma.user.update({ where: { id: e.owner.id }, data: { pinHash: await bcrypt.hash(PIN, 4) } });
  const w = await worker(api, { skills: ['inventaire'] });
  const TITLE = `Inventaire boutique ${Date.now().toString(36)}`;
  const emp = await sessionPage(e.owner, 'employer');
  const wrk = await sessionPage(w, 'worker');
  let opp;
  let offer;
  let assignment;

  await step('employer: publishes a short paid mission from the business hub', async () => {
    await tap(emp, 'Recruter & missions');
    await fill(emp, 'Intitulé', TITLE);
    await fill(emp, 'Description', 'Compter le stock du magasin et saisir les quantités dans le cahier.');
    await fill(emp, 'Quartier', 'Pikine');
    await fill(emp, 'Rémunération', '2000');
    await tap(emp, 'Publier', { exact: true, last: true });
    await see(emp, 'Annonce publiée');
    opp = await until(() => prisma.workOpportunity.findFirst({ where: { businessId: e.b.id, title: TITLE } }), 'opportunity');
    assert.deepEqual([opp.status, opp.funding, opp.rateKori, opp.area], ['open', 'prepaid', 2000, 'pikine']);
  });

  await step('worker: finds it under Mouvement → Travail and applies', async () => {
    await tap(wrk, 'Plus', { exact: true });
    await tap(wrk, 'Mouvement', { exact: true });
    await tap(wrk, 'Travail', { exact: true });
    await tap(wrk, 'Trouver du travail');
    await tap(wrk, TITLE);
    await see(wrk, 'Paiement bloqué avant le début');
    await tap(wrk, 'Postuler', { exact: true });
    await see(wrk, 'Candidature envoyée');
    const app = await until(() => prisma.workApplication.findFirst({ where: { opportunityId: opp.id, workerUserId: w.id } }), 'application');
    assert.equal(app.status, 'submitted');
  });

  await step('employer: reviews the applicant (no contact data) and sends a FUNDED offer after PIN step-up', async () => {
    const before = (await prisma.businessWallet.findUnique({ where: { businessId: e.b.id } })).balance;
    await tap(emp, 'Candidats', { exact: true });
    await tap(emp, `${TITLE} ›`);
    await see(emp, w.user.name ?? w.handle);
    const body = await emp.innerText('body');
    assert.ok(!body.includes(w.phone), 'no phone on the applicant card');
    await tap(emp, 'Faire une offre');
    await see(emp, 'Confirme ton PIN');
    for (const d of PIN) await tap(emp, d, { exact: true, last: true });
    await see(emp, 'Offre envoyée');
    offer = await until(() => prisma.workOffer.findFirst({ where: { opportunityId: opp.id } }), 'offer');
    assert.equal(offer.fundingStatus, 'held');
    assert.equal(Number((await prisma.ledgerAccount.findUnique({ where: { code: `escrow:work:${offer.id}` } })).balance), 2000);
    assert.equal((await prisma.businessWallet.findUnique({ where: { businessId: e.b.id } })).balance, before - 2000);
  });

  await step('worker: reads the exact terms (funded) and accepts', async () => {
    await tap(wrk, 'Candidatures', { exact: true });
    await tap(wrk, 'Actualiser', { exact: true, last: true });
    await see(wrk, 'bloqué pour toi ✓');
    await tap(wrk, 'Accepter ces conditions');
    await see(wrk, 'Offre acceptée');
    assignment = await until(() => prisma.workAssignment.findUnique({ where: { offerId: offer.id } }), 'assignment');
    assert.equal(assignment.status, 'active');
  });

  await step('worker: submits evidence for validation', async () => {
    await tap(wrk, 'Missions', { exact: true });
    await fill(wrk, 'Preuve', 'Inventaire terminé : 214 références comptées, cahier signé.');
    await tap(wrk, 'Envoyer pour validation');
    await see(wrk, 'Envoyé');
    const m = await until(async () => {
      const x = await prisma.workMilestone.findFirst({ where: { assignmentId: assignment.id } });
      return x.status === 'submitted' ? x : null;
    }, 'submitted milestone');
    assert.ok(m.acceptDeadline > new Date());
  });

  await step('employer: contests the submitted work → dispute open, money frozen in escrow', async () => {
    await tap(emp, 'Missions', { exact: true });
    await tap(emp, 'Actualiser', { exact: true, last: true });
    await tap(emp, 'Contester', { exact: true });
    await see(emp, 'Litige ouvert');
    const d = await until(() => prisma.workDispute.findFirst({ where: { assignmentId: assignment.id, status: 'open' } }), 'dispute');
    assert.equal(d.kind, 'false_completion');
    assert.equal(await prisma.workEarning.count({ where: { assignmentId: assignment.id } }), 0);
  });

  await step('work ops (console): rules for the worker — a ruling alone moves no money', async () => {
    const ops = await operator(api, ['work_ops']);
    const page = await opsPage(ops, 'ops', ['worker', 'Inventaire vérifié sur place : travail réalisé.']);
    await tap(page, 'Work', { exact: true });
    const row = page.locator('tr', { hasText: assignment.reference });
    await row.waitFor({ state: 'visible', timeout: 20_000 });
    await row.getByText('Rule…', { exact: true }).click();
    await until(async () => (await prisma.workDispute.findFirst({ where: { assignmentId: assignment.id } })).status === 'awaiting_settlement', 'ruling');
    assert.equal(await prisma.workEarning.count({ where: { assignmentId: assignment.id } }), 0);
  });

  await step('finance (console): a second operator executes the settlement once', async () => {
    // The ruling's money waits for the appeal window; here it elapses (no party appealed).
    await prisma.workDispute.updateMany({ where: { assignmentId: assignment.id }, data: { executableAfter: new Date(Date.now() - 1000) } });
    const fin = await operator(api, ['finance_ops']);
    const page = await opsPage(fin, 'finance', []);
    await tap(page, 'Work', { exact: true });
    const row = page.locator('tr', { hasText: `work_assignment:${assignment.id}` });
    await row.waitFor({ state: 'visible', timeout: 20_000 });
    await row.getByText('Approve & execute', { exact: true }).click();
    const earn = await until(() => prisma.workEarning.findFirst({ where: { assignmentId: assignment.id } }), 'earning');
    assert.deepEqual([earn.amountKori, earn.status, earn.classification], [2000, 'accrued', 'contractor_payment']);
    assert.equal(Number((await prisma.ledgerAccount.findUnique({ where: { code: `escrow:work:${offer.id}` } })).balance), 0);
  });

  await step('worker: after the hold, pays the earning out to the wallet — once', async () => {
    await prisma.workEarning.updateMany({ where: { assignmentId: assignment.id }, data: { releasableAt: new Date(Date.now() - 1000) } });
    await runWorkMaintenance(prisma);
    const w0 = (await prisma.wallet.findUnique({ where: { userId: w.id } })).koriBalance;
    await tap(wrk, 'Gains', { exact: true });
    await tap(wrk, 'Actualiser', { exact: true, last: true });
    await tap(wrk, 'Verser le disponible sur mon portefeuille');
    await see(wrk, 'versés sur ton portefeuille');
    assert.equal((await prisma.wallet.findUnique({ where: { userId: w.id } })).koriBalance, w0 + 2000);
    assert.equal((await prisma.workEarning.findFirst({ where: { assignmentId: assignment.id } })).status, 'paid');
  });

  await step('employer: a posting that asks workers for a fee is held for review, invisible to workers', async () => {
    await tap(emp, 'Publier', { exact: true });
    await fill(emp, 'Intitulé', 'Vendeur rapide');
    await fill(emp, 'Description', 'Bon travail. Frais d’inscription de 5000 à payer avant de commencer.');
    await fill(emp, 'Rémunération', '1000');
    await tap(emp, 'Publier', { exact: true, last: true });
    await see(emp, 'Annonce en vérification');
    const held = await until(() => prisma.workOpportunity.findFirst({ where: { businessId: e.b.id, title: 'Vendeur rapide' } }), 'held posting');
    assert.equal(held.status, 'under_review');
    await tap(wrk, 'Trouver', { exact: true });
    await tap(wrk, 'Actualiser', { exact: true, last: true });
    assert.ok(!(await wrk.innerText('body')).includes('Vendeur rapide'));
  });

  await step('no uncaught page errors in any session', async () => {
    assert.deepEqual(errors, []);
  });
  await assertInvariants(prisma);
  await assertWorkInvariants(prisma);
  log('INVARIANTS OK');
} finally {
  log(JSON.stringify({ passed: results.filter((r) => r[0] === 'PASS').length, failed: results.filter((r) => r[0] === 'FAIL').length }));
  await browser.close();
  web.close();
  await api.stop();
  await prisma.$disconnect();
}
