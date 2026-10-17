/**
 * J15 — found by the L6 soak (attempt 4: the end-of-run audit could not finish). Every "did my payment go through?"
 * lookup (intent outcome, void, 5xx / crash recovery, stale-intent release) finds journal entries by the client's key
 * (metadata.clientKey). The JSON-path filter scanned the whole journal on every call: 37 ms at 171 k entries, linear in
 * the journal. The partial expression index (migration 20261031000000) serves it — only if the query matches it, which
 * is what this test pins: the module's own lookup, with sequential scans disabled, must not scan the journal.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { fundUser, prisma } from '../helpers/db.js';
import { entriesForClientKey } from '../../lib/api-idempotency.js';
import { runWithRequestContext } from '../../lib/request-context.js';
import { customer } from '../j3/helpers.js';

after(async () => { await prisma.$disconnect(); });

test('the index exists, partial on entries that carry a client key', async () => {
  const [ix] = await prisma.$queryRaw`SELECT indexdef FROM pg_indexes WHERE indexname = 'JournalEntry_clientKey_idx'`;
  assert.ok(ix, 'migration 20261031000000 applied');
  assert.match(ix.indexdef, /metadata ->> 'clientKey'/);
  assert.match(ix.indexdef, /WHERE \(metadata \? 'clientKey'::text\)/);
});

test('entriesForClientKey finds exactly the entries booked under the key, through the index, never a journal scan', async () => {
  const u = await customer({ koriBalance: 0 });
  const key = `${u.id}:lab-${crypto.randomBytes(8).toString('hex')}`;
  await runWithRequestContext({ clientKey: key }, () => fundUser(u.id, 700));
  await fundUser(u.id, 300); // same user, no key: must not be returned

  const plain = await entriesForClientKey(key);
  assert.equal(plain.length, 1);
  assert.equal(typeof plain[0].reference, 'string');
  assert.deepEqual(await entriesForClientKey(`${u.id}:lab-none`), []);

  const scans = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    const rows = await entriesForClientKey(key, tx);
    assert.equal(rows.length, 1);
    const [s] = await tx.$queryRaw`SELECT seq_scan::int AS seq, idx_scan::int AS idx FROM pg_stat_xact_user_tables WHERE relname = 'JournalEntry'`;
    return s;
  });
  assert.equal(scans.seq, 0, 'the client-key lookup scanned the whole journal');
  assert.ok(scans.idx >= 1);
});
