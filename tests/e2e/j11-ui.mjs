/**
 * J11 browser-level E2E (Chromium, exported web app + ops console, production-mode API with the J11
 * collective flag switched on LOCALLY — it stays off in production).
 *
 *   organizer  Natta → Groupes d’épargne → create a rotating group → invite two people → propose rules
 *   members    join from their list (joining commits to nothing), read the drawn order, approve the rules
 *   everyone   "Cotiser" from the group screen → the cycle-1 pot goes to the drawn recipient (DB checked)
 *   member     proposes "+3 jours de délai"; another member votes "Oui" → the vote passes (DB checked)
 *   member     opens a dispute; collective ops rules it "continue" in the console Collectif tab
 *   member     confirms a coop-capital line in "Mon registre coopérative" (records only, no money)
 *
 *   WEB_DIR=<expo export dir> PLAYWRIGHT_CORE=<playwright-core> CHROMIUM=<chrome> DATABASE_URL=… node tests/e2e/j11-ui.mjs
 */
import '../helpers/setup.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApiServer } from '../helpers/http-harness.js';
import { prisma } from '../helpers/db.js';
import { serveWeb } from './serve-web.mjs';
import { business, customer, operator, signedIn } from '../j3/helpers.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { checkCollectiveInvariants } from '../../lib/collective/invariants.js';

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

const api = await startApiServer({ JOKKO_COLLECTIVE_ENABLED: 'true' });
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
  for (let i = 0; i < 60; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
};
const toGroups = async (page) => {
  await page.goto(`http://127.0.0.1:${web.port}/`);
  await tap(page, 'Natta', { exact: true });
  await tap(page, 'Groupes d’épargne (nouveau)');
  await see(page, 'Chaque membre approuve les règles');
};

const openGroup = async (page, name) => {
  await toGroups(page);
  await tap(page, name);
};

