/**
 * J15 final security review: every dormant feature stays OFF unless explicitly enabled. Each *_ENABLED / ALLOW_* /
 * *_HOLD / *_DEFERRED_* flag read in lib/ or api/ must be compared opt-in (=== 'true'), or appear in the documented
 * allowlist of flags that are deliberately on by decision. A new default-on flag fails this test until documented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
// Deliberately ON by default, each with its decision:
const DEFAULT_ON = {
  AGENT_DEPOSITS_ENABLED: 'J6 agent cash network is live; =false turns it off',
  PARTNER_LEGACY_PLATFORM_SETTLEMENT: 'P-J6-7: legacy unmapped Kabu settlement stays until =false (closure D-J14-3 dormant)',
  PARTNER_EVENTS_ALLOW_LOCAL: 'negative guard (!== true): refuses local delivery targets unless explicitly allowed',
  JOKKO_COLLECTIVE_ENABLED: 'negative guard (!== true): the collective engine refuses when not enabled',
  LEGACY_B2B_ORDERS_ENABLED: 'negative guard (!== true): legacy B2B orders refused when not enabled',
};

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : files(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

test('dormant features are opt-in: every feature flag is compared === "true" unless documented default-on', () => {
  const RE = /process\.env\.([A-Z0-9_]*(?:_ENABLED|ALLOW_[A-Z_]+|_LEGAL_HOLD|_DEFERRED_SETTLEMENT|_PLATFORM_SETTLEMENT|ALLOW_LOCAL))\s*(===|!==)\s*'(true|false)'/g;
  const seen = new Map();
  for (const f of [...files(path.join(ROOT, 'lib')), ...files(path.join(ROOT, 'api'))]) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(RE)) {
      const [, flag, op, val] = m;
      const optIn = op === '===' && val === 'true';
      if (!optIn && !DEFAULT_ON[flag]) seen.set(flag, `${path.relative(ROOT, f)}: ${op} '${val}'`);
    }
  }
  assert.deepEqual(Object.fromEntries(seen), {}, 'undocumented default-on flags');
});

test('no deployment config turns a dormant feature on (vercel.json carries no env)', () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.equal(v.env, undefined);
  assert.equal(v.build?.env, undefined);
});
