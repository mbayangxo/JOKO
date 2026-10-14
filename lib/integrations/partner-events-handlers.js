/**
 * J14-S1 HTTP handlers: partner subscription management (partner key), operator inspection + replay (admin
 * permission, audited), and the dormant cron pass. Everything answers 403 `disabled` unless
 * PARTNER_EVENTS_ENABLED=true.
 */
import { prisma } from '../prisma.js';
import { assertCronAuth } from '../cron-auth.js';
import {
  PartnerEventsError, createSubscription, disableSubscription, listSubscriptions, partnerEventsEnabled,
  replayDelivery, rotateSubscriptionSecret, runPartnerEventsCron,
} from './partner-events.js';

function fail(res, error) {
  if (error instanceof PartnerEventsError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

async function partner(req, res) {
  const { requirePartner } = await import('../partner-handlers.js');
  return requirePartner(req, res);
}

export async function partnerEventSubscriptionsCreate(req, res) {
  if (!(await partner(req, res))) return;
  try {
    const b = req.body ?? {};
    res.status(201).json(await createSubscription(req.partnerId, { url: b.url, eventTypes: b.event_types }));
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}

export async function partnerEventSubscriptionsList(req, res) {
  if (!(await partner(req, res))) return;
  try {
    res.json({ subscriptions: await listSubscriptions(req.partnerId) });
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}

export async function partnerEventSubscriptionRotate(req, res) {
  if (!(await partner(req, res))) return;
  try {
    res.json(await rotateSubscriptionSecret(req.partnerId, req.query.id));
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}

export async function partnerEventSubscriptionDisable(req, res) {
  if (!(await partner(req, res))) return;
  try {
    res.json(await disableSubscription(req.partnerId, req.query.id));
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}

/** The partner's OWN delivery log (ids, statuses, attempts — no payloads, no other partner's rows). */
export async function partnerEventDeliveriesList(req, res) {
  if (!(await partner(req, res))) return;
  if (!partnerEventsEnabled()) return res.status(403).json({ error: 'Partner event delivery is not enabled', code: 'disabled' });
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const rows = await prisma.partnerEventDelivery.findMany({
    where: { subscription: { partnerId: req.partnerId }, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ deliveries: rows.map((d) => ({ id: d.id, subscription_id: d.subscriptionId, event_id: d.eventId, status: d.status, attempts: d.attempts, last_status_code: d.lastStatusCode, created_at: d.createdAt.toISOString(), delivered_at: d.deliveredAt?.toISOString() ?? null })) });
}

export async function adminPartnerEventDeliveries(req, res) {
  if (!partnerEventsEnabled()) return res.status(403).json({ error: 'Partner event delivery is not enabled', code: 'disabled' });
  const status = typeof req.query.status === 'string' ? req.query.status : 'dead';
  const rows = await prisma.partnerEventDelivery.findMany({ where: { status }, orderBy: { updatedAt: 'desc' }, take: 200, include: { subscription: { select: { partnerId: true } } } });
  res.json({ deliveries: rows.map((d) => ({ id: d.id, partner: d.subscription.partnerId, event_id: d.eventId, status: d.status, attempts: d.attempts, last_status_code: d.lastStatusCode, last_error: d.lastError, updated_at: d.updatedAt.toISOString() })) });
}

export async function adminPartnerEventReplay(req, res) {
  try {
    res.json(await replayDelivery(req.adminId, req.query.id, { reason: req.body?.reason }));
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}

export async function cronPartnerEvents(req, res) {
  if (!assertCronAuth(req, res)) return;
  res.json(await runPartnerEventsCron());
}

/** J14-F3: retention pass (security audit ≥ 12 months, delivery logs 30 days). Dormant unless PARTNER_AUDIT_RETENTION_ENABLED. */
export async function cronPartnerRetention(req, res) {
  if (!assertCronAuth(req, res)) return;
  const { runPartnerRetention } = await import('./partner-retention.js');
  res.json(await runPartnerRetention());
}
