import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { transfersSend } from '../../lib/handlers.js';
import {
  approveHeldTransaction,
  rejectHeldTransaction,
} from '../../lib/held-transaction-service.js';
import { createUserWithWallet, mockReq, mockRes, prisma } from '../helpers/db.js';

after(() => prisma.$disconnect());

async function attemptSend(sender, recipient, amount) {
  // No verified device → risk engine holds the transaction.
  const req = mockReq({
    userId: sender.id,
    headers: { 'x-device-id': 'brand-new-unseen-device', 'x-vercel-ip-country': 'SN' },
    body: { recipientHandle: recipient.handle, amount, currency: 'national' },
  });
  const res = mockRes();
  await transfersSend(req, res);
  return res;
}

test('held → admin approve → funds move exactly once, user notified', async () => {
  const sender = await createUserWithWallet({ balance: 100_000 });
  const recipient = await createUserWithWallet({ balance: 0 });

  const res = await attemptSend(sender, recipient, 20_000);
  assert.equal(res.statusCode, 202);
  const heldId = res.body.heldTransactionId;

  // A fraud alert was raised for admins.
  assert.ok((await prisma.fraudAlert.count({ where: { heldTransactionId: heldId } })) > 0);

  const { held } = await approveHeldTransaction(heldId, 'admin-1', 'Verified by phone');
  assert.equal(held.status, 'approved');

  const senderWallet = await prisma.wallet.findUnique({ where: { id: sender.wallet.id } });
  const recipientWallet = await prisma.wallet.findUnique({ where: { id: recipient.wallet.id } });
  // J1: no unfunded +2 ₭ "earn" mint on sends (incentives are off until a funded pool exists).
  assert.equal(senderWallet.koriBalance, 98_000);
  assert.equal(recipientWallet.koriBalance, 2_000);

  // Approving again must fail — no double execution.
  await assert.rejects(approveHeldTransaction(heldId, 'admin-1'), (e) => e.code === 'invalid_state');

  const notes = await prisma.notification.findMany({ where: { userId: sender.id } });
  assert.ok(notes.some((n) => n.title === 'Transaction approuvée'));
});

test('held → admin reject → no money moves, user notified', async () => {
  const sender = await createUserWithWallet({ balance: 100_000 });
  const recipient = await createUserWithWallet({ balance: 0 });

  const res = await attemptSend(sender, recipient, 15_000);
  assert.equal(res.statusCode, 202);
  const heldId = res.body.heldTransactionId;

  const updated = await rejectHeldTransaction(heldId, 'admin-1', 'Could not verify identity');
  assert.equal(updated.status, 'rejected');

  const senderWallet = await prisma.wallet.findUnique({ where: { id: sender.wallet.id } });
  const recipientWallet = await prisma.wallet.findUnique({ where: { id: recipient.wallet.id } });
  assert.equal(senderWallet.koriBalance, 100_000, 'sender keeps their money on rejection');
  assert.equal(recipientWallet.koriBalance, 0);

  await assert.rejects(rejectHeldTransaction(heldId, 'admin-1'), (e) => e.code === 'invalid_state');
});
