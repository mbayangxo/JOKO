/**
 * J6 regression guard: a duplicate key in an object literal silently replaces
 * the earlier entry (J6 briefly shadowed the provider `POST cash/in|out` routes
 * and their policies this way). Every route / policy key must be unique.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function keysOf(file, startMarker) {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8');
  const start = src.indexOf(startMarker);
  const end = src.indexOf('\n};', start);
  const body = src.slice(start, end);
  return [...body.matchAll(/^\s{2}'((?:GET|POST|PATCH|PUT|DELETE) [^']+)':/gm)].map((m) => m[1]);
}

for (const [file, marker] of [['../../lib/api-router.js', 'const ROUTES = {'], ['../../lib/authz/route-policy.js', 'export const ROUTE_POLICY = {']]) {
  test(`no duplicate route keys in ${file.split('/').pop()}`, () => {
    const keys = keysOf(file, marker);
    assert.ok(keys.length > 300, `parsed ${keys.length} keys`);
    const seen = new Set();
    const dup = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    assert.deepEqual(dup, []);
  });
}
