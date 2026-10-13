import { z } from 'zod';
import { prisma } from './prisma.js';
import { validationError } from './validation.js';
import {
  createPaymentFund,
  createScheduledPayment,
  fundPaymentPot,
  withdrawPaymentFund,
  listPaymentFunds,
  listScheduledPayments,
  ScheduledPaymentError,
  toggleScheduledPayment,
} from './scheduled-payment-service.js';

function errStatus(code) {
  if (code === 'not_found') return 404;
  if (code === 'forbidden') return 403;
  return 400;
}

export async function paymentFundsList(req, res) {
  const funds = await listPaymentFunds(prisma, req.userId);
  res.json({ funds });
}

export async function paymentFundsCreate(req, res) {
  const schema = z.object({
    name: z.string().min(2).max(80),
    targetKori: z.number().int().positive().optional(),
    category: z.enum(['food', 'grocery', 'school', 'rent', 'other']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const fund = await createPaymentFund(prisma, { userId: req.userId, ...parsed.data });
  res.status(201).json(fund);
}

export async function paymentFundFund(req, res) {
  const fundId = String(req.query.id ?? '');
  if (!fundId) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  const schema = z.object({ amountKori: z.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    const fund = await fundPaymentPot(prisma, {
      userId: req.userId,
      fundId,
      amountKori: parsed.data.amountKori,
    });
    res.json(fund);
  } catch (error) {
    if (error instanceof ScheduledPaymentError) {
      res.status(errStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    if (error.name === 'InsufficientFundsError') {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function paymentFundWithdraw(req, res) {
  const fundId = String(req.query.id ?? '');
  if (!fundId) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  const schema = z.object({ amountKori: z.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    const fund = await withdrawPaymentFund(prisma, {
      userId: req.userId,
      fundId,
      amountKori: parsed.data.amountKori,
    });
    res.json(fund);
  } catch (error) {
    if (error instanceof ScheduledPaymentError) {
      res.status(errStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    if (error.name === 'InsufficientFundsError') {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function scheduledPaymentsList(req, res) {
  const rows = await listScheduledPayments(prisma, req.userId);
  res.json({ schedules: rows });
}

export async function scheduledPaymentsCreate(req, res) {
  const schema = z
    .object({
      kind: z.enum(['send', 'save']).default('send'),
      recipientHandle: z.string().min(3).optional(),
      recipientRef: z.string().max(1024).optional(), // J14-S0: the account confirmed on screen
      amountKori: z.number().int().positive(),
      note: z.string().max(500).optional(),
      scheduleType: z.enum(['weekly', 'monthly']),
      scheduleDay: z.number().int().min(0).max(28),
      fundId: z.string().optional(),
    })
    .superRefine((data, ctx) => {
      if (data.kind === 'send' && !data.recipientHandle) {
        ctx.addIssue({ code: 'custom', message: 'Destinataire requis', path: ['recipientHandle'] });
      }
      if (data.kind === 'save' && !data.fundId) {
        ctx.addIssue({ code: 'custom', message: 'Fonds requis', path: ['fundId'] });
      }
    });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    const row = await createScheduledPayment(prisma, { userId: req.userId, ...parsed.data });
    res.status(201).json(row);
  } catch (error) {
    if (error?.code === 'update_required') {
      res.status(426).json({ error: error.message, code: 'update_required', category: 'update_required', reason: error.reason ?? null });
      return;
    }
    if (['recipient_changed', 'expired', 'cross_account', 'forged', 'confirmation_required'].includes(error?.code) && !(error instanceof ScheduledPaymentError)) {
      res.status(error.code === 'confirmation_required' ? 428 : 409).json({ error: error.message, code: error.code, category: 'recipient_changed' });
      return;
    }
    if (error instanceof ScheduledPaymentError) {
      res.status(errStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function scheduledPaymentPatch(req, res) {
  const scheduleId = String(req.query.id ?? '');
  if (!scheduleId) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  const schema = z.object({ active: z.boolean() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    const row = await toggleScheduledPayment(prisma, {
      userId: req.userId,
      scheduleId,
      active: parsed.data.active,
    });
    res.json(row);
  } catch (error) {
    if (error instanceof ScheduledPaymentError) {
      res.status(errStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}
