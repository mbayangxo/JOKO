/**
 * J14-S1 — signed event delivery from the CommerceEvent outbox to linked partners (D-J14-2).
 *
 * DISABLED unless PARTNER_EVENTS_ENABLED=true (nothing is fanned out, delivered or subscribable otherwise).
 *
 * What may leave Jokko (D-J14-2 minimal allowlist): order, payment, settlement and fulfilment events of a
 * business that is EXPLICITLY LINKED to the partner (active ExternalLink system=<partnerId>, objectType=business)
 * — never another business, never an unlinked or revoked one. Payloads carry ids and amounts only (per-type
 * field allowlist below); never names, phones, addresses or notes.
 *
 * Signature (receiver verifies; the Partner API doc shows how):
 *   X-Jokko-Event-Id:        <event id>                 (stable across retries — dedupe on it)
 *   X-Jokko-Event-Timestamp: <unix seconds>
 *   X-Jokko-Event-Signature: v1=<hex HMAC-SHA256(secret, `${timestamp}.${eventId}.${body}`)>
 * A receiver rejects a timestamp older than REPLAY_WINDOW_S (replay protection) and an id it already processed.
 *
 * Delivery: at-least-once per (subscription, event); retries with exponential backoff; after MAX_ATTEMPTS the
 * delivery is "dead" (dead-letter) until an operator replays it. Delivery never feeds back into money.
 * Retention: delivery rows are operational logs purged after 30 days; events and financial audit records keep
 * their own retention.
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { decryptAtRest, encryptAtRest } from '../field-crypto.js';

export const REPLAY_WINDOW_S = 300;
export const MAX_ATTEMPTS = 8;
export const BACKOFF_S = [0, 30, 120, 600, 1800, 3600, 3 * 3600, 6 * 3600];
export const DELIVERY_LOG_RETENTION_DAYS = 30;
export const ROTATION_OVERLAP_MS = 24 * 3600_000;
const SEND_TIMEOUT_MS = 10_000;
/** A claimed ("sending") row whose worker died is re-claimable after this lease (at-least-once, never lost). */
export const CLAIM_LEASE_MS = 60_000;
/**
 * The fan-out cursor trails "now" by this much: an event row whose transaction commits late (createdAt is set
 * at insert, visibility at commit) is still inside the re-scan window. Re-scanning is harmless (unique index).
 */
export const FANOUT_LAG_MS = 120_000;

/** type → payload fields that may leave Jokko (ids and amounts only). */
export const EVENT_ALLOWLIST = {
  'order.placed': ['totalKori', 'channel'],
  'order.paid': ['totalKori', 'channel'],
  'order.accepted': ['to'],
  'order.ready_for_fulfillment': ['to'],
  'order.out_for_delivery': ['to'],
  'order.delivered': ['to'],
  'order.completed': ['by'],
  'order.cancelled': ['by', 'refundedKori'],
  'order.refunded': ['refundedKori'],
  'payment.recorded': ['method', 'settlement', 'amountKori'],
  'settlement.completed': ['amountKori', 'partnerReference'],
  'settlement.held': ['amountKori', 'partnerReference'],
  'fulfillment.requested': ['mode'],
  'shipment.created': ['requestId'],
};

export class PartnerEventsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const partnerEventsEnabled = () => process.env.PARTNER_EVENTS_ENABLED === 'true';
function requireEnabled() {
  if (!partnerEventsEnabled()) throw new PartnerEventsError('disabled', 'Partner event delivery is not enabled', 403);
}

/** https only (http://127.0.0.1|localhost allowed outside production, for local tests); no credentials in URL. */
export function validateWebhookUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new PartnerEventsError('invalid_url', 'url must be an absolute URL');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.username || u.password) throw new PartnerEventsError('invalid_url', 'url must not contain credentials');
  if (u.protocol === 'https:') {
    if (local && process.env.NODE_ENV === 'production' && process.env.PARTNER_EVENTS_ALLOW_LOCAL !== 'true') {
      throw new PartnerEventsError('invalid_url', 'url must be public');
    }
    return u.toString();
  }
  if (u.protocol === 'http:' && local && process.env.PARTNER_EVENTS_ALLOW_LOCAL === 'true') return u.toString();
  throw new PartnerEventsError('invalid_url', 'url must use https');
}

const newSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;

