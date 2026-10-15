/** J15 security review S-2: cron bearer secret compared in constant time; behaviour unchanged. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertCronAuth } from '../../lib/cron-auth.js';

const saved = { NODE_ENV: process.env.NODE_ENV, CRON_SECRET: process.env.CRON_SECRET };
after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
const res = () => { const r = { code: 200, status(c) { r.code = c; return r; }, json() { return r; } }; return r; };
const call = (authorization) => { const r = res(); const ok = assertCronAuth({ headers: authorization === undefined ? {} : { authorization } }, r); return { ok, code: r.code }; };

test('production: right secret passes; wrong / missing / prefix / longer secrets are refused; no secret → 503', () => {
  process.env.NODE_ENV = 'production';
  process.env.CRON_SECRET = 'lab-cron-secret-0123';
  assert.deepEqual(call('Bearer lab-cron-secret-0123'), { ok: true, code: 200 });
  for (const h of ['Bearer lab-cron-secret-012', 'Bearer lab-cron-secret-01234', 'lab-cron-secret-0123', '', undefined]) assert.equal(call(h).code, 401, String(h));
  delete process.env.CRON_SECRET;
  assert.equal(call('Bearer anything').code, 503);
});

test('the comparison is constant-time (no plain string comparison left)', () => {
  const src = fs.readFileSync(new URL('../../lib/cron-auth.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /authorization !== `Bearer/);
  assert.match(src, /timingSafeEqual/);
});
