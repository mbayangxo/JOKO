/**
 * Authorization-boundary gate (J8.0, after the delivery-dispute P0).
 *
 * The generic sweeps send one shared body to every route. On a route with a
 * strict schema that body fails validation (400) BEFORE the handler reaches
 * its authorization decision — and a 400 was being counted as "refused". That
 * is how `POST deliveries/:id/dispute/resolve` (any user could rule on any
 * dispute) passed every sweep.
 *
 * This gate:
 *  1. STATIC — every critical route (money-moving user route with an object
 *     id, every mutating operator route) must have a semantically VALID
 *     adversarial body here, or the test fails.
 *  2. DYNAMIC — an unrelated attacker calls each critical route on someone
 *     else's object with that valid body, and every result is classified:
 *       AUTHORIZATION_REACHED_AND_REFUSED        401 / 403 / 404 / 410 / 423
 *       VALIDATION_REFUSED_BEFORE_AUTHORIZATION  400 "Validation failed"          → FINDING
 *       BUSINESS_RULE_REFUSED                    other 400 / 409 (not proof)      → FINDING unless public by design
 *       RATE_LIMITED                             429 (inconclusive)               → FINDING
 *       ACCEPTED                                 2xx                              → FINDING unless public by design
 *     Operator routes are called by an operator WITHOUT the route's permission.
 *
 * The generic sweeps stay as defense in depth. Runs after the full suite on a
 * populated LOCAL database (`npm run test:sweep`).
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createUserWithWallet, createVerifiedDevice, establishedSessionToken, fundUser, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';
import { listRoutes } from '../../lib/api-router.js';
import { ROUTE_POLICY } from '../../lib/authz/route-policy.js';
import { ADMIN_ROLES } from '../../lib/authz/catalog.js';
import { checkInvariants } from '../../lib/money-kernel/invariants.js';
import { operator } from '../j3/helpers.js';
import { sourceFor } from './sources.js';
import { ADMIN_OBJECT_LEVEL, PUBLIC_BY_DESIGN, VALID_BODIES, isCriticalAdminRoute, isCriticalUserRoute } from './boundary-bodies.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';

const isValidationRefusal = (r) => r.status === 400 && (r.body?.error === 'Validation failed' || r.body?.code === 'validation_failed');
export function classify(r) {
  if (r.status >= 200 && r.status < 300) return 'ACCEPTED';
  if (isValidationRefusal(r)) return 'VALIDATION_REFUSED_BEFORE_AUTHORIZATION';
  if (r.status === 429) return 'RATE_LIMITED';
  if (r.status >= 500) return 'SERVER_ERROR';
  if ([401, 403, 404, 410, 423].includes(r.status)) return 'AUTHORIZATION_REACHED_AND_REFUSED';
  return 'BUSINESS_RULE_REFUSED';
}

const host = new URL(process.env.DATABASE_URL.replace(/^postgres(ql)?:/, 'http:')).hostname;
const localDb = /^(localhost|127\.0\.0\.1)$/.test(host);

let api;
before(async () => { if (localDb) api = await startApiServer({ TONTINE_ESCROW_ENABLED: 'true', ADMIN_API_KEY: '' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

test('dynamic: critical user routes on someone else’s objects — authorization reached and refused, never validation-only', { timeout: 900_000, skip: !localDb }, async () => {
  assert.ok((await prisma.user.count()) > 50, 'run after the full suite (populated DB)');
  const user = await createUserWithWallet({ koriBalance: 0, tier: 3 });
  await fundUser(user.id, 50_000);
  const device = await createVerifiedDevice(user.id);
  const token = await establishedSessionToken(user.id, device, ACCESS_SECRET, { stepUp: true });
  const ip = freshIp();
  const own = await prisma.business.create({ data: { ownerId: user.id, name: `Boundary ${crypto.randomBytes(3).toString('hex')}` } });
  await prisma.accountRole.createMany({ data: ['personal', 'driver', 'agent'].map((role) => ({ userId: user.id, role, status: 'active' })) });
  const ctx = { attackerId: user.id, attackerHandle: user.handle, ownBizId: own.id };
  const results = [];
  const findings = [];
  for (const r of listRoutes().filter((x) => x.auth === 'user')) {
    const key = `${r.method} ${r.path}`;
    if (!isCriticalUserRoute(key, ROUTE_POLICY[key] ?? {})) continue;
    const sql = sourceFor(key);
    if (!sql) {
      findings.push(`${key}: no foreign-object source`);
      continue;
    }
    const rows = await prisma.$queryRawUnsafe(`${sql.replaceAll('$ME', `'${user.id}'`).replaceAll('$MYBIZ', `'${own.id}'`)} ORDER BY random() LIMIT 1`).catch((e) => {
      findings.push(`${key}: source query failed (${e.message.slice(0, 80)})`);
      return [];
    });
    if (!rows.length) {
      findings.push(`${key}: no foreign object to attack`);
      continue;
    }
    const [a, b] = String(Object.values(rows[0])[0]).split('|');
    const path = r.path.replace(/:(id|reference|code)/, encodeURIComponent(a)).replace(':subId', encodeURIComponent(b ?? ''));
    await prisma.userRateLimit.deleteMany({ where: { userId: user.id } });
    await prisma.$executeRawUnsafe(`DELETE FROM "RateLimitBucket" WHERE "key" LIKE '%${user.id}%'`);
    const res = await api.client(r.method, path, { token, device, ip, headers: { 'x-vercel-ip-country': 'SN', 'idempotency-key': `bnd-${crypto.randomBytes(6).toString('hex')}` }, body: VALID_BODIES[key](ctx) });
    const cls = classify(res);
    results.push({ route: key, status: res.status, cls, code: res.body?.code ?? res.body?.error ?? null });
    if (cls === 'VALIDATION_REFUSED_BEFORE_AUTHORIZATION') findings.push(`${key}: ${cls} — fix its VALID_BODIES entry (${JSON.stringify(res.body?.details?.fieldErrors ?? {}).slice(0, 160)})`);
    if (cls === 'SERVER_ERROR') findings.push(`${key}: HTTP ${res.status}`);
    if (cls === 'RATE_LIMITED') findings.push(`${key}: RATE_LIMITED — inconclusive, authorization not reached`);
    if (cls === 'BUSINESS_RULE_REFUSED' && !PUBLIC_BY_DESIGN.has(key)) findings.push(`${key}: BUSINESS_RULE_REFUSED (${res.status} ${JSON.stringify(res.body?.code ?? res.body?.error)}) — not authorization evidence; target an object that reaches the authorization check`);
    if (cls === 'ACCEPTED' && !PUBLIC_BY_DESIGN.has(key)) findings.push(`${key}: someone else’s object ACCEPTED (${res.status}) ${JSON.stringify(res.body).slice(0, 120)}`);
  }
  const inv = await checkInvariants(prisma);
  if (!inv.ok) findings.push(`money invariants: ${inv.violations.map((v) => v.id).join(',')}`);
  if (process.env.BOUNDARY_DETAIL) for (const x of results) console.log('ROW', x.route, x.status, x.cls, JSON.stringify(x.code).slice(0, 80));
  console.log(JSON.stringify({ criticalUserRoutes: results.length, byClass: results.reduce((m, x) => ({ ...m, [x.cls]: (m[x.cls] ?? 0) + 1 }), {}) }));
  assert.deepEqual(findings, []);
});

test('dynamic: every mutating operator route refuses an operator without its permission (central check, before the handler)', { timeout: 300_000, skip: !localDb }, async () => {
  const findings = [];
  let n = 0;
  for (const [key, p] of Object.entries(ROUTE_POLICY)) {
    if (!isCriticalAdminRoute(key, p) || !p.perm) continue;
    const role = Object.keys(ADMIN_ROLES).find((r) => !ADMIN_ROLES[r].includes(p.perm));
    const op = await operator(api, [role]);
    const [method, path] = key.split(' ');
    const res = await op.call(method, path.replace(/:[a-zA-Z]+/g, 'x1'), { reason: 'sweep: operator without permission', amountKori: 100, outcome: 'rider', resolutionNote: 'sweep without permission', status: 'suspended' });
    n += 1;
    if (!(res.status === 403 && res.body?.code === 'permission_denied')) findings.push(`${key} (as ${role}) → ${res.status} ${JSON.stringify(res.body).slice(0, 100)}`);
  }
  console.log(JSON.stringify({ operatorRoutesChecked: n }));
  assert.deepEqual(findings, []);
});
