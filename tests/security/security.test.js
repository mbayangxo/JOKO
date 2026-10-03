import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { createHandler } from '../../api/_lib/http.js';
import { signAccessToken } from '../../api/_lib/auth.js';
import { getWallet, transfersSend } from '../../lib/handlers.js';
import { PinError, setUserPin, unlockAccountWithCni, verifyUserPin } from '../../lib/pin-service.js';
import { reconcileKoriReserve } from '../../lib/kori-reserve.js';
import { hashCni } from '../../lib/cni-hash.js';
import {
  createUserWithWallet,
  createVerifiedDevice,
  mockReq,
  mockRes,
  prisma,
  resetReserveToWallets,
} from '../helpers/db.js';

after(() => prisma.$disconnect());

const UNIQUE_CNI = `SN-CNI-${Date.now()}${Math.floor(Math.random() * 1000)}`;

const walletEndpoint = createHandler({ methods: 'GET', auth: true, handler: getWallet });

async function sendVia(user, deviceId, body) {
  const req = mockReq({
    userId: user.id,
    body,
    headers: { 'x-device-id': deviceId, 'x-vercel-ip-country': 'SN' },
  });
  const res = mockRes();
  await transfersSend(req, res);
  return res;
}

test('ATTACK: send money with insufficient balance → rejected, nothing moves', async () => {
  const attacker = await createUserWithWallet({ koriBalance: 100 });
  const victim = await createUserWithWallet({ koriBalance: 0 });
  const deviceId = await createVerifiedDevice(attacker.id);

  const res = await sendVia(attacker, deviceId, {
    recipientHandle: victim.handle,
    amount: 1_010,
    currency: 'national',
  });

  assert.equal(res.statusCode, 400);
  const a = await prisma.wallet.findUnique({ where: { id: attacker.wallet.id } });
  const v = await prisma.wallet.findUnique({ where: { id: victim.wallet.id } });
  assert.equal(a.koriBalance, 100);
  assert.equal(v.koriBalance, 0);
});

test('ATTACK: negative or fractional amounts rejected by validation', async () => {
  const attacker = await createUserWithWallet({ balance: 10_000 });
  const victim = await createUserWithWallet({ balance: 5_000 });
  const deviceId = await createVerifiedDevice(attacker.id);

  for (const amount of [-1_000, 0, 10.5]) {
    const res = await sendVia(attacker, deviceId, {
      recipientHandle: victim.handle,
      amount,
      currency: 'national',
    });
    assert.equal(res.statusCode, 400, `amount ${amount} must be rejected`);
  }

  const v = await prisma.wallet.findUnique({ where: { id: victim.wallet.id } });
  assert.equal(v.koriBalance, 5_000, 'victim balance untouched by negative-amount attack');
});