try {
  const people = [];
  for (let i = 0; i < 3; i += 1) people.push(await signedIn(api, await customer({ koriBalance: 20_000 })));
  const [org, a, b] = people;
  const name = `Natt Médina ${crypto.randomBytes(2).toString('hex')}`;
  const P = {};
  for (const [k, p] of Object.entries({ org, a, b })) P[k] = await sessionPage(p, k);
  let groupId;

  await step('organizer: creates a rotating group and invites two people through the UI', async () => {
    await toGroups(P.org);
    await tap(P.org, '＋ Créer un groupe');
    await P.org.getByLabel('Nom du groupe').filter({ visible: true }).first().fill(name);
    await P.org.getByLabel('Cotisation en Kori').filter({ visible: true }).first().fill('1000');
    await tap(P.org, 'Créer', { exact: true });
    await see(P.org, 'Préparer le groupe');
    groupId = (await until(() => prisma.collectiveGroup.findFirst({ where: { name } }), 'group created')).id;
    await P.org.getByLabel('Pseudos à inviter').filter({ visible: true }).first().fill(`@${a.handle}, @${b.handle}`);
    await tap(P.org, 'Inviter', { exact: true });
    await until(async () => (await prisma.collectiveMember.count({ where: { groupId, status: 'invited' } })) === 2, 'two invitations');
  });

  await step('members: join from their list — no money, no rules yet', async () => {
    for (const k of ['a', 'b']) {
      await toGroups(P[k]);
      await see(P[k], name);
      await tap(P[k], 'Rejoindre', { exact: true });
    }
    await until(async () => (await prisma.collectiveMember.count({ where: { groupId, status: 'joined' } })) === 3, 'three joined');
    assert.equal(await prisma.collectiveObligation.count({ where: { groupId } }), 0);
  });

  await step('organizer proposes the rules; each member reads the drawn order and approves → the group starts', async () => {
    await openGroup(P.org, name);
    await tap(P.org, 'Proposer les règles', { exact: true });
    await until(async () => (await prisma.collectiveGroup.findUnique({ where: { id: groupId } })).status === 'awaiting_acceptance', 'rules proposed');
    for (const k of ['org', 'a', 'b']) {
      await openGroup(P[k], name);
      await see(P[k], 'Cycle 1 (');
      await tap(P[k], 'J’approuve ces règles', { exact: true });
      await until(async () => (await prisma.collectiveMember.findFirst({ where: { groupId, userId: ({ org, a, b })[k].id } })).acceptedRulesHash, `${k} approved`);
    }
    const g = await until(async () => { const x = await prisma.collectiveGroup.findUnique({ where: { id: groupId } }); return x.status === 'active' && x; }, 'active');
    assert.equal(g.currentCycle, 1);
    assert.equal(await prisma.collectiveObligation.count({ where: { groupId } }), 9);
  });

  await step('everyone contributes from the group screen; the cycle-1 pot goes to the drawn recipient', async () => {
    const recipient = await prisma.collectiveMember.findFirst({ where: { groupId, position: 1 } });
    const before = (await prisma.wallet.findUnique({ where: { userId: recipient.userId } })).koriBalance;
    for (const k of ['org', 'a', 'b']) {
      await openGroup(P[k], name);
      await tap(P[k], 'Cotiser 1000 ₭', { exact: true });
      await until(async () => (await prisma.collectiveObligation.findFirst({ where: { groupId, cycle: 1, userId: ({ org, a, b })[k].id } })).status === 'paid', `${k} paid`);
    }
    const po = await until(() => prisma.collectivePayout.findUnique({ where: { groupId_cycle: { groupId, cycle: 1 } } }), 'payout');
    assert.equal(po.recipientId, recipient.userId);
    assert.equal(po.amountKori, 3000);
    assert.equal((await prisma.wallet.findUnique({ where: { userId: recipient.userId } })).koriBalance, before + 2000, 'net +2000 (paid 1000, received 3000)');
  });

  await step('a member proposes +3 days; another votes Oui → passes by majority', async () => {
    await openGroup(P.a, name);
    await tap(P.a, '+3 jours de délai', { exact: true });
    const v = await until(() => prisma.collectiveVote.findFirst({ where: { groupId, topic: 'extend_grace' } }), 'vote opened');
    await openGroup(P.b, name);
    await tap(P.b, 'Oui', { exact: true });
    await until(async () => (await prisma.collectiveVote.findUnique({ where: { id: v.id } })).status === 'passed', 'vote passed');
  });

  await step('a member opens a dispute; collective ops rules it in the console (no money moved by the ruling)', async () => {
    await openGroup(P.b, name);
    await P.b.getByLabel('Motif du litige').filter({ visible: true }).first().fill('Je pense que mon paiement du cycle 2 sera mal compté');
    await tap(P.b, 'Ouvrir un litige sur ce cycle');
    const d = await until(() => prisma.collectiveDispute.findFirst({ where: { groupId } }), 'dispute');
    const op = await operator(api, ['collective_ops']);
    const ops = await opsPage(op, 'ops', ['continue', 'Vérifié avec le membre : rien d’anormal']);
    await tap(ops, 'Collectif', { exact: true });
    await see(ops, 'Je pense que mon paiement');
    await ops.locator('#collective-disputes tr', { hasText: 'Je pense que mon paiement' }).getByText('Rule…').click();
    await until(async () => (await prisma.collectiveDispute.findUnique({ where: { id: d.id } })).status === 'dismissed', 'ruled');
  });

  await step('coop member confirms their capital line (records only, wallet untouched)', async () => {
    const coopOwner = await customer();
    const coop = await business(coopOwner.user);
    await prisma.business.update({ where: { id: coop.id }, data: { type: 'cooperative', name: 'Coop Jëm Kanam' } });
    const rec = await prisma.coopCapitalRecord.create({ data: { businessId: coop.id, memberUserId: a.id, kind: 'member_capital', direction: 'in', amountXof: 25_000, occurredOn: new Date(Date.now() - 86_400_000), recordedBy: coopOwner.id, reference: `COOPR-E2E-${crypto.randomBytes(3).toString('hex')}` } });
    const before = (await prisma.wallet.findUnique({ where: { userId: a.id } })).koriBalance;
    await toGroups(P.a);
    await tap(P.a, 'Mon registre coopérative');
    await see(P.a, 'Coop Jëm Kanam');
    await see(P.a, 'aucun dividende');
    await tap(P.a, 'Confirmer', { exact: true });
    await until(async () => (await prisma.coopCapitalRecord.findUnique({ where: { id: rec.id } })).memberConfirmedAt, 'confirmed');
    assert.equal((await prisma.wallet.findUnique({ where: { userId: a.id } })).koriBalance, before);
  });

  await step('no uncaught page errors in any session', async () => {
    assert.deepEqual(errors, []);
  });
  await assertInvariants(prisma);
  const ci = await checkCollectiveInvariants();
  assert.ok(ci.ok, JSON.stringify(ci.violations));
  log('INVARIANTS OK');
} finally {
  log(JSON.stringify({ passed: results.filter((r) => r[0] === 'PASS').length, failed: results.filter((r) => r[0] === 'FAIL').length }));
  await browser.close();
  web.close();
  await api.stop();
  await prisma.$disconnect();
}
