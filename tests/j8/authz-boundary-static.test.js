/**
 * Static half of the authorization-boundary gate: every critical route has a
 * semantically valid adversarial body (so the dynamic sweep reaches its
 * authorization decision), or a documented object-level rule. Runs in the
 * normal suite; the dynamic half runs in `npm run test:sweep`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_POLICY } from '../../lib/authz/route-policy.js';
import { ADMIN_OBJECT_LEVEL, VALID_BODIES, isCriticalAdminRoute, isCriticalUserRoute } from '../sweep/boundary-bodies.js';

test('static: every critical route has a valid adversarial body (or a documented object-level rule)', () => {
  const missing = [];
  for (const [key, p] of Object.entries(ROUTE_POLICY)) {
    if (isCriticalUserRoute(key, p) && !VALID_BODIES[key]) missing.push(key);
    if (isCriticalAdminRoute(key, p) && !p.perm && !ADMIN_OBJECT_LEVEL[key]) missing.push(`${key} (operator route without permission or object-level rule)`);
  }
  assert.deepEqual(missing, [], 'add a semantically valid body to VALID_BODIES (tests/sweep/authz-boundary.test.js)');
  for (const k of Object.keys(VALID_BODIES)) assert.ok(ROUTE_POLICY[k], `stale VALID_BODIES entry: ${k}`);
});

