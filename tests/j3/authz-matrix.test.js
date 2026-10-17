/**
 * J3 permission matrix — completeness and consistency (no server needed).
 */
import '../helpers/setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { listRoutes } from '../../lib/api-router.js';
import { ROUTE_POLICY, expectedRouterAuth } from '../../lib/authz/route-policy.js';
import { ADMIN_ROLES, ADMIN_ROLE_CONFLICTS, ALL_ADMIN_PERMISSIONS, USER_ROLES, SELF_SERVICE_ROLES } from '../../lib/authz/catalog.js';
import { APPROVAL_ACTIONS } from '../../lib/authz/approvals.js';
import { RULES, decide } from '../../lib/risk/engine.js';

const routes = listRoutes();
const key = (r) => `${r.method} ${r.path}`;

test('every route has exactly one policy, and no policy points at a non-existent route', () => {
  const keys = new Set(routes.map(key));
  const missing = [...keys].filter((k) => !ROUTE_POLICY[k]);
  const stale = Object.keys(ROUTE_POLICY).filter((k) => !keys.has(k));
  assert.deepEqual(missing, [], `routes without policy: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `policies without route: ${stale.join(', ')}`);
  assert.ok(routes.length >= 380);
});

test('policy actor matches how the router authenticates the route', () => {
  for (const r of routes) {
    const p = ROUTE_POLICY[key(r)];
    const want = expectedRouterAuth(p);
    const isAdminAuthBootstrap = r.path.startsWith('admin/auth/') && r.path !== 'admin/auth/logout';
    if (isAdminAuthBootstrap) continue;
    assert.equal(r.auth, want, `${key(r)}: router auth ${r.auth}, policy actor ${p.actor}`);
  }
});

test('every policy is well-formed: permission, resource relationship, valid role/risk/step-up', () => {
  for (const [k, p] of Object.entries(ROUTE_POLICY)) {
    assert.ok(['user', 'admin', 'public', 'partner', 'webhook', 'cron'].includes(p.actor), k);
    assert.ok(p.resource, `${k}: resource relationship documented`);
    if (p.actor === 'admin') {
      if (p.perm !== null) assert.ok(ALL_ADMIN_PERMISSIONS.has(p.perm), `${k}: unknown operator permission ${p.perm}`);
    } else {
      assert.ok(typeof p.perm === 'string' && p.perm.length > 2, `${k}: permission name`);
    }
    if (p.role) assert.equal(USER_ROLES[p.role]?.grant, 'application', `${k}: role gate must be an application role`);
    if (p.risk) assert.ok(['cash_out', 'sensitive_change'].includes(p.risk), k);
    if (p.stepUp) assert.ok(['amount', 'always'].includes(p.stepUp), k);
  }
});

test('the cash-out class covers every path where value leaves the closed loop', () => {
  const cashOut = Object.entries(ROUTE_POLICY).filter(([, p]) => p.risk === 'cash_out').map(([k]) => k).sort();
  assert.deepEqual(cashOut, ['POST agent-cash/out', 'POST cash/out', 'POST kori/convert', 'POST withdrawals/agent']);
  for (const k of cashOut) assert.equal(ROUTE_POLICY[k].stepUp, 'always');
});

test('credential and contact changes are sensitive changes', () => {
  for (const k of ['POST auth/password/set', 'POST me/email', 'POST me/email/confirm', 'POST me/phone', 'POST me/phone/confirm', 'POST auth/biometric']) {
    assert.equal(ROUTE_POLICY[k].risk, 'sensitive_change', k);
  }
});

test('courier and agent working routes require the ACTIVE application role', () => {
  for (const k of ['GET deliveries/nearby', 'POST deliveries/:id/accept', 'POST deliveries/:id/pickup', 'POST deliveries/:id/deliver']) {
    assert.equal(ROUTE_POLICY[k].role, 'driver', k);
  }
  // J6: an applicant (no role yet) reads its own lifecycle and proposes service points — no money, no operations.
  for (const k of Object.keys(ROUTE_POLICY).filter((x) => /^(GET|POST|PATCH) agent\/(?!apply|application|lifecycle|service-points)/.test(x))) {
    assert.equal(ROUTE_POLICY[k].role, 'agent', k);
  }
});

test('self-service roles carry no money or trust privilege; application roles need an approver permission', () => {
  assert.deepEqual([...SELF_SERVICE_ROLES].sort(), ['promoter', 'seller', 'worker']);
  for (const [r, def] of Object.entries(USER_ROLES)) {
    if (def.grant === 'application') assert.ok(ALL_ADMIN_PERMISSIONS.has(def.approver), r);
  }
});

test('separation of duties: no god-mode role, no self-contained maker+checker, sysadmin holds no money/identity power', () => {
  const all = ALL_ADMIN_PERMISSIONS.size;
  for (const [role, perms] of Object.entries(ADMIN_ROLES)) {
    assert.ok(perms.length < all, `${role} is not god-mode`);
    assert.ok(!(perms.includes('finance.adjust.request') && perms.includes('finance.adjust.approve')), `${role} cannot both request and approve adjustments`);
    assert.ok(!(perms.includes('finance.refund') && perms.includes('finance.refund.approve')), role);
    assert.ok(!(perms.includes('finance.agent_float') && perms.includes('finance.agent_float.approve')), role);
  }
  assert.ok(!ADMIN_ROLES.sysadmin.some((p) => /^(finance|users\.(freeze|unfreeze|credentials)|kyc|agents|couriers|risk)/.test(p)));
  assert.ok(!ADMIN_ROLES.support.some((p) => /^(finance|kyc|users\.(unfreeze|credentials|read\.sensitive))/.test(p)));
  for (const [a, b] of ADMIN_ROLE_CONFLICTS) assert.ok(ADMIN_ROLES[a] && ADMIN_ROLES[b]);
  for (const [action, def] of Object.entries(APPROVAL_ACTIONS)) {
    assert.ok(ALL_ADMIN_PERMISSIONS.has(def.requestPermission), action);
    assert.ok(ALL_ADMIN_PERMISSIONS.has(def.approvePermission), action);
  }
});

test('risk engine: explicit rule table; every non-allow decision carries reasons', () => {
  assert.deepEqual(decide('cash_out', []), { decision: 'allow', reasons: [] });
  const d = decide('cash_out', [{ code: 'recent_recovery', detail: 'x' }, { code: 'velocity_hour', detail: 'y' }]);
  assert.equal(d.decision, 'hold', 'hold outranks review');
  assert.ok(d.reasons[0].startsWith('recent_recovery'));
  assert.equal(decide('cash_out', [{ code: 'tier_insufficient', detail: 'tier 1' }]).decision, 'deny');
  assert.equal(decide('cash_out', [{ code: 'rapid_cash_in_out', detail: 'z' }]).decision, 'review');
  for (const rules of Object.values(RULES)) for (const level of ['deny', 'hold', 'review']) assert.ok(Array.isArray(rules[level]));
});

test('fairness: the risk engine reads no proxy for ethnicity, nationality, language or neighbourhood', () => {
  const src = readFileSync(new URL('../../lib/risk/engine.js', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .join('\n');
  for (const forbidden of [/\bcountry\b/i, /nationalit/i, /languag/i, /arrondissement/i, /ethnic/i, /\bname\b\s*:/, /isDiaspora/, /neighbo/i, /dateOfBirth/]) {
    assert.ok(!forbidden.test(src), `risk engine must not read ${forbidden}`);
  }
});