test('ATTACK: access another user\'s account with a forged token → 401', async () => {
  const victim = await createUserWithWallet({ balance: 999_999 });

  const forged = jwt.sign({ sub: victim.id, type: 'access' }, 'attacker-guessed-secret-123456', {
    expiresIn: '30m',
  });
  const res = mockRes();
  await walletEndpoint(mockReq({ method: 'GET', headers: { authorization: `Bearer ${forged}` } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body?.balance, undefined, 'no wallet data leaked');
});

test('ATTACK: expired token → 401', async () => {
  const victim = await createUserWithWallet();
  const expired = jwt.sign({ sub: victim.id, type: 'access' }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: '-1s',
  });
  const res = mockRes();
  await walletEndpoint(mockReq({ method: 'GET', headers: { authorization: `Bearer ${expired}` } }), res);
  assert.equal(res.statusCode, 401);
});

test('valid token only ever returns the token owner\'s wallet — query/body tampering ignored', async () => {
  const userA = await createUserWithWallet({ balance: 1_234 });
  const userB = await createUserWithWallet({ balance: 987_654 });

  const res = mockRes();
  await walletEndpoint(
    mockReq({
      method: 'GET',
      headers: { authorization: `Bearer ${signAccessToken(userA.id)}` },
      // Attacker tries to point the request at user B.
      query: { userId: userB.id },
      body: { userId: userB.id },
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.balance, 1_234, 'must be user A\'s balance, never user B\'s');
});

test('sender identity comes from the token, not the request body', async () => {
  const attacker = await createUserWithWallet({ balance: 5_000 });
  const richVictim = await createUserWithWallet({ balance: 1_000_000 });
  const recipient = await createUserWithWallet({ balance: 0 });
  const deviceId = await createVerifiedDevice(attacker.id);

  // Attacker injects victim identifiers into the body; handler must ignore them.
  const res = await sendVia(attacker, deviceId, {
    recipientHandle: recipient.handle,
    amount: 2_000,
    currency: 'national',
    senderId: richVictim.id,
    userId: richVictim.id,
    senderWalletId: richVictim.wallet.id,
  });

  assert.equal(res.statusCode, 201);
  const victimWallet = await prisma.wallet.findUnique({ where: { id: richVictim.wallet.id } });
  const attackerWallet = await prisma.wallet.findUnique({ where: { id: attacker.wallet.id } });
  assert.equal(victimWallet.koriBalance, 1_000_000, 'victim never debited');
  // An earn reward is allowed only when paid from the funded incentive budget
  // (another test may have left it funded); nothing may be minted.
  const [{ funded }] = await prisma.$queryRaw`
    SELECT COALESCE(SUM(c.amount), 0)::int AS funded
      FROM "Posting" c
      JOIN "LedgerAccount" ca ON ca.id = c."accountId"
      JOIN "JournalEntry" j ON j.id = c."entryId" AND j.kind = 'reward'
     WHERE ca.code = ${`customer:${attacker.id}:available`} AND c.side = 'credit'
       AND EXISTS (SELECT 1 FROM "Posting" d JOIN "LedgerAccount" da ON da.id = d."accountId"
                    WHERE d."entryId" = j.id AND da.code = 'incentives:funded' AND d.side = 'debit')`;
  assert.equal(attackerWallet.koriBalance, 4_800 + funded, 'attacker pays from their own wallet (200 ₭ send; rewards only from the funded budget)');
});

test('ATTACK: session expired after 30 minutes of inactivity → API refreshes activity (client PIN gate)', async () => {
  const user = await createUserWithWallet();
  await prisma.user.update({
    where: { id: user.id },
    data: { lastActivityAt: new Date(Date.now() - 31 * 60 * 1000) },
  });

  const res = mockRes();
  await walletEndpoint(
    mockReq({ method: 'GET', headers: { authorization: `Bearer ${signAccessToken(user.id)}` } }),
    res,
  );
  assert.equal(res.statusCode, 200, 'API layer refreshes lastActivityAt; idle lock is client-side');
  const refreshed = await prisma.user.findUnique({ where: { id: user.id }, select: { lastActivityAt: true } });
  assert.ok(Date.now() - refreshed.lastActivityAt.getTime() < 5_000);
});

test('ATTACK: brute-force PIN — locked after 5 wrong attempts, CNI required to unlock', async () => {
  const user = await createUserWithWallet();
  await prisma.user.update({ where: { id: user.id }, data: { cniHash: hashCni(UNIQUE_CNI) } });
  await setUserPin(user.id, '135790');

  for (let i = 0; i < 4; i++) {
    await assert.rejects(verifyUserPin(user.id, '000000'), (e) => e.code === 'invalid_pin');
  }
  await assert.rejects(verifyUserPin(user.id, '000000'), (e) => e.code === 'locked');

  // Even the CORRECT PIN is refused while locked.
  await assert.rejects(verifyUserPin(user.id, '135790'), (e) => e.code === 'locked');

  // Locked account is also cut off at the API layer (423).
  const res = mockRes();
  await walletEndpoint(
    mockReq({ method: 'GET', headers: { authorization: `Bearer ${signAccessToken(user.id)}` } }),
    res,
  );
  assert.equal(res.statusCode, 423);
  assert.equal(res.body.code, 'account_locked');

  // Wrong CNI does not unlock; correct CNI does.
  await assert.rejects(unlockAccountWithCni(user.id, 'WRONG-CNI'), PinError);
  const unlocked = await unlockAccountWithCni(user.id, UNIQUE_CNI.toLowerCase());
  assert.equal(unlocked.unlocked, true);
  const result = await verifyUserPin(user.id, '135790');
  assert.equal(result.verified, true);
});

test('ATTACK: manipulate Kori balance directly → the database refuses it (J2 projection guard)', async () => {
  const attacker = await createUserWithWallet({ koriBalance: 10 }); // ledger account exists

  // Attacker with DB write access tries to inflate their own balance.
  await assert.rejects(
    prisma.wallet.update({ where: { id: attacker.wallet.id }, data: { koriBalance: 1_000_000 } }),
    /ledger projection/,
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "Wallet" SET "koriBalance" = 1000000 WHERE id = '${attacker.wallet.id}'`),
    /ledger projection/,
  );
  // …or the ledger account itself.
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "LedgerAccount" SET "balance" = 1000000 WHERE "code" = 'customer:${attacker.id}:available'`),
    /only change through journal postings/,
  );
  // …or a one-sided posting (value from nothing): rejected at COMMIT.
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      const acct = await tx.ledgerAccount.findUnique({ where: { code: `customer:${attacker.id}:available` } })
        ?? (await import('../../lib/money-kernel/index.js')).customer(tx, attacker.id);
      const entry = await tx.journalEntry.create({ data: { reference: `ATTACK-${Date.now()}`, kind: 'attack', payloadHash: 'x', actorType: 'user' } });
      await tx.posting.create({ data: { entryId: entry.id, accountId: (await acct).id, side: 'credit', amount: 1_000_000n, currency: 'KRI' } });
    }),
    /does not balance|at least 2/,
  );
  const after = await prisma.wallet.findUnique({ where: { id: attacker.wallet.id } });
  assert.equal(after.koriBalance, 10, 'no value created');
});