export function signEvent(secret, { timestamp, eventId, body }) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${eventId}.${body}`).digest('hex');
}

/**
 * Receiver-side verification (also used by tests and documented for partners). The header may carry several
 * `v1=` signatures (comma-separated) during a secret-rotation overlap; any one valid signature is enough.
 */
export function verifyEventSignature(secret, { timestamp, eventId, body, signature, now = Date.now() }) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > REPLAY_WINDOW_S) return false;
  const expected = Buffer.from(`v1=${signEvent(secret, { timestamp, eventId, body })}`);
  return String(signature ?? '').split(',').map((x) => x.trim()).some((sig) => {
    const got = Buffer.from(sig);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

function subscriptionShape(s, { secret } = {}) {
  return {
    id: s.id,
    url: s.url,
    event_types: JSON.parse(s.eventTypesJson),
    status: s.status,
    created_at: s.createdAt.toISOString(),
    rotated_at: s.rotatedAt?.toISOString() ?? null,
    ...(secret ? { secret, secret_shown_once: true } : {}),
  };
}

function normalizeTypes(types) {
  const list = Array.isArray(types) && types.length ? types : Object.keys(EVENT_ALLOWLIST);
  const bad = list.filter((t) => !EVENT_ALLOWLIST[t]);
  if (bad.length) throw new PartnerEventsError('event_type_not_allowed', `Not deliverable: ${bad.join(', ')}`);
  return [...new Set(list)].sort();
}

export async function createSubscription(partnerId, { url, eventTypes }, db = prisma) {
  requireEnabled();
  const secret = newSecret();
  const s = await db.partnerEventSubscription.create({
    data: { partnerId, url: validateWebhookUrl(url), eventTypesJson: JSON.stringify(normalizeTypes(eventTypes)), secretEnc: encryptAtRest(secret) },
  });
  return subscriptionShape(s, { secret });
}

export async function listSubscriptions(partnerId, db = prisma) {
  requireEnabled();
  const rows = await db.partnerEventSubscription.findMany({ where: { partnerId }, orderBy: { createdAt: 'asc' } });
  return rows.map((s) => subscriptionShape(s));
}

async function ownSubscription(db, partnerId, id) {
  const s = await db.partnerEventSubscription.findUnique({ where: { id: String(id) } });
  // Another partner's subscription reads exactly like a missing one.
  if (!s || s.partnerId !== partnerId) throw new PartnerEventsError('not_found', 'Subscription not found', 404);
  return s;
}

export async function rotateSubscriptionSecret(partnerId, id, db = prisma) {
  requireEnabled();
  const s = await ownSubscription(db, partnerId, id);
  if (s.status !== 'active') throw new PartnerEventsError('disabled_subscription', 'Subscription is disabled', 409);
  const secret = newSecret();
  const updated = await db.partnerEventSubscription.update({
    where: { id: s.id },
    data: { secretEnc: encryptAtRest(secret), previousSecretEnc: s.secretEnc, previousValidUntil: new Date(Date.now() + ROTATION_OVERLAP_MS), rotatedAt: new Date() },
  });
  return subscriptionShape(updated, { secret });
}

export async function disableSubscription(partnerId, id, db = prisma) {
  requireEnabled();
  const s = await ownSubscription(db, partnerId, id);
  const updated = await db.partnerEventSubscription.update({ where: { id: s.id }, data: { status: 'disabled' } });
  return subscriptionShape(updated);
}

/** The partner's external id for a business, only while the link is ACTIVE. */
async function linkedExternalBusinessId(db, partnerId, businessId) {
  if (!businessId) return null;
  const link = await db.externalLink.findFirst({ where: { system: partnerId, objectType: 'business', jokkoId: businessId, status: 'active' } });
  return link?.externalId ?? null;
}

/**
 * Build the outbound body for one event to one partner, or null when it must not leave Jokko (type not
 * allowlisted / not subscribed, business not linked to THIS partner).
 */
export async function buildEventBody(db, partnerId, event, subscribedTypes) {
  const fields = EVENT_ALLOWLIST[event.type];
  if (!fields || !subscribedTypes.includes(event.type)) return null;
  const externalBusinessId = await linkedExternalBusinessId(db, partnerId, event.businessId);
  if (!externalBusinessId) return null;
  let payload = {};
  try {
    payload = JSON.parse(event.payloadJson ?? '{}');
  } catch {
    payload = {};
  }
  const data = {};
  for (const f of fields) if (payload[f] !== undefined && (typeof payload[f] !== 'object' || payload[f] === null)) data[f] = payload[f];
  const externalAggregate = await db.externalLink.findFirst({ where: { system: partnerId, objectType: event.aggregateType, jokkoId: event.aggregateId, status: 'active' }, select: { externalId: true } });
  return JSON.stringify({
    id: event.id,
    type: event.type,
    created_at: event.createdAt.toISOString(),
    business: { external_id: externalBusinessId },
    object: { type: event.aggregateType, jokko_id: event.aggregateId, external_id: externalAggregate?.externalId ?? null },
    data,
    api_version: '2026-10-j14',
  });
}

/**
 * Fan-out: one delivery row per (active subscription, deliverable event) for events created since the
 * subscription was created. Idempotent (unique per subscription+event); safe to run concurrently.
 */
export async function fanOutEvents(db = prisma, { batch = 500, now = Date.now() } = {}) {
  if (!partnerEventsEnabled()) return { enabled: false, created: 0 };
  const subs = await db.partnerEventSubscription.findMany({ where: { status: 'active' } });
  let created = 0;
  for (const s of subs) {
    const types = JSON.parse(s.eventTypesJson);
    // Cursor with an inclusive bound (events sharing the same millisecond are re-considered; the unique
    // (subscription, event) index makes that harmless).
    const since = s.fannedThrough ?? s.createdAt;
    const events = await db.commerceEvent.findMany({
      where: { createdAt: { gte: since }, type: { in: types }, businessId: { not: null } },
      orderBy: { createdAt: 'asc' },
      take: batch,
    });
    for (const e of events) {
      if (!(await buildEventBody(db, s.partnerId, e, types))) continue; // not for this partner
      const r = await db.partnerEventDelivery.createMany({ data: [{ subscriptionId: s.id, eventId: e.id, nextAttemptAt: new Date(now) }], skipDuplicates: true }); // one clock: the worker's
      created += r.count;
    }
    if (events.length) {
      const last = events[events.length - 1].createdAt.getTime();
      const next = new Date(Math.max(since.getTime(), Math.min(last, now - FANOUT_LAG_MS)));
      if (next.getTime() !== since.getTime()) await db.partnerEventSubscription.update({ where: { id: s.id }, data: { fannedThrough: next } });
    }
  }
  return { enabled: true, created };
}

async function postSigned(url, { secrets, eventId, body, now = Date.now(), fetchImpl = fetch }) {
  const timestamp = String(Math.floor(now / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual', // a redirect is a failed delivery, never followed to another host
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Jokko-PartnerEvents/1.0',
        'X-Jokko-Event-Id': eventId,
        'X-Jokko-Event-Timestamp': timestamp,
        'X-Jokko-Event-Signature': secrets.map((sec) => `v1=${signEvent(sec, { timestamp, eventId, body })}`).join(','),
      },
      body,
      signal: controller.signal,
    });
    return { ok: res.status >= 200 && res.status < 300, statusCode: res.status };
  } catch (err) {
    return { ok: false, statusCode: 0, error: String(err?.message ?? err).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver due deliveries. Each row is CLAIMED atomically (pending → sending, conditional update), so two workers
 * never send the same delivery at the same time. Re-checks the link at send time: a business unlinked after the
 * event was fanned out is never sent (the row is marked dead with reason "unlinked").
 */
export async function deliverDue(db = prisma, { limit = 50, now = Date.now(), fetchImpl } = {}) {
  if (!partnerEventsEnabled()) return { enabled: false, sent: 0 };
  // Due = pending and due, or a "sending" claim whose lease expired (its worker died mid-send).
  const due = await db.partnerEventDelivery.findMany({ where: { status: { in: ['pending', 'sending'] }, nextAttemptAt: { lte: new Date(now) } }, orderBy: { nextAttemptAt: 'asc' }, take: limit });
  const out = { enabled: true, sent: 0, delivered: 0, retried: 0, dead: 0, skipped: 0 };
  for (const d of due) {
    // Compare-and-set on (status, nextAttemptAt): exactly one worker wins each claim, including a lease takeover.
    const claim = await db.partnerEventDelivery.updateMany({
      where: { id: d.id, status: d.status, nextAttemptAt: d.nextAttemptAt },
      data: { status: 'sending', nextAttemptAt: new Date(now + CLAIM_LEASE_MS) },
    });
    if (claim.count !== 1) {
      out.skipped += 1;
      continue;
    }
    const sub = await db.partnerEventSubscription.findUnique({ where: { id: d.subscriptionId } });
    const event = await db.commerceEvent.findUnique({ where: { id: d.eventId } });
    const body = sub?.status === 'active' && event ? await buildEventBody(db, sub.partnerId, event, JSON.parse(sub.eventTypesJson)) : null;
    if (!body) {
      await db.partnerEventDelivery.update({ where: { id: d.id }, data: { status: 'dead', lastError: sub?.status !== 'active' ? 'subscription_disabled' : 'unlinked' } });
      out.dead += 1;
      continue;
    }
    const secrets = [decryptAtRest(sub.secretEnc)];
    if (sub.previousSecretEnc && sub.previousValidUntil && sub.previousValidUntil.getTime() > now) secrets.push(decryptAtRest(sub.previousSecretEnc));
    const r = await postSigned(sub.url, { secrets, eventId: d.eventId, body, now, fetchImpl });
    out.sent += 1;
    const attempts = d.attempts + 1;
    if (r.ok) {
      await db.partnerEventDelivery.update({ where: { id: d.id }, data: { status: 'delivered', attempts, lastStatusCode: r.statusCode, lastError: null, deliveredAt: new Date(now) } });
      out.delivered += 1;
    } else if (attempts >= MAX_ATTEMPTS) {
      await db.partnerEventDelivery.update({ where: { id: d.id }, data: { status: 'dead', attempts, lastStatusCode: r.statusCode, lastError: r.error ?? `http_${r.statusCode}` } });
      out.dead += 1;
    } else {
      const wait = BACKOFF_S[Math.min(attempts, BACKOFF_S.length - 1)] * 1000;
      await db.partnerEventDelivery.update({ where: { id: d.id }, data: { status: 'pending', attempts, lastStatusCode: r.statusCode, lastError: r.error ?? `http_${r.statusCode}`, nextAttemptAt: new Date(now + wait) } });
      out.retried += 1;
    }
  }
  return out;
}

/** Operator replay of a dead (or delivered) delivery: re-queued now, same event id (receivers dedupe on it). */
export async function replayDelivery(adminId, deliveryId, { reason } = {}, db = prisma) {
  requireEnabled();
  if (!reason || String(reason).trim().length < 5) throw new PartnerEventsError('reason_required', 'A reason (≥ 5 chars) is required');
  const d = await db.partnerEventDelivery.findUnique({ where: { id: String(deliveryId) } });
  if (!d) throw new PartnerEventsError('not_found', 'Delivery not found', 404);
  if (!['dead', 'delivered'].includes(d.status)) throw new PartnerEventsError('not_replayable', `Delivery is ${d.status}`, 409);
  const updated = await db.partnerEventDelivery.update({ where: { id: d.id }, data: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null } });
  await db.adminAuditLog.create({ data: { adminUserId: adminId, action: 'partner_events.replay', targetType: 'partner_event_delivery', targetId: d.id, detailJson: JSON.stringify({ reason: String(reason).slice(0, 300), eventId: d.eventId, previousStatus: d.status }) } });
  return { id: updated.id, status: updated.status, event_id: updated.eventId };
}

/** 30-day operational log retention (D-J14-2). Events and financial audit records are NOT touched. */
export async function purgeDeliveryLogs(db = prisma, { now = Date.now() } = {}) {
  const cutoff = new Date(now - DELIVERY_LOG_RETENTION_DAYS * 24 * 3600_000);
  const r = await db.partnerEventDelivery.deleteMany({ where: { createdAt: { lt: cutoff }, status: { in: ['delivered', 'dead'] } } });
  return { purged: r.count };
}

/** One cron pass (dormant unless enabled): fan out, deliver, purge. */
export async function runPartnerEventsCron(db = prisma) {
  if (!partnerEventsEnabled()) return { enabled: false };
  const fan = await fanOutEvents(db);
  const sent = await deliverDue(db);
  const purge = await purgeDeliveryLogs(db);
  return { enabled: true, fan, sent, purge };
}
