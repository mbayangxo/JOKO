import crypto from 'crypto';
import { prisma } from './prisma.js';

/**
 * Generic Idempotency-Key support for money-moving API routes.
 *
 * A client sends the same `Idempotency-Key` for every retry of ONE user action
 * (double tap, timeout + retry, flaky network). The first request executes;
 * concurrent duplicates get 409 while it runs; later duplicates replay the
 * stored response without executing again. Reusing a key with a different
 * body is refused (422). 5xx outcomes are not stored, so a genuine retry can run.
 */
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

function fingerprint(req) {
  return crypto.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');
}

export async function withIdempotency(req, res, { userId, routeKey }, run) {
  const raw = req.headers?.['idempotency-key'];
  if (typeof raw !== 'string' || !KEY_RE.test(raw.trim())) return run();

  const key = `api:${userId}:${routeKey}:${raw.trim()}`;
  const fp = fingerprint(req);

  try {
    await prisma.apiIdempotency.create({
      data: { key, provider: 'api', userId, operation: routeKey, reference: fp, status: 'in_progress' },
    });
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    const existing = await prisma.apiIdempotency.findUnique({ where: { key } });
    if (existing && existing.reference !== fp) {
      res.status(422).json({ error: 'Idempotency-Key réutilisée avec une autre requête', code: 'idempotency_key_reuse' });
      return;
    }
    if (existing?.responseJson) {
      const stored = JSON.parse(existing.responseJson);
      res.setHeader?.('Idempotent-Replay', 'true');
      res.status(stored.status).json(stored.body);
      return;
    }
    res.status(409).json({ error: 'Cette opération est déjà en cours', code: 'idempotency_in_progress' });
    return;
  }

  let captured = null;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    captured = { status: res.statusCode ?? 200, body };
    return originalJson(body);
  };

  try {
    await run();
  } finally {
    res.json = originalJson;
    if (captured && captured.status < 500) {
      await prisma.apiIdempotency
        .update({ where: { key }, data: { status: 'done', responseJson: JSON.stringify(captured) } })
        .catch((e) => console.error('[idempotency] store failed', e?.message));
    } else {
      await prisma.apiIdempotency.delete({ where: { key } }).catch(() => {});
    }
  }
}
