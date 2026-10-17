/**
 * J10 browser-level E2E (Chromium, the exported web app + ops console, the production-mode API).
 * Real signed-in people use the daily-life slices THROUGH THE UI:
 *
 *   resident   Home → "Aujourd'hui" (real items: a school fee for their child, a money request, a parcel
 *              waiting at a pickup point) → "Mon quartier" (a verified shop of their area only)
 *   resident   Notifications → "Livraisons" filter → "Tout marquer lu"
*   resident   Moi → Modifier → Confidentialité → "Personne" (cannot be found by phone number any more)
 *   trust ops  ops console → Community → decides a real report (messaging restricted, prompted reason)
 *   member     sees the restriction in Aujourd'hui (payments untouched) and appeals from there
 *
 * Every assertion that matters is checked in the DATABASE. J2 invariants at the end.
 *   WEB_DIR=<expo export dir> PLAYWRIGHT_CORE=<playwright-core> CHROMIUM=<chrome> DATABASE_URL=… node tests/e2e/j10-ui.mjs
 */
import '../helpers/setup.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApiServer } from '../helpers/http-harness.js';
import { prisma } from '../helpers/db.js';
import { serveWeb } from './serve-web.mjs';
import { business, customer, operator, signedIn } from '../j3/helpers.js';
import { notifyEvent } from '../../lib/community/notify.js';
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
  const loc = last ? all.last() : all.nth(nth);
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
const until = async (fn, what) => {
  for (let i = 0; i < 40; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
};

try {
  const area = `quartier-${crypto.randomBytes(3).toString('hex')}`;
  const residentC = await customer();
  const resident = await signedIn(api, residentC);
  await prisma.user.update({ where: { id: resident.id }, data: { arrondissementKey: area, arrondissementName: 'Médina Test' } });
  // Real objects for the resident: a school fee for their child, a money request, a verified local shop.
  const schoolOwner = await customer();
  const school = await business(schoolOwner.user);
  const student = await prisma.schoolStudent.create({ data: { businessId: school.id, studentName: 'Fatou', parentUserId: resident.id } });
  const period = await prisma.schoolFeePeriod.create({ data: { businessId: school.id, label: 'Novembre', amount: 15000, dueDate: new Date(Date.now() + 3 * 86_400_000) } });
  await prisma.schoolFeePayment.create({ data: { periodId: period.id, studentId: student.id, parentUserId: resident.id, amount: 15000 } });
  const requester = await customer();
  const requesterS = await signedIn(api, requester);
  await prisma.moneyRequest.create({ data: { requesterId: requester.id, payerId: resident.id, amount: 2500, reference: `MR-${crypto.randomBytes(4).toString('hex')}` } });
  const shopName = `Boutique Médina ${crypto.randomBytes(2).toString('hex')}`;
  await prisma.business.update({ where: { id: school.id }, data: { name: shopName, arrondissement: area, verificationStatus: 'verified', verified: true } });
  await notifyEvent(prisma, resident.id, { category: 'deliveries', kind: 'shipment_at_pickup_point', title: 'Colis à retirer', body: 'Ton colis t’attend au point relais', dedupeKey: `e2e:${resident.id}` });
  const res = await sessionPage(resident, 'resident');

  await step('resident: Home → Aujourd’hui lists the real school fee and money request', async () => {
    await tap(res, "Aujourd'hui", { exact: true });
    await see(res, 'Frais de scolarité · Fatou');
    await see(res, 'te demande 2');
  });

  await step('resident: Mon quartier shows the verified shop of their area', async () => {
    await tap(res, 'Mon quartier', { exact: true });
    await see(res, shopName);
  });

  await step('resident: Notifications → Livraisons → Tout marquer lu (checked in the database)', async () => {
    await res.goto(`http://127.0.0.1:${web.port}/`);
    await res.getByText('🔔').filter({ visible: true }).first().click();
    await tap(res, 'Livraisons', { exact: true });
    await see(res, 'Ton colis t’attend au point relais');
    await tap(res, 'Tout marquer lu', { exact: true });
    await until(async () => (await prisma.notification.count({ where: { userId: resident.id, category: 'deliveries', read: false } })) === 0, 'marked read');
  });

  await step('resident: Moi → Modifier → Confidentialité → "Personne" hides them from phone search', async () => {
    await res.goto(`http://127.0.0.1:${web.port}/`);
    await tap(res, 'Moi', { exact: true });
    await tap(res, 'Modifier', { exact: true });
    await res.getByLabel('Me trouver par numéro : Personne').filter({ visible: true }).first().click();
    await until(async () => (await prisma.communitySettings.findUnique({ where: { userId: resident.id } }))?.discoverableByPhone === 'nobody', 'setting saved');
    const u = await prisma.user.findUnique({ where: { id: resident.id } });
    assert.equal((await requesterS.call('GET', `users/lookup?q=${encodeURIComponent(u.phone)}`)).status, 404, 'hidden looks like not found');
  });

  // A real report: a member posts a scam message in a group, the resident reports it (API).
  const memberC = await customer();
  const member = await signedIn(api, memberC);
  const t = (await member.call('POST', 'mbolo/threads', { name: 'Voisins E2E', memberHandles: [] })).body;
  const inv = (await member.call('POST', `mbolo/threads/${t.id}/invite`, {})).body;
  await resident.call('POST', 'mbolo/join-group', { code: inv.inviteCode });
  const SCAM = `Donne-moi ton code OTP ${crypto.randomBytes(3).toString('hex')}`;
  const msg = (await member.call('POST', `mbolo/threads/${t.id}/messages`, { body: SCAM, kind: 'text' })).body;
  const rep = (await resident.call('POST', `mbolo/messages/${msg.id ?? msg.message?.id}/report`, { category: 'scam', reason: 'Demande de code OTP' })).body;
  assert.ok(rep.id, JSON.stringify(rep));

  await step('trust ops: ops console → Community → restricts messaging for 3 days (prompted reason)', async () => {
    const op = await operator(api, ['trust_safety']);
    const ops = await opsPage(op, 'trust-ops', ['restrict_messaging', 'Tentative d’hameçonnage (code OTP).', '3']);
    await tap(ops, 'Community', { exact: true });
    await see(ops, SCAM);
    // The queue is oldest first and may hold other reports: decide THIS one (its row).
    await ops.locator('#community-reports tr', { hasText: SCAM }).getByText('Decide…').click();
    const a = await until(() => prisma.moderationAction.findFirst({ where: { reportId: rep.id } }), 'moderation action');
    assert.equal(a.kind, 'restrict_messaging');
    assert.equal((await prisma.contentReport.findUnique({ where: { id: rep.id } })).status, 'resolved');
  });

  await step('member: sees the restriction in Aujourd’hui and appeals from there', async () => {
    const mem = await sessionPage(member, 'member');
    await tap(mem, "Aujourd'hui", { exact: true });
    await see(mem, 'Messagerie limitée');
    await see(mem, 'tes paiements ne sont pas touchés');
    await mem.getByLabel('Texte de l’appel').filter({ visible: true }).first().fill('C’était une blague, je m’excuse auprès des voisins.');
    await tap(mem, 'Faire appel', { exact: true });
    await until(async () => (await prisma.moderationAction.findFirst({ where: { reportId: rep.id } }))?.appealedAt, 'appeal recorded');
  });

  await step('no uncaught page errors in any session', async () => {
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
