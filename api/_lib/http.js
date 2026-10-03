import '../../lib/env-bootstrap.js';
import { getUserIdFromRequest } from './auth.js';
import { logApiCall } from '../../lib/api-audit.js';
import { databaseConfigured } from '../../lib/prisma.js';
import { RateLimitError, SecurityBlockError, enforceRateLimit } from '../../lib/rate-limit.js';
import { initServerSentry, captureServerError } from '../../lib/sentry-server.js';
import { safeError } from '../../lib/log-redact.js';

initServerSentry();

export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Step-Up-Token, X-Admin-Key, X-Api-Key, X-Device-Id, X-Device-Name, Idempotency-Key',
  );
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function enforceHttps(req, res) {
  if (process.env.NODE_ENV !== 'production') return true;
  const proto = req.headers['x-forwarded-proto'];
  if (proto && proto !== 'https') {
    res.status(403).json({ error: 'HTTPS required' });
    return false;
  }
  return true;
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    return JSON.parse(req.body);
  }
  return {};
}

export function validationError(res, error) {
  return res.status(400).json({ error: 'Validation failed', details: error.flatten() });
}

export function createHandler({ methods, auth = false, handler, skipRateLimit = false }) {
  const allowed = Array.isArray(methods) ? methods : [methods];

  return async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    if (!allowed.includes(req.method)) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    if (!enforceHttps(req, res)) return;

    let userId = null;

    try {
      if (auth) {
        userId = await getUserIdFromRequest(req);
        if (!userId) {
          const authError = req._authError;
          if (authError?.code === 'account_locked') {
            res.status(423).json({
              error: authError.message,
              code: 'account_locked',
              unlock: 'cni_required',
            });
            return;
          }
          if (authError?.code === 'account_frozen') {
            res.status(423).json({
              error: authError.message,
              code: 'account_frozen',
            });
            return;
          }
          if (authError?.code === 'session_inactive') {
            res.status(401).json({ error: authError.message, code: 'session_inactive' });
            return;
          }
          res.status(401).json({ error: 'Invalid or expired token' });
          return;
        }
        req.userId = userId;

        if (!skipRateLimit) {
          try {
            await enforceRateLimit(userId);
          } catch (error) {
            if (error instanceof RateLimitError || error instanceof SecurityBlockError) {
              res.status(error.status).json({ error: error.message, code: error.code });
              return;
            }
            throw error;
          }
        }
      }

      await handler(req, res);
    } catch (error) {
      console.error(safeError(error));
      captureServerError(error, { path: req.url, method: req.method, userId });
      if (!res.headersSent) {
        const prismaInit =
          error.name === 'PrismaClientInitializationError' ||
          error.code === 'P1001' ||
          error.message?.includes('DATABASE_URL');
        if (prismaInit) {
          res.status(503).json({
            error: databaseConfigured()
              ? 'Database temporarily unavailable'
              : 'Server not configured — DATABASE_URL missing',
            code: 'db_unavailable',
          });
          return;
        }
        res.status(500).json({ error: 'Internal server error' });
      }
    } finally {
      await logApiCall(req, res, userId);
    }
  };
}

export function routeParam(req, name) {
  const value = req.query?.[name];
  return Array.isArray(value) ? value[0] : value;
}
