/**
 * J5 gate finding: the first-ever concurrent sales of a NEW business raced to
 * create its wallet row (unique businessId) and primary location; the loser
 * got HTTP 500 and a second "primary" location could appear. Every trial is a
 * fresh business; no retries.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../helpers/db.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';
import { ensurePrimaryLocation } from '../../lib/business/identity.js';
import { business, customer } from '../j3/helpers.js';

after(async () => { await prisma.$disconnect(); });

test('concurrent first wallet / primary-location creation for a new business: no error, exactly one of each', async () => {
  for (let i = 0; i < 15; i++) {
    const owner = await customer();
    const b = await business(owner.user);
    const results = await Promise.allSettled([
      ...Array.from({ length: 6 }, () => ensureBusinessWallet(b.id, prisma)),
      ...Array.from({ length: 6 }, () => ensurePrimaryLocation(b.id)),
      prisma.$transaction((tx) => ensureBusinessWallet(b.id, tx)),
    ]);
    assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message).slice(-160)), []);
    assert.equal(await prisma.businessWallet.count({ where: { businessId: b.id } }), 1);
    assert.equal(await prisma.businessLocation.count({ where: { businessId: b.id, isPrimary: true } }), 1);
  }
});
