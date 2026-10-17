import { prisma } from './prisma.js';
import { assessTransactionRisk, nationalAmountForOperation } from './risk-engine.js';
import { createHeldTransaction, heldResponseShape } from './held-transaction-service.js';
import { reference } from '../api/_lib/auth.js';

/**
 * Evaluate risk and either hold (202) or proceed with execute().
 * `res` is used to send 202 when held.
 */
export async function gateOrExecute(req, res, options, execute) {
  const { operationType, amountNational, recipientHandle, recipientId, payload, forceHold } =
    options;

  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
  const ref = payload.reference ?? reference('TXN');

  const assessment = await assessTransactionRisk(prisma, {
    userId: req.userId,
    req,
    operationType,
    amountNational,
    recipientHandle,
    recipientId,
    // J3: the central cash-out guard routes "review" signals here.
    forceHold: forceHold || Boolean(req.riskReview),
    hasNationalDepositProof: options.hasNationalDepositProof,
    payload,
  });

  if (assessment.hold) {
    const held = await createHeldTransaction(prisma, {
      userId: req.userId,
      operationType,
      amountNational,
      payload: { ...payload, operationType },
      flags: assessment.flags,
      reasons: assessment.reasons,
      ref,
    });
    res.status(202).json(heldResponseShape(held));
    return { held: true };
  }

  const result = await execute(ref);
  return { held: false, result };
}

export { nationalAmountForOperation };
