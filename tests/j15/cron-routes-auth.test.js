/**
 * J15 security review S-3: every scheduled-job route must refuse callers without the CRON_SECRET bearer, in the
 * production runtime. Cron routes are auth:false and the policy layer leaves the secret to the handler, so a handler
 * that forgets assertCronAuth is an open job trigger. (The review found an unused, unauthenticated duplicate
 * cronAgentCashSweep export in lib/agents/admin-handlers.js; the routed one in lib/cron/http-handlers.js is
 * protected.) Enumerated from the route policy, so a cron added later is covered automatically. Mutation-checked:
 * stripping cronHandler from the routed sweep is caught.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApiServer, BASE_ENV } from '../helpers/http-harness.js';
import { ROUTE_POLICY } from '../../lib/authz/route-policy.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); });

const cronRoutes = Object.entries(ROUTE_POLICY).filter(([, p]) => p.actor === 'cron').map(([k]) => k);

test(`all ${cronRoutes.length} cron routes refuse a missing or wrong secret and accept the right one only`, async () => {
  assert.ok(cronRoutes.length >= 30, `found ${cronRoutes.length}`);
  const open = [];
  for (const key of cronRoutes) {
    const [method, path] = key.split(' ');
    for (const headers of [{}, { authorization: 'Bearer wrong-secret' }]) {
      const r = await api.client(method, path, { headers });
      if (r.status !== 401) open.push(`${key} ${headers.authorization ? 'wrong' : 'none'} → ${r.status}`);
    }
  }
  assert.deepEqual(open, []);
  const ok = await api.client('POST', 'cron/agent-cash-sweep', { headers: { authorization: `Bearer ${BASE_ENV.CRON_SECRET}` } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});
