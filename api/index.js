import { createHandler } from './_lib/http.js';
import { apiPathSegments } from './_lib/path.js';
import { dispatchApi, prepareApiBody } from '../lib/api-router.js';

export const config = { api: { bodyParser: false } };

/** Single Vercel entry — all /api/* traffic is rewritten here (see vercel.json). */
export default createHandler({
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  auth: false,
  skipRateLimit: true,
  handler: async (req, res) => {
    await prepareApiBody(req);
    if (req.bodyTooLarge) return res.status(413).json({ error: 'Requête trop volumineuse', code: 'payload_too_large' });
    return dispatchApi(req, res, apiPathSegments(req));
  },
});
