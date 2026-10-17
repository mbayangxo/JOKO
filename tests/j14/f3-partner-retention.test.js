/**
 * J14-F3 — partner record retention (decided policy):
 *   security / authorization audit ≥ 12 months (configurable only upwards; legal hold suspends purges),
 *   webhook delivery logs 30 days, financial records untouched, secrets never logged. Disabled by default.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { operator } from '../j3/helpers.js';

const R = await import('../../lib/integrations/partner-retention.js');
const DAY = 24 * 3600_000;
let api;
let maker;
let checker;
before(async () => {
  api = await startApiServer({ PARTNER_SCOPED_KEYS_ENABLED: 'true', PARTNER_EVENTS_ENABLED: 'true' });
  maker = await operator(api, ['integration_ops']);
  checker = await operator(api, ['risk']);
});
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  for (const k of ['PARTNER_AUDIT_RETENTION_ENABLED', 'PARTNER_AUDIT_LEGAL_HOLD', 'PARTNER_AUDIT_RETENTION_DAYS']) delete process.env[k];
});

const pid = () => `ret_${crypto.randomBytes(3).toString('hex')}`;
async function activeKey(p, scopes = ['partner.payment.read']) {
  const r = await maker.call('POST', `admin/partners/${p}/keys`, { reason: 'retention test fixture', environment: 'live', scopes });
  await checker.call('POST', `admin/approvals/${r.body.approval.id}/approve`, {});
  return r.body.key;
}
const auditRow = (partnerId, ageDays) => prisma.partnerAuditLog.create({ data: { partnerId, credential: 'db', routeKey: 'POST v1/x', statusCode: 200, createdAt: new Date(Date.now() - ageDays * DAY) } });

test('authorization refusals of an identified key are security audit records (scope, revoked) — no key, no hash, no body', async () => {
  const p = pid();
  const k = await activeKey(p);
  assert.equal((await api.client('POST', 'v1/messages/send', { headers: { 'x-api-key': k.secret }, body: { text: 'hello', to_phone: '+221770000001' } })).status, 403);
  await checker.call('POST', `admin/partner-keys/${k.id}/revoke`, { reason: `leaked: ${k.secret}` });
  assert.equal((await api.client('GET', 'v1/payments/x', { headers: { 'x-api-key': k.secret } })).status, 401);
  const rows = await prisma.partnerAuditLog.findMany({ where: { partnerId: p }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(rows.map((r) => [r.routeKey, r.statusCode, r.keyId]), [['POST v1/messages/send', 403, k.id], ['GET v1/payments/:reference', 401, k.id]]);
  const keyRow = await prisma.partnerApiKey.findUnique({ where: { id: k.id } });
  const audit = await prisma.adminAuditLog.findMany({ where: { targetId: k.id } });
  const blob = JSON.stringify({ rows, keyRow: keyRow.revokeReason, audit });
  assert.ok(!blob.includes(k.secret), 'a secret pasted into a reason is redacted');
  assert.ok(blob.includes('[redacted]'));
  assert.ok(!JSON.stringify(rows).includes('+221770000001') && !JSON.stringify(rows).includes('hello'), 'no request body');
});

test('disabled by default: nothing is purged', async () => {
  const p = pid();
  await auditRow(p, 800);
  assert.deepEqual(await R.purgePartnerAuditLogs(prisma), { enabled: false, purged: 0 });
  assert.equal(await prisma.partnerAuditLog.count({ where: { partnerId: p } }), 1);
});

test('security audit kept ≥ 12 months: 364 / 366 days; a shorter setting is raised to 365; a longer one is honoured', async () => {
  process.env.PARTNER_AUDIT_RETENTION_ENABLED = 'true';
  const p = pid();
  const young = await auditRow(p, 364);
  const old = await auditRow(p, 366);
  process.env.PARTNER_AUDIT_RETENTION_DAYS = '30'; // cannot shorten below 12 months
  assert.equal(R.securityAuditRetentionDays(), 365);
  await R.purgePartnerAuditLogs(prisma);
  assert.ok(await prisma.partnerAuditLog.findUnique({ where: { id: young.id } }), '364 days kept');
  assert.equal(await prisma.partnerAuditLog.findUnique({ where: { id: old.id } }), null, '366 days purged');
  process.env.PARTNER_AUDIT_RETENTION_DAYS = '730';
  const twoYearsMinus = await auditRow(p, 700);
  await R.purgePartnerAuditLogs(prisma);
  assert.ok(await prisma.partnerAuditLog.findUnique({ where: { id: twoYearsMinus.id } }), 'a longer retention is honoured');
});

test('legal hold suspends every purge (audit and delivery logs)', async () => {
  process.env.PARTNER_AUDIT_RETENTION_ENABLED = 'true';
  process.env.PARTNER_AUDIT_LEGAL_HOLD = 'true';
  const p = pid();
  const old = await auditRow(p, 900);
  const r = await R.runPartnerRetention(prisma);
  assert.equal(r.legalHold, true);
  assert.ok(await prisma.partnerAuditLog.findUnique({ where: { id: old.id } }));
});

test('one retention pass: delivery logs 30 days, security audit 12 months; events, payments, journal and admin audit untouched', async () => {
  process.env.PARTNER_AUDIT_RETENTION_ENABLED = 'true';
  const sub = await prisma.partnerEventSubscription.create({ data: { partnerId: pid(), url: 'https://example.test/h', eventTypesJson: '["order.paid"]', secretEnc: 'x' } });
  const ev = await prisma.commerceEvent.create({ data: { type: 'order.paid', aggregateType: 'order', aggregateId: `o_${crypto.randomBytes(3).toString('hex')}`, payloadJson: '{}', createdAt: new Date(Date.now() - 400 * DAY) } });
  const oldDelivery = await prisma.partnerEventDelivery.create({ data: { subscriptionId: sub.id, eventId: ev.id, status: 'delivered', createdAt: new Date(Date.now() - 31 * DAY) } });
  const ev2 = await prisma.commerceEvent.create({ data: { type: 'order.paid', aggregateType: 'order', aggregateId: `o_${crypto.randomBytes(3).toString('hex')}`, payloadJson: '{}' } });
  const fresh = await prisma.partnerEventDelivery.create({ data: { subscriptionId: sub.id, eventId: ev2.id, status: 'delivered', createdAt: new Date(Date.now() - 29 * DAY) } });
  const p = pid();
  const oldAudit = await auditRow(p, 400);
  const adminRow = await prisma.adminAuditLog.create({ data: { adminUserId: maker.id, action: 'partner_key.issue', targetType: 'partner_api_key', targetId: 'x', detailJson: '{}', createdAt: new Date(Date.now() - 900 * DAY) } });
  const [journal0, payments0] = await Promise.all([prisma.journalEntry.count(), prisma.partnerPayment.count()]);
  const out = await R.runPartnerRetention(prisma);
  assert.equal(out.enabled, true);
  assert.equal(await prisma.partnerEventDelivery.findUnique({ where: { id: oldDelivery.id } }), null, '31-day delivery log purged');
  assert.ok(await prisma.partnerEventDelivery.findUnique({ where: { id: fresh.id } }), '29-day delivery log kept');
  assert.equal(await prisma.partnerAuditLog.findUnique({ where: { id: oldAudit.id } }), null);
  assert.ok(await prisma.commerceEvent.findUnique({ where: { id: ev.id } }), 'the event itself is never purged here');
  assert.ok(await prisma.adminAuditLog.findUnique({ where: { id: adminRow.id } }), 'admin / financial audit untouched');
  assert.deepEqual([await prisma.journalEntry.count(), await prisma.partnerPayment.count()], [journal0, payments0]);
});

test('redactSecrets: partner keys, webhook secrets, bearer tokens and raw hex keys never survive into a log', () => {
  const k = `jk_live_${crypto.randomBytes(24).toString('base64url')}`;
  const w = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
  const hex = crypto.randomBytes(32).toString('hex');
  const out = R.redactSecrets(`key ${k} secret ${w} auth Bearer ${crypto.randomBytes(24).toString('base64url')} hash ${hex} ok`);
  assert.ok(!out.includes(k) && !out.includes(w) && !out.includes(hex) && !/Bearer\s+\S{16,}/.test(out));
  assert.ok(out.endsWith('ok'));
});
