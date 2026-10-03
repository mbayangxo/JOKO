import { logApiCall } from '../../lib/api-audit.js';
import { getAdminFromBearer, legacyAdminKeyValid } from '../../lib/admin-auth.js';
import { initServerSentry, captureServerError } from '../../lib/sentry-server.js';
import { setCors } from './http.js';
import { safeError } from '../../lib/log-redact.js';

initServerSentry();

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

export function createAdminHandler({ methods, auth = true, handler }) {
  const allowed = Array.isArray(methods) ? methods : [methods];

  return async (req, res) => {
    setCors(res);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    if (!allowed.includes(req.method)) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    if (!enforceHttps(req, res)) return;

    let adminId = null;

    try {
      if (auth) {
        const session = await getAdminFromBearer(req.headers.authorization);
        if (session) {
          adminId = session.adminId;
          req.adminId = adminId;
          req.admin = session.admin;
        } else if (!legacyAdminKeyValid(req)) {
          res.status(401).json({ error: 'Admin authorization required' });
          return;
        } else {
          req.adminId = 'legacy-api-key';
        }
      }

      await handler(req, res);
    } catch (error) {
      console.error('[admin]', safeError(error));
      captureServerError(error, { path: req.url, method: req.method, adminId });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    } finally {
      await logApiCall(req, res, adminId);
    }
  };
}

export function routeParam(req, name) {
  const value = req.query?.[name];
  return Array.isArray(value) ? value[0] : value;
}
