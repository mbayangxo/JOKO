/**
 * J13-4 — deterministic unit tests of the recipient / instruction tokens (pure; fixed clock, no DB).
 * Every refusal path is exercised: forged, wrong kind, expired, cross-account, renamed handle, reclaimed
 * handle, changed phone number, changed amount, changed / missing idempotency key, malformed input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_ACCESS_SECRET ??= 'test-jwt-access-secret-0123456789';
const {
  issueRecipientRef, issueInstructionRef, verifyInstructionRef, recipientIdFromRef,
  RecipientBindingError, RECIPIENT_REF_TTL_MS, INSTRUCTION_REF_TTL_MS,
} = await import('../../lib/recipient-ref.js');

const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const A = { id: 'acct_sender' };
const B = { id: 'acct_bob', handle: 'awa77123456', phone: '+221771234567' };
const C = { id: 'acct_carl', handle: 'carl', phone: '+221779999999' };
const KEY = 'intent-0123456789abcdef';

const refused = (fn, code) => assert.throws(fn, (e) => e instanceof RecipientBindingError && e.code === code, code);
const rr = (via = 'handle', now = T0) => issueRecipientRef({ senderId: A.id, recipient: B, via, now });
const ri = (opts = {}) => issueInstructionRef({ recipientRef: rr(opts.via), senderId: A.id, recipient: B, amountKori: 1500, intentKey: KEY, now: T0, ...opts });

test('happy path: lookup → confirm → send verifies; the token never carries the id, handle or phone in clear', () => {
  const ref = rr();
  const instr = ri();
  // Nothing readable: not the account ids, handle or phone — in any segment, raw or base64-decoded.
  for (const t of [ref, instr]) {
    const views = [t, ...t.split('.').map((p) => Buffer.from(p, 'base64url').toString('latin1'))];
    for (const secret of [A.id, B.id, B.handle, B.phone, '771234567', KEY]) {
      for (const v of views) assert.ok(!v.includes(secret), `token leaks ${secret}`);
    }
  }
  assert.equal(recipientIdFromRef(ref, { senderId: A.id, now: T0 }), B.id);
  const p = verifyInstructionRef(ri(), { senderId: A.id, recipient: B, amountKori: 1500, intentKey: KEY, now: T0 + 1000 });
  assert.equal(p.r, B.id);
});

test('forged / tampered / wrong-kind / malformed tokens are refused', () => {
  const good = ri();
  const [k, iv, blob] = good.split('.');
  const flip = (b64) => { const b = Buffer.from(b64, 'base64url'); b[0] ^= 1; return b.toString('base64url'); };
  for (const t of [`${k}.${iv}.${flip(blob)}`, `${k}.${flip(iv)}.${blob}`, `rr2.${iv}.${blob}`, rr(), 'ri2..', 'x', 'r1.AAAA', `${'a'.repeat(2000)}`]) {
    refused(() => verifyInstructionRef(t, { senderId: A.id, recipient: B, amountKori: 1500, intentKey: KEY, now: T0 }), 'forged');
  }
  refused(() => verifyInstructionRef(undefined, { senderId: A.id, recipient: B, amountKori: 1500, intentKey: KEY, now: T0 }), 'confirmation_required');
});

test('expiry: a stale confirmation screen cannot pay', () => {
  refused(() => issueInstructionRef({ recipientRef: rr(), senderId: A.id, recipient: B, amountKori: 1500, intentKey: KEY, now: T0 + RECIPIENT_REF_TTL_MS + 1 }), 'expired');
  refused(() => verifyInstructionRef(ri(), { senderId: A.id, recipient: B, amountKori: 1500, intentKey: KEY, now: T0 + INSTRUCTION_REF_TTL_MS + 1 }), 'expired');
});

test('cross-account: another sender can never use my confirmation', () => {
  refused(() => verifyInstructionRef(ri(), { senderId: 'acct_mallory', recipient: B, amountKori: 1500, intentKey: KEY, now: T0 }), 'cross_account');
  refused(() => recipientIdFromRef(rr(), { senderId: 'acct_mallory', now: T0 }), 'cross_account');
});

test('renamed handle (same account) → refused: the sender confirmed "@awa77123456", not whatever the account is called now', () => {
  refused(() => verifyInstructionRef(ri(), { senderId: A.id, recipient: { ...B, handle: 'awa_new' }, amountKori: 1500, intentKey: KEY, now: T0 }), 'recipient_changed');
});

test('reclaimed handle (another account holds it now) → refused', () => {
  refused(() => verifyInstructionRef(ri(), { senderId: A.id, recipient: { ...C, handle: B.handle }, amountKori: 1500, intentKey: KEY, now: T0 }), 'recipient_changed');
  refused(() => issueInstructionRef({ recipientRef: rr(), senderId: A.id, recipient: { ...C, handle: B.handle }, amountKori: 1500, intentKey: KEY, now: T0 }), 'recipient_changed');
});

test('changed phone number after a phone lookup → refused; a phone lookup is unaffected by a handle rename', () => {
  const byPhone = ri({ via: 'phone' });
  refused(() => verifyInstructionRef(byPhone, { senderId: A.id, recipient: { ...B, phone: '+221770000000' }, amountKori: 1500, intentKey: KEY, now: T0 }), 'recipient_changed');
  assert.ok(verifyInstructionRef(byPhone, { senderId: A.id, recipient: { ...B, handle: 'renamed' }, amountKori: 1500, intentKey: KEY, now: T0 }));
});

test('changed amount or a different payment key → refused (one confirmation = one payment)', () => {
  refused(() => verifyInstructionRef(ri(), { senderId: A.id, recipient: B, amountKori: 15_000, intentKey: KEY, now: T0 }), 'instruction_changed');
  refused(() => verifyInstructionRef(ri(), { senderId: A.id, recipient: B, amountKori: 1500, intentKey: 'intent-replayed-key-01', now: T0 }), 'instruction_changed');
  refused(() => verifyInstructionRef(ri(), { senderId: A.id, recipient: B, amountKori: 1500, intentKey: undefined, now: T0 }), 'instruction_changed');
});
