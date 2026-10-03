import { z } from 'zod';
import { RECOVERY_COOL_OFF_MS } from './risk-engine.js';
import { prisma } from './prisma.js';
import {
  AgentError,
  agentErrorStatus,
  agentShape,
  agentDepositShape,
  agentWithdrawShape,
  confirmAgentDeposit,
  createAgentDepositSession,
  createAgentWithdrawSession,
  getAgentByUserId,
  getAgentDepositByReference,
  getAgentWithdrawByReference,
  listAgentFloatEntries,
  requireActiveAgent,
  scanAgentDeposit,
  scanAgentWithdraw,
  confirmAgentWithdraw,
  applyForAgentProfile,
  listNearbyAgents,
  updateAgentLocation,
  getAgentApplication,
  approveAgentProfile,
  rejectAgentProfile,
  patchAgentProfile,
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
import { gateOrExecute } from './risk-gate.js';
import { walletShape } from './kori.js';
import { assertCanCashOut, recordDailyCashOut, TierLimitError } from './tier-service.js';
import { clientErrorMessage } from './log-redact.js';

function handleAgentError(res, error) {
  if (error instanceof AgentError) {
    res.status(agentErrorStatus(error)).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

export async function depositAgentCreate(req, res) {
  const schema = z.object({ amount: z.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const session = await createAgentDepositSession(req.userId, parsed.data.amount);
    res.status(201).json(session);
  } catch (error) {
    if (handleAgentError(res, error)) return;
    throw error;
  }
}

export async function depositAgentStatus(req, res) {
  const ref = req.query?.reference ?? req.query?.id ?? req.params?.reference;
  if (!ref) return res.status(400).json({ error: 'Reference required' });

  const deposit = await getAgentDepositByReference(ref, req.userId);
  if (!deposit) return res.status(404).json({ error: 'Not found' });
  res.json(deposit);
}

export async function withdrawAgentCreate(req, res) {
  const schema = z.object({ amount: z.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId },
      include: { wallet: true },
    });
    await assertCanCashOut(prisma, user, parsed.data.amount);
    // Same 24h post-recovery cool-off as every gated money movement.
    if (user.accountRecoveredAt && Date.now() - user.accountRecoveredAt.getTime() < RECOVERY_COOL_OFF_MS) {
      return res.status(403).json({
        error: 'Retraits suspendus 24 h après une récupération de compte, pour ta sécurité.',
        code: 'recent_recovery',
      });
    }
    const session = await createAgentWithdrawSession(req.userId, parsed.data.amount);
    res.status(201).json(session);
  } catch (error) {
    if (error instanceof TierLimitError) {
      return res.status(403).json({ error: error.message, code: 'tier_limit' });
    }
    if (handleAgentError(res, error)) return;
    throw error;
  }
}

export async function withdrawAgentStatus(req, res) {
  const ref = req.query?.reference ?? req.query?.id ?? req.params?.reference;
  if (!ref) return res.status(400).json({ error: 'Reference required' });

  const withdrawal = await getAgentWithdrawByReference(ref, req.userId);
  if (!withdrawal) return res.status(404).json({ error: 'Not found' });
  res.json(withdrawal);
}

export async function agentWithdrawScan(req, res) {
  const schema = z.object({
    token: z.string().min(8).optional(),
    qr: z.string().min(8).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const token = parsed.data.token ?? parsed.data.qr?.match(/agent-withdraw\/([^/?#]+)/i)?.[1] ?? parsed.data.qr;
  if (!token) return res.status(400).json({ error: 'Token or QR required' });

  try {
    const withdrawal = await scanAgentWithdraw(token.trim(), req.userId);
    res.json({ withdrawal });
  } catch (error) {
    if (handleAgentError(res, error)) return;
    throw error;
  }
}

export async function agentWithdrawConfirm(req, res) {
  const withdrawalId = req.query?.id ?? req.params?.id;
  if (!withdrawalId) return res.status(400).json({ error: 'Withdrawal id required' });

  try {
    const pending = await prisma.agentWithdrawal.findUnique({
      where: { id: withdrawalId },
      include: { user: { select: { id: true, name: true, phone: true, handle: true, verificationTier: true, country: true } } },
    });
    if (!pending || pending.status !== 'pending') {
      return res.status(404).json({ error: 'Retrait introuvable ou déjà traité', code: 'invalid_withdrawal' });
    }
    if (pending.expiresAt < new Date()) {
      return res.status(409).json({ error: 'QR expiré', code: 'expired' });
    }

    const gate = await gateOrExecute(
      req,
      res,
      {
        operationType: 'agent_withdraw',
        amountNational: pending.amountXof,
        payload: { withdrawalId, agentUserId: req.userId },
      },
      async () => {
        const result = await confirmAgentWithdraw(withdrawalId, req.userId);
        await recordDailyCashOut(prisma, pending.userId, pending.amountXof);
        const agent = await getAgentByUserId(req.userId);
        return {
          status: 201,
          body: {
            ok: true,
            withdrawal: result.withdrawal,
            wallet: result.wallet ? walletShape(result.wallet) : null,
            agent: agentShape({ ...agent, floatBalance: result.agentFloatBalance }),
            user: agentWithdrawShape(pending, pending.user).user,
          },
        };
      },
    );
    if (gate.held) return;
    res.status(gate.result.status).json(gate.result.body);
  } catch (error) {
    if (handleAgentError(res, error)) return;
    throw error;
  }
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

export async function agentDepositScan(req, res) {
  const schema = z.object({
    token: z.string().min(8).optional(),
    qr: z.string().min(8).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const token = parsed.data.token ?? parsed.data.qr?.match(/agent-deposit\/([^/?#]+)/i)?.[1] ?? parsed.data.qr;
  if (!token) return res.status(400).json({ error: 'Token or QR required' });

  try {
    const deposit = await scanAgentDeposit(token.trim(), req.userId);
    res.json({ deposit });
  } catch (error) {
    if (handleAgentError(res, error)) return;
    throw error;
  }
}

export async function agentDepositConfirm(req, res) {
  const depositId = req.query?.id ?? req.params?.id;
  if (!depositId) return res.status(400).json({ error: 'Deposit id required' });

  try {
    const pending = await prisma.agentDeposit.findUnique({
      where: { id: depositId },
      include: { user: { select: { id: true, name: true, phone: true, handle: true, verificationTier: true } } },
    });
    if (!pending || pending.status !== 'pending') {
      return res.status(404).json({ error: 'Dépôt introuvable ou déjà traité', code: 'invalid_deposit' });
    }
    if (pending.expiresAt < new Date()) {
      return res.status(409).json({ error: 'QR expiré', code: 'expired' });
    }

    const gate = await gateOrExecute(
      req,
      res,
      {
        operationType: 'agent_deposit',
        amountNational: pending.amountXof,
        recipientId: pending.userId,
        hasNationalDepositProof: true,
        payload: { depositId, agentUserId: req.userId },
      },
      async () => {
        const result = await confirmAgentDeposit(depositId, req.userId);
        const agent = await getAgentByUserId(req.userId);
        return {
          status: 201,
          body: {
            ok: true,
            deposit: result.deposit,
            wallet: result.wallet ? walletShape(result.wallet) : null,
            mint: result.mint,
            agent: agentShape({ ...agent, floatBalance: result.agentFloatBalance }),
            user: agentDepositShape(pending, pending.user).user,
          },
        };
      },
    );
    if (gate.held) return;
    res.status(gate.result.status).json(gate.result.body);
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

export async function agentApply(req, res) {
  const schema = z.object({
    displayName: z.string().min(2).max(80),
    locationLabel: z.string().max(120).optional(),
    arrondissement: z.string().max(40).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const agent = await applyForAgentProfile({
      userId: req.userId,
      displayName: parsed.data.displayName,
      locationLabel: parsed.data.locationLabel,
      arrondissement: parsed.data.arrondissement,
      lat: parsed.data.lat,
      lng: parsed.data.lng,
    });
    res.status(201).json({
      agent,
      message:
        agent.status === 'pending'
          ? 'Demande reçue — un admin activera ton float sous 48h.'
          : 'Profil agent K21 actif.',
    });
  } catch (error) {
    if (handleAgentError(res, error)) return;
    throw error;
  }
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

export async function agentsNearby(req, res) {
  const lat = req.query.lat != null ? Number(req.query.lat) : null;
  const lng = req.query.lng != null ? Number(req.query.lng) : null;
  const mode = req.query.mode === 'withdraw' ? 'withdraw' : 'deposit';
  const amountXof = req.query.amount != null ? Number(req.query.amount) : null;
  const agents = await listNearbyAgents(prisma, {
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    mode,
    amountXof: Number.isFinite(amountXof) ? amountXof : null,
  });
  res.json({ agents, mode, amountXof: Number.isFinite(amountXof) ? amountXof : null });
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
