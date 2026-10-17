import { z } from 'zod';
import { InsufficientFundsError, isMoneyError, moneyErrorStatus } from './wallet-atomic.js';
import { prisma } from './prisma.js';
import {
  AgentError,
  agentErrorStatus,
  agentShape,
  getAgentByUserId,
  getAgentDepositByReference,
  getAgentWithdrawByReference,
  listAgentFloatEntries,
  requireActiveAgent,
  updateAgentLocation,
  getAgentApplication,
  requestAgentFloatTopUp,
  getMyFloatTopUpRequests,
} from './agent-service.js';
import { getAgentPayoutHistory, previewAgentPayout } from './agent-payout-service.js';
import {
  createStripeDepositSession,
  getStripeDepositStatus,
  settleStripeDepositFromSession,
  stripeConfigured,
  verifyStripeWebhook,
} from './stripe-service.js';
import { validationError } from './validation.js';
import { clientErrorMessage } from './log-redact.js';

function handleAgentError(res, error) {
  if (error instanceof AgentError) {
    res.status(agentErrorStatus(error)).json({ error: error.message, code: error.code });
    return true;
  }
  // A money refusal inside an agent operation (e.g. the customer's balance no
  // longer covers a pending withdrawal QR) is a clean 4xx — the transaction
  // rolled back, nothing moved. It was an HTTP 500 before (J5 sweep finding).
  if (isMoneyError(error)) {
    const insufficient = error instanceof InsufficientFundsError;
    res.status(moneyErrorStatus(error)).json({
      error: insufficient ? 'Solde du client insuffisant pour ce retrait — rien n’a été débité.' : error.message,
      code: insufficient ? 'customer_insufficient_funds' : error.code ?? 'money_refused',
    });
    return true;
  }
  return false;
}

export async function depositAgentStatus(req, res) {
  const ref = req.query?.reference ?? req.query?.id ?? req.params?.reference;
  if (!ref) return res.status(400).json({ error: 'Reference required' });

  const deposit = await getAgentDepositByReference(ref, req.userId);
  if (!deposit) return res.status(404).json({ error: 'Not found' });
  res.json(deposit);
}

export async function withdrawAgentStatus(req, res) {
  const ref = req.query?.reference ?? req.query?.id ?? req.params?.reference;
  if (!ref) return res.status(400).json({ error: 'Reference required' });

  const withdrawal = await getAgentWithdrawByReference(ref, req.userId);
  if (!withdrawal) return res.status(404).json({ error: 'Not found' });
  res.json(withdrawal);
}

export async function depositCardSession(req, res) {
  if (!stripeConfigured()) {
    return res.status(503).json({ error: 'Dépôt carte indisponible', code: 'stripe_disabled' });
  }

  const schema = z.object({ amount: z.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const session = await createStripeDepositSession(req.userId, parsed.data.amount);
    res.status(201).json(session);
  } catch (error) {
    res.status(400).json({ error: clientErrorMessage(error, 'Stripe session failed') });
  }
}

export async function depositCardStatus(req, res) {
  const ref = req.query?.reference ?? req.query?.id ?? req.params?.reference;
  if (!ref) return res.status(400).json({ error: 'Reference required' });

  const deposit = await getStripeDepositStatus(ref, req.userId);
  if (!deposit) return res.status(404).json({ error: 'Not found' });
  res.json(deposit);
}

export async function webhooksStripe(req, res) {
  if (!stripeConfigured()) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  const rawBody = req.rawBody ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = verifyStripeWebhook(rawBody, signature);
  } catch (error) {
    return res.status(400).json({ error: `Webhook signature failed: ${error.message}` });
  }
  if (!event) {
    return res.status(503).json({ error: 'STRIPE_WEBHOOK_SECRET not configured' });
  }

  if (event.type === 'checkout.session.completed') {
    const result = await settleStripeDepositFromSession(event.data.object);
    return res.json({ received: true, ...result });
  }

  res.json({ received: true, handled: false, type: event.type });
}

export async function agentMe(req, res) {
  try {
    const agent = await requireActiveAgent(req.userId);
    const entries = await listAgentFloatEntries(agent.id, 20);
    res.json({
      agent: agentShape(agent),
      recentFloatEntries: entries.map((e) => ({
        id: e.id,
        type: e.type,
        amountXof: e.amountXof,
        balanceAfter: e.balanceAfter,
        reference: e.reference,
        note: e.note,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    if (handleAgentError(res, error)) return;
    throw error;
  }
}

export async function agentApplication(req, res) {
  const application = await getAgentApplication(req.userId);
  if (!application) {
    res.json({ application: null, message: 'Aucune demande agent' });
    return;
  }
  res.json({ application });
}

export async function agentFloatTopUpRequestCreate(req, res) {
  const schema = z.object({
    amountXof: z.number().int().positive(),
    note: z.string().max(200).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const request = await requestAgentFloatTopUp(req.userId, parsed.data.amountXof, parsed.data.note);
    res.status(201).json({ request });
  } catch (error) {
    if (handleAgentError(res, error)) return;
    throw error;
  }
}

export async function agentFloatTopUpRequestsMine(req, res) {
  const requests = await getMyFloatTopUpRequests(req.userId);
  res.json({ requests });
}

export async function agentUpdateLocation(req, res) {
  const schema = z.object({
    locationLabel: z.string().max(120).optional(),
    arrondissement: z.string().max(40).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const agent = await updateAgentLocation(req.userId, parsed.data);
    res.json({ agent });
  } catch (error) {
    if (handleAgentError(res, error)) return;
    throw error;
  }
}

export async function agentPayouts(req, res) {
  const agent = await getAgentByUserId(req.userId);
  if (!agent) {
    res.status(403).json({ error: 'Pas agent K21', code: 'not_agent' });
    return;
  }
  const [history, preview] = await Promise.all([
    getAgentPayoutHistory(agent.id),
    previewAgentPayout(agent.id),
  ]);
  res.json({
    history,
    currentMonthPreview: preview,
    terms: {
      flatFeeXof: agent.monthlyFlatFeeXof,
      volumeBonusBps: agent.volumeBonusBps,
      minVolumeForFlatFee: 100_000,
      note: 'Payé le 1er de chaque mois sur ton portefeuille K21.',
    },
  });
}
