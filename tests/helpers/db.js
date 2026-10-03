import './setup.js';
import crypto from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { custodyKoriTotals } from '../../lib/kori-reserve.js';
import { agentFloatTopUp, business as businessAccount, testFund } from '../../lib/money-kernel/index.js';

export { prisma };

let phoneCounter = 0;

export function uniquePhone() {
  // Digits only: a real E.164 number. (Hex letters made phone-based lookups
  // like partner messaging and support agents fail normalization.)
  phoneCounter += 1;
  const rand = String(crypto.randomInt(0, 10_000_000)).padStart(7, '0');
  return `+2217${rand}${String(phoneCounter % 1000).padStart(3, '0')}`;
}

export function uniqueRef(prefix = 'TEST') {
  return `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

/**
 * Create a user + wallet at a given verification tier.
 * tier 1 = phone only, tier 2 = CNI verified, tier 3 = CNI + address.
 */
export async function createUserWithWallet({
  balance = 0,
  koriBalance,
  tier = 2,
  name = 'Test User',
  isDiaspora = false,
  handle,
} = {}) {
  const spendableKori = koriBalance ?? balance;
  const now = new Date();
  const user = await prisma.user.create({
    data: {
      phone: uniquePhone(),
      name,
      country: 'SN',
      handle: handle ?? `test${crypto.randomBytes(4).toString('hex')}`,
      otpVerifiedAt: now,
      isDiaspora,
      verificationTier: tier,
      verificationStatus: tier >= 2 ? 'cni_verified' : 'phone_only',
      cniVerifiedAt: tier >= 2 ? now : null,
      addressVerifiedAt: tier >= 3 ? now : null,
      lastActivityAt: now,
      wallet: { create: { balance: 0, koriBalance: 0, currency: 'XOF' } },
    },
    include: { wallet: true },
  });
  if (spendableKori > 0) await fundUser(user.id, spendableKori);
  return prisma.user.findUnique({ where: { id: user.id }, include: { wallet: true } });
}

/**
 * Test-only funding through the Money Kernel (test faucet → customer). The
 * database refuses direct balance writes, so fixtures fund like everything else.
 */
export async function fundUser(userId, amount, db = prisma) {
  const run = (tx) => testFund(tx, { userId, amount, reference: uniqueRef('FAUCET') });
  return db === prisma ? prisma.$transaction(run) : run(db);
}

/** Register a verified device for a user so fraud checks pass. */
export async function createVerifiedDevice(userId, deviceId = `test-device-${crypto.randomBytes(6).toString('hex')}`) {
  await prisma.userDevice.create({
    data: {
      userId,
      deviceId,
      deviceName: 'Test Phone',
      ip: '127.0.0.1',
      countryCode: 'SN',
      verifiedAt: new Date(),
    },
  });
  return deviceId;
}

/**
 * J3 fixture: an ESTABLISHED login — a verified device first seen
 * `deviceAgeHours` ago, a trusted AuthSession on it, and (optionally) a PIN
 * step-up made in that session. Returns an access token bound to the session
 * (sid), signed with `secret`. This is the precondition a real customer has
 * after signing in on their own phone; tests about new devices, recovery or
 * missing step-up build their own weaker sessions instead.
 */
export async function establishedSessionToken(userId, deviceId, secret, { stepUp = true, deviceAgeHours = 48, trust = 'trusted' } = {}) {
  const jwt = (await import('jsonwebtoken')).default;
  const past = new Date(Date.now() - deviceAgeHours * 60 * 60 * 1000);
  await prisma.userDevice.updateMany({ where: { userId, deviceId }, data: { firstSeenAt: past, verifiedAt: past } });
  const session = await prisma.authSession.create({
    data: {
      userId,
      deviceId,
      authMethod: 'otp_phone',
      trust,
      trustedAt: trust === 'trusted' ? past : null,
      stepUpAt: stepUp ? new Date() : null,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  const token = jwt.sign({ sub: userId, type: 'access', iatMs: Date.now(), sid: session.id }, secret, { expiresIn: '30m' });
  return token;
}

/**
 * ₭ a user received as `reward` entries paid FROM the funded incentive budget
 * (another test may leave incentives:funded with a balance). Rewards are
 * legitimate only from that budget; anything else would be minted value.
 */
export async function fundedRewardsFor(userId) {
  const [{ funded }] = await prisma.$queryRaw`
    SELECT COALESCE(SUM(c.amount), 0)::int AS funded
      FROM "Posting" c
      JOIN "LedgerAccount" ca ON ca.id = c."accountId"
      JOIN "JournalEntry" j ON j.id = c."entryId" AND j.kind = 'reward'
     WHERE ca.code = ${`customer:${userId}:available`} AND c.side = 'credit'
       AND EXISTS (SELECT 1 FROM "Posting" d JOIN "LedgerAccount" da ON da.id = d."accountId"
                    WHERE d."entryId" = j.id AND da.code = 'incentives:funded' AND d.side = 'debit')`;
  return funded;
}

/** Session id behind a token minted by establishedSessionToken. */
export function sidOf(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sid;
}

/**
 * Reset the global Kori reserve so it exactly matches SUM(wallet.koriBalance).
 * Serial test execution makes this safe (see --test-concurrency=1).
 */
export async function resetReserveToWallets() {
  // All ₭ custody accounts (wallets, business wallets, pots, vouchers, escrow).
  const { total } = await custodyKoriTotals(prisma);
  await prisma.koriReserve.upsert({
    where: { id: 'global' },
    create: {
      id: 'global',
      totalKoriInCirculation: total,
      totalReserveHeldXof: total * 10,
    },
    update: {
      totalKoriInCirculation: total,
      totalReserveHeldXof: total * 10,
      conversionsFrozen: false,
      lastMismatchXof: 0,
    },
  });
}

/** Minimal Vercel-style request mock. */
export function mockReq({ method = 'POST', headers = {}, body = {}, query = {}, userId } = {}) {
  const req = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body,
    query,
    url: '/api/test',
    socket: { remoteAddress: '127.0.0.1' },
  };
  if (userId) req.userId = userId;
  return req;
}

/** Minimal Vercel-style response mock that records everything. */
export function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    headersSent: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      this.ended = true;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.headersSent = true;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      this.headersSent = true;
      return this;
    },
  };
  return res;
}

/**
 * Max concurrent DB operations for load tests. The local Prisma dev proxy is a
 * lightweight single process; production Postgres handles far more. This bounds
 * in-flight work so we measure business-logic correctness (exactly-once,
 * conserved balances, floor-at-zero) rather than proxy connection limits.
 */
export const LOAD_CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 10);

function isTransientDbError(error) {
  const msg = String(error?.message ?? '');
  return (
    error?.code === 'P1017' ||
    /Server has closed the connection|unexpected message from server|prepared statement|Timed out|Can't reach database/i.test(
      msg,
    )
  );
}

/** Retry a DB op on transient proxy hiccups (not on business errors like insufficient funds). */
export async function retryTransient(fn, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientDbError(error)) throw error;
      lastError = error;
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
  }
  throw lastError;
}

/** Run promises with a bounded number in flight (for load tests). */
export async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      try {
        results[index] = { ok: true, value: await tasks[index]() };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** Test-only: fund a business wallet through the Money Kernel. */
export async function fundBusiness(businessId, amount) {
  return prisma.$transaction(async (tx) => {
    const to = await businessAccount(tx, businessId);
    return testFund(tx, { to, amount, reference: uniqueRef('FAUCETB') });
  });
}

/** Test-only: agent float via the attested top-up flow (XOF). */
export async function fundAgentFloat(agentId, amountXof) {
  return prisma.$transaction((tx) => agentFloatTopUp(tx, { agentId, amountMinor: amountXof, reference: uniqueRef('AFT'), adminId: 'test' }));
}
