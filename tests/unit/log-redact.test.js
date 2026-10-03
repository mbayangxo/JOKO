import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, safeError, maskEmail } from '../../lib/log-redact.js';

test('redactText removes hashes, JWTs, emails, phone numbers and inline secrets', () => {
  const raw = [
    'Invalid `prisma.user.update()` invocation: { pinHash: "$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ01234",',
    'phone: "+221771234567", email: "awa@example.sn", tokenHash: "' + 'a'.repeat(64) + '",',
    'code: "135790", Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eXoifQ.c2lnbmF0dXJlLXZhbHVl }',
  ].join(' ');
  const out = redactText(raw);
  for (const leaked of ['$2b$10$', '+221771234567', 'awa@example.sn', 'a'.repeat(64), '135790', 'eyJhbGciOiJIUzI1NiJ9']) {
    assert.ok(!out.includes(leaked), `leaked ${leaked}: ${out}`);
  }
  assert.match(out, /prisma\.user\.update/);
});

test('safeError keeps name/code/model, redacts message and stack', () => {
  const e = new Error('Unique constraint failed for phone +221770000001');
  e.name = 'PrismaClientKnownRequestError';
  e.code = 'P2002';
  e.meta = { modelName: 'User', target: ['phone'] };
  const s = safeError(e);
  assert.equal(s.code, 'P2002');
  assert.equal(s.model, 'User');
  assert.ok(!s.message.includes('+221770000001'));
  assert.ok(!s.stack.includes('+221770000001'));
  assert.equal(maskEmail('awa@example.sn'), 'a***@example.sn');
});
