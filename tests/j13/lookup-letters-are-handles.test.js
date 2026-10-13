/**
 * J13-F12 — root cause of an intermittent J4 failure ("P2P: find recipient … Personne introuvable sur K21"):
 * test handles are `test` + 8 random hex chars; when all 8 were digits (≈2.3 % of runs) the server searched
 * the query as a PHONE number. Worse than a miss: the letters were stripped, so "moussa771234567" could
 * resolve to whoever owns +221771234567 — a wrong recipient. A query containing letters is a handle.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { customer, signedIn } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

test('the exact flaky shape: "test" + 8 digits, searched bare, finds that person', async () => {
  const a = await signedIn(api, await customer());
  const b = await customer();
  const handle = `test${String(Date.now()).slice(-8)}`;
  await prisma.user.update({ where: { id: b.id }, data: { handle } });
  const r = await a.call('GET', `users/lookup?q=${handle}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.handle?.replace(/^@/, ''), handle);
});

test('a handle whose digits equal ANOTHER user\'s phone never resolves to that other user', async () => {
  const a = await signedIn(api, await customer());
  const phoneOwner = await customer();
  const handleOwner = await customer();
  const digits = phoneOwner.phone.replace(/^\+221/, '');
  const handle = `moussa${digits}`;
  await prisma.user.update({ where: { id: handleOwner.id }, data: { handle } });
  const r = await a.call('GET', `users/lookup?q=${handle}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.handle?.replace(/^@/, ''), handle, 'the handle owner — not the phone owner');
  assert.notEqual(r.body.handle?.replace(/^@/, ''), phoneOwner.handle);
});

test('phone-shaped queries are still phone searches (spaces, +, leading 0), with their own rules', async () => {
  const a = await signedIn(api, await customer());
  const b = await customer();
  const local = b.phone.replace(/^\+221/, '');
  const spaced = `${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5)}`;
  for (const q of [b.phone, spaced, `0${local}`]) {
    const r = await a.call('GET', `users/lookup?q=${encodeURIComponent(q)}`);
    // 200 when the person can be found by number, 404 when they hide it, 429 when the budget is spent —
    // never a handle search.
    assert.ok([200, 404, 429].includes(r.status), `${q}: ${r.status}`);
    if (r.status === 200) assert.equal(r.body.handle?.replace(/^@/, ''), b.handle);
  }
});
