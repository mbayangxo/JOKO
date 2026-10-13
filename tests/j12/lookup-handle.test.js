/**
 * J12-F13 — a handle with 8+ digits must be found when searched AS A HANDLE (found by the J12 lab: a
 * recipient "test07613018" was reported "Personne introuvable" because the server guessed "phone").
 * Phone search keeps its budget and privacy rules; a plain digit query is still a phone search.
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

test('digit-heavy handles are found in handle mode or with "@"; digits alone still mean a phone number', async () => {
  const a = await signedIn(api, await customer());
  const b = await customer();
  const handle = `awa${String(Date.now()).slice(-9)}`;
  await prisma.user.update({ where: { id: b.id }, data: { handle } });
  const byMode = await a.call('GET', `users/lookup?q=${handle}&mode=handle`);
  assert.equal(byMode.status, 200, JSON.stringify(byMode.body));
  assert.equal(byMode.body.handle?.replace(/^@/, ''), handle);
  const byAt = await a.call('GET', `users/lookup?q=${encodeURIComponent(`@${handle}`)}`);
  assert.equal(byAt.status, 200);
  const legacy = await a.call('GET', `users/lookup?q=${handle}`);
  assert.equal(legacy.status, 404, 'unchanged legacy guess for a bare digit-heavy query (old clients)');
  const phoneMode = await a.call('GET', `users/lookup?q=${encodeURIComponent(b.phone)}&mode=phone`);
  assert.ok([200, 404, 429].includes(phoneMode.status), 'phone search keeps its own rules (budget, find-me-by-number)');
});
