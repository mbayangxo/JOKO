import { createHash, timingSafeEqual } from 'node:crypto';

/** Shared auth for scheduled jobs (Vercel Cron, Supabase pg_cron, Edge Functions). */

// J15 security review (S-2): constant-time comparison of the bearer secret (was a plain !==).
const digest = (v) => createHash('sha256').update(String(v ?? '')).digest();
const bearerMatches = (header, secret) => timingSafeEqual(digest(header), digest(`Bearer ${secret}`));

export function assertCronAuth(req, res) {
  const secret = process.env.CRON_SECRET;

  if (process.env.NODE_ENV === 'production') {
    if (!secret) {
      res.status(503).json({ error: 'CRON_SECRET required in production' });
      return false;
    }
    if (!bearerMatches(req.headers.authorization, secret)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  if (secret && !bearerMatches(req.headers.authorization, secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export function cronApiBaseUrl() {
  return (
    process.env.CRON_API_URL?.replace(/\/$/, '') ??
    process.env.VERCEL_URL?.replace(/\/$/, '') ??
    'http://localhost:3000'
  );
}
