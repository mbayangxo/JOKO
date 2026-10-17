/**
 * J15 L0 gate (part 1): the lab's fault hooks are inert outside the lab, and the oracle catches every seeded
 * known defect class. Each defect is injected inside a transaction that is ALWAYS rolled back (DB triggers are
 * bypassed only inside that transaction), and the oracle is run on that same transaction.
 * Part 2 (multi-process crash runs) is scripts/lab/run.mjs; results in docs/JOKKO-J15-REPORT.md.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUserWithWallet, prisma } from '../helpers/db.js';
import { runMoneyTransaction } from '../../lib/wallet-atomic.js';
import { account, testFund } from '../../lib/money-kernel/flows.js';
import { labEnabled } from '../../lib/lab/faults.js';
import { runOracle } from '../../scripts/lab/oracle.mjs';

after(async () => { await prisma.$disconnect(); });

const LAB_KEYS = ['JOKKO_LAB', 'JOKKO_LAB_ALLOW', 'JOKKO_LAB_FAULT_FILE', 'JOKKO_LAB_EVENT_LOG', 'VERCEL', 'VERCEL_ENV'];
function withEnv(env, fn) {
  const prev = Object.fromEntries(LAB_KEYS.map((k) => [k, process.env[k]]));
  for (const k of LAB_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  return Promise.resolve(fn()).finally(() => {
    for (const k of LAB_KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

test('money hooks are inert outside the lab: an "always crash" schedule on every money point does nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-'));
  const faultFile = path.join(dir, 'f.json');
  const log = path.join(dir, 'events.jsonl');
  fs.writeFileSync(faultFile, JSON.stringify({ faults: ['money.tx_start', 'money.before_commit', 'money.after_commit', 'ledger.post'].map((point) => ({ point, always: true, action: 'crash' })) }));
  const u = await createUserWithWallet({ koriBalance: 0 });
  const cases = [
    {}, // nothing set
    { JOKKO_LAB: 'true', JOKKO_LAB_FAULT_FILE: faultFile, JOKKO_LAB_EVENT_LOG: log }, // missing the local-only allow
    { JOKKO_LAB_ALLOW: 'local-only', JOKKO_LAB_FAULT_FILE: faultFile, JOKKO_LAB_EVENT_LOG: log },
    { JOKKO_LAB: 'true', JOKKO_LAB_ALLOW: 'local-only', VERCEL: '1', JOKKO_LAB_FAULT_FILE: faultFile, JOKKO_LAB_EVENT_LOG: log }, // never on Vercel
    { JOKKO_LAB: 'true', JOKKO_LAB_ALLOW: 'local-only', VERCEL_ENV: 'production', JOKKO_LAB_FAULT_FILE: faultFile, JOKKO_LAB_EVENT_LOG: log },
  ];
  for (const env of cases) {
    await withEnv(env, async () => {
      assert.equal(labEnabled(), false, JSON.stringify(env));
      // Would SIGKILL this very test process if any hook were live.
      await runMoneyTransaction(prisma, async (tx) => testFund(tx, { userId: u.id, amount: 1, reference: `L0-INERT-${Date.now()}-${Math.random()}` }));
    });
  }
  assert.equal(fs.existsSync(log), false, 'no fault was ever recorded');
});

const ROLLBACK = Symbol('rollback');
/** Inject a defect, run the oracle on the same snapshot, always roll back. */
async function seeded(defect) {
  let report;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`); // bypass guard triggers, this tx only
    await defect(tx);
    report = await runOracle(prisma, { tx });
    throw ROLLBACK;
  }, { timeout: 120_000 }).catch((e) => { if (e !== ROLLBACK) throw e; });
  return report;
}
const has = (report, check, id) => report.findings.some((f) => f.check === check && f.id === id);

async function fixture() {
  const u = await createUserWithWallet({ koriBalance: 0 });
  await runMoneyTransaction(prisma, async (tx) => testFund(tx, { userId: u.id, amount: 1000, reference: `L0-FIX-${u.id}` }));
  const acct = await prisma.ledgerAccount.findFirst({ where: { ownerType: 'user', ownerId: u.id, type: 'customer_available' } });
  const entry = await prisma.journalEntry.findUnique({ where: { reference: `L0-FIX-${u.id}` }, include: { postings: true } });
  return { u, acct, entry };
}

test('baseline: the oracle is clean on the fixture (no false positive from the fixture itself)', async () => {
  const { u } = await fixture();
  const r = await seeded(async () => {});
  assert.equal(r.findings.filter((f) => f.check !== 'partner').length, 0, JSON.stringify(r.findings.filter((f) => f.check !== 'partner').slice(0, 3)));
  assert.ok(u.id);
});

test('seeded defects: every class is caught (unbalanced entry, negative balance, materialized drift, projection drift, double booking)', async () => {
  const { u, acct, entry } = await fixture();
  const cases = [
    ['money', 'I1', 'J2 unbalanced journal entry (a posting changed after the fact)', (tx) => tx.$executeRawUnsafe(`UPDATE "Posting" SET amount = amount + 1 WHERE id = $1`, entry.postings[0].id)],
    ['money', 'I1b', 'J2 entry with a single posting', (tx) => tx.$executeRawUnsafe(`DELETE FROM "Posting" WHERE id = $1`, entry.postings[0].id)],
    // The database already refuses this (CHECK LedgerAccount_nonneg_chk); the oracle is the second line, proven
    // here by dropping the constraint inside the rolled-back transaction (Postgres DDL is transactional).
    ['money', 'I2', 'J2 customer account driven negative', async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "LedgerAccount" DROP CONSTRAINT "LedgerAccount_nonneg_chk"`);
      await tx.$executeRawUnsafe(`UPDATE "LedgerAccount" SET balance = -5 WHERE id = $1`, acct.id);
    }],
    ['money', 'I12', 'J2 materialized balance drifts from postings', (tx) => tx.$executeRawUnsafe(`UPDATE "LedgerAccount" SET balance = balance + 7 WHERE id = $1`, acct.id)],
    ['money', 'I11', 'J2 legacy wallet column drifts from the ledger (projection)', (tx) => tx.$executeRawUnsafe(`UPDATE "Wallet" SET "koriBalance" = "koriBalance" + 3 WHERE "userId" = $1`, u.id)],
    ['exactly_once', 'duplicate_client_key', 'J4/J12 one client key booked twice', async (tx) => {
      for (const ref of [`L0-DUP-A-${u.id}`, `L0-DUP-B-${u.id}`]) {
        await runMoneyTransaction(tx, (t) => testFund(t, { userId: u.id, amount: 1, reference: ref }));
        await tx.$executeRawUnsafe(`UPDATE "JournalEntry" SET kind = 'p2p_transfer', metadata = jsonb_build_object('clientKey', $2::text) WHERE reference = $1`, ref, `${u.id}:dup-key`);
      }
    }],
  ];
  const missed = [];
  for (const [check, id, label, defect] of cases) {
    const r = await seeded(defect);
    if (!has(r, check, id)) missed.push(`${label} → expected ${check}:${id}, got ${JSON.stringify(r.findings.map((f) => `${f.check}:${f.id}`))}`);
  }
  assert.deepEqual(missed, []);
  // Everything was rolled back: the real database is untouched.
  const clean = await runOracle(prisma);
  assert.equal(clean.findings.filter((f) => f.check !== 'partner').length, 0);
});