test('ATTACK: SQL injection in every input field is stored/compared literally', async () => {
  const payloads = [
    `'; DROP TABLE "User"; --`,
    `" OR ""="`,
    `1; UPDATE "Wallet" SET balance = 999999999; --`,
    `Robert'); DELETE FROM "LedgerEntry"; --`,
  ];

  const attacker = await createUserWithWallet({ balance: 50_000, name: payloads[0] });
  const recipient = await createUserWithWallet({ balance: 0 });
  const deviceId = await createVerifiedDevice(attacker.id);

  // Injection via recipient handle lookup → clean 404, no SQL executed.
  for (const payload of payloads) {
    const res = await sendVia(attacker, deviceId, {
      recipientHandle: payload,
      amount: 100,
      currency: 'national',
    });
    assert.equal(res.statusCode, 404, `handle payload must not match or execute: ${payload}`);
  }

  // Injection via the free-text note field → stored as an inert literal.
  const res = await sendVia(attacker, deviceId, {
    recipientHandle: recipient.handle,
    amount: 1_000,
    currency: 'national',
    note: payloads[2],
  });
  assert.equal(res.statusCode, 201);

  const entry = await prisma.ledgerEntry.findFirst({
    where: { userId: attacker.id, type: 'send' },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(entry.note, payloads[2], 'payload stored verbatim, not executed');

  // All tables still exist and no wallet was inflated.
  const [{ users }] = await prisma.$queryRaw`SELECT COUNT(*)::int AS users FROM "User"`;
  assert.ok(users >= 2, 'User table intact');
  const recipientWallet = await prisma.wallet.findUnique({ where: { id: recipient.wallet.id } });
  assert.equal(recipientWallet.koriBalance, 100, 'only the legitimate 100 ₭ arrived');
});

test('ATTACK: intercept API calls — plain HTTP refused in production, HSTS always on', async (t) => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    process.env.NODE_ENV = previousEnv;
  });

  const openEndpoint = createHandler({
    methods: 'GET',
    auth: false,
    handler: (_req, res) => res.status(200).json({ ok: true }),
  });

  const httpRes = mockRes();
  await openEndpoint(
    mockReq({ method: 'GET', headers: { 'x-forwarded-proto': 'http' } }),
    httpRes,
  );
  assert.equal(httpRes.statusCode, 403, 'downgraded HTTP request must be refused');

  const httpsRes = mockRes();
  await openEndpoint(
    mockReq({ method: 'GET', headers: { 'x-forwarded-proto': 'https' } }),
    httpsRes,
  );
  assert.equal(httpsRes.statusCode, 200);
  assert.match(
    String(httpsRes.headers['strict-transport-security']),
    /max-age=31536000/,
    'HSTS pins browsers to HTTPS',
  );
});

test('suspicious transaction is HELD (202), not executed — unknown device', async () => {
  const user = await createUserWithWallet({ balance: 100_000 });
  const recipient = await createUserWithWallet();
  // No verified device registered — risk engine must hold.
  const res = await sendVia(user, 'device-the-system-has-never-seen', {
    recipientHandle: recipient.handle,
    amount: 5_000,
    currency: 'national',
  });

  assert.equal(res.statusCode, 202, 'held for review, not rejected, not processed');
  const wallet = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
  assert.equal(wallet.koriBalance, 100_000, 'no money moved while under review');

  const held = await prisma.heldTransaction.findFirst({ where: { userId: user.id } });
  assert.equal(held.status, 'pending_review');
});
