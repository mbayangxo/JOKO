/**
 * J12-F10 guard: every NAMED import between local modules under src/ must name a real export.
 * The bundler does not fail on a missing named export (it becomes `undefined` at runtime) — that is how
 * chat media sends imported `sendMboloMediaMessage` while the module exported `sendMbooloMediaMessage`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('src');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|jsx)$/.test(e.name)) files.push(p);
  }
})(ROOT);

function resolveLocal(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, `${base}.js`, `${base}.jsx`, `${base}.web.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) names.add(n);
    }
  }
  if (/export\s+default\b/.test(src)) names.add('default');
  const star = [...src.matchAll(/export\s+\*\s+from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
  return { names, star };
}

const cache = new Map();
function allExports(file, seen = new Set()) {
  if (cache.has(file)) return cache.get(file);
  if (seen.has(file)) return new Set();
  seen.add(file);
  const { names, star } = exportsOf(file);
  for (const s of star) {
    const r = resolveLocal(file, s);
    if (r) for (const n of allExports(r, seen)) names.add(n);
  }
  cache.set(file, names);
  return names;
}

test('every named import from a local src/ module resolves to an export', () => {
  const missing = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s+from\s+['"](\.[^'"]+)['"]/g)) {
      const target = resolveLocal(f, m[2]);
      if (!target) {
        missing.push(`${path.relative(ROOT, f)}: cannot resolve ${m[2]}`);
        continue;
      }
      const ex = allExports(target);
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (name && !ex.has(name)) missing.push(`${path.relative(ROOT, f)} imports { ${name} } from ${m[2]} — not exported`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
