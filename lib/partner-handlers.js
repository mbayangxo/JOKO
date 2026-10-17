import { z } from 'zod';
import {
  authenticatePartner,
  partnerAuthConfigured,
} from './partner-auth.js';
import {
  PartnerPaymentError,
  assertCheckoutAccess,
  confirmPartnerCheckout,
  createPartnerPayment,
  getPartnerPaymentByReference,
  paymentShape,
  sandboxCompletePartnerPayment,
} from './partner-payments-service.js';
import { PartnerMessageError, sendPartnerMessage } from './partner-messages-service.js';
import {
  createPartnerPayout,
  executePartnerPayout,
  getPartnerPayoutByReference,
  payoutShape,
  sandboxCompletePartnerPayout,
} from './partner-payouts-service.js';
import {
  PartnerSupportError,
  agentShape,
  assignSupportThread,
  listSupportAgents,
  listSupportThreads,
  openSupportThread,
  postSupportMessage,
  registerSupportAgent,
  threadShape,
} from './partner-support-service.js';

function partnerError(res, err) {
  if (
    err instanceof PartnerPaymentError ||
    err instanceof PartnerMessageError ||
    err instanceof PartnerSupportError
  ) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return true;
  }
  if (err?.code === 'rate_limited') {
    res.status(429).json({ error: err.message, code: 'rate_limited' });
    return true;
  }
  return false;
}

/** Attach partner auth or 401. */
export async function requirePartner(req, res) {
  // J14-S6: already authenticated, scoped and rate-limited centrally (PARTNER_SCOPED_KEYS_ENABLED).
  if (req.partnerAuth) {
    req.partnerId = req.partnerAuth.partnerId;
    return req.partnerAuth;
  }
  if (!partnerAuthConfigured()) {
    res.status(503).json({
      error: 'Partner API not configured — set JOKO_API_KEY (and JOKO_WEBHOOK_SECRET).',
      code: 'partner_auth_not_configured',
    });
    return null;
  }
  const auth = authenticatePartner(req);
  if (!auth) {
    res.status(401).json({ error: 'Invalid or missing partner API key', code: 'unauthorized' });
    return null;
  }
  // J15-D3: shared atomic per-partner limit (all instances); money routes fail closed when it is unavailable.
  const { enforcePartnerLimits } = await import('./integrations/partner-rate-limit.js');
  const lim = await enforcePartnerLimits({ partnerId: auth.partnerId, perm: req.routePolicy?.perm ?? null });
  if (!lim.ok) {
    res.status(lim.status).json(lim.body);
    return null;
  }
  req.partnerId = auth.partnerId;
  return auth;
}

export async function partnerCheckoutSessions(req, res) {
  if (!(await requirePartner(req, res))) return;
  try {
    const { payment, created } = await createPartnerPayment(req.partnerId, req.body ?? {});
    res.status(created ? 201 : 200).json(paymentShape(payment));
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

export async function partnerPaymentsCollect(req, res) {
  if (!(await requirePartner(req, res))) return;
  try {
    const body = { ...(req.body ?? {}) };
    if (!body.customer && body.phone) body.customer = { phone: body.phone };
    if (!body.phone && body.customer?.phone) {
      /* ok */
    } else if (!body.customer?.phone && !body.phone) {
      res.status(400).json({ error: 'phone required for collect', code: 'phone_required' });
      return;
    }
    const { payment, created } = await createPartnerPayment(req.partnerId, body);
    // Hosted URL always returned; buyer completes on phone / hosted page.
    res.status(created ? 201 : 200).json({
      ...paymentShape(payment),
      note:
        'checkout_url/payment_url opens Joko hosted pay. Mobile money is push-to-phone after the buyer confirms; in sandbox call POST /api/v1/payments/:reference/sandbox-complete.',
    });
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

export async function partnerPaymentGet(req, res) {
  if (!(await requirePartner(req, res))) return;
  const reference = req.query.reference ?? req.query.id;
  if (!reference) {
    res.status(400).json({ error: 'reference required' });
    return;
  }
  try {
    const payment = await getPartnerPaymentByReference(req.partnerId, reference);
    if (!payment) {
      res.status(404).json({ error: 'Payment not found', code: 'not_found' });
      return;
    }
    res.json(paymentShape(payment));
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

export async function partnerPaymentSandboxComplete(req, res) {
  if (!(await requirePartner(req, res))) return;
  const reference = req.query.reference ?? req.body?.reference;
  if (!reference) {
    res.status(400).json({ error: 'reference required' });
    return;
  }
  try {
    const payment = await sandboxCompletePartnerPayment(req.partnerId, reference);
    res.json(paymentShape(payment));
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

export async function partnerMessagesSend(req, res) {
  if (!(await requirePartner(req, res))) return;
  try {
    const idempotencyKey =
      req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'] ?? req.body?.idempotency_key;
    const result = await sendPartnerMessage(req.partnerId, req.body ?? {}, {
      idempotencyKey: idempotencyKey ? String(idempotencyKey).slice(0, 120) : undefined,
    });
    res.status(result.status === 'failed' ? 200 : 200).json(result);
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Public hosted checkout page (buyer-facing). */
export async function partnerPayPage(req, res) {
  const id = req.query.id;
  const token = req.query.token;
  try {
    const payment = await assertCheckoutAccess(id, token);
    const amount = payment.amountXof.toLocaleString('fr-FR');
    const done = payment.status === 'completed';
    const phoneVal = escapeHtml(payment.phone ?? '');
    const desc = escapeHtml(payment.description ?? payment.reference);
    const returnUrl = payment.returnUrl ? escapeHtml(payment.returnUrl) : '';

    const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Joko — Paiement</title>
<style>
  :root{--ink:#0a120c;--green:#1af060;--paper:#f4faf2;--muted:#5a6b5e}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:linear-gradient(160deg,#0d1f0a,#14301a 40%,#0a120c);color:var(--paper);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:420px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:28px;backdrop-filter:blur(12px)}
  .brand{font-weight:800;letter-spacing:-.03em;font-size:22px;margin-bottom:4px}
  .brand span{color:var(--green)}
  .sub{color:rgba(255,255,255,.65);font-size:14px;margin-bottom:22px}
  .amt{font-size:36px;font-weight:800;letter-spacing:-.04em;margin:8px 0 4px}
  .amt small{font-size:16px;font-weight:600;opacity:.7}
  label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.08em;opacity:.7;margin:16px 0 6px}
  input,select{width:100%;padding:14px 16px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.25);color:#fff;font-size:16px}
  button{margin-top:20px;width:100%;padding:14px;border:0;border-radius:999px;background:var(--green);color:#041006;font-weight:800;font-size:15px;cursor:pointer}
  button:disabled{opacity:.5;cursor:not-allowed}
  .ok{background:rgba(26,240,96,.12);border:1px solid rgba(26,240,96,.35);padding:14px;border-radius:12px;margin-top:12px}
  .err{color:#ff8f6b;font-size:13px;margin-top:10px;min-height:1.2em}
  .hint{font-size:12px;opacity:.55;margin-top:14px;line-height:1.4}
</style>
</head>
<body>
  <div class="card">
    <div class="brand"><span>Joko</span> Pay</div>
    <div class="sub">${desc}</div>
    <div class="amt">${amount} <small>XOF</small></div>
    ${
      done
        ? `<div class="ok">Paiement confirmé. ${returnUrl ? `<a href="${returnUrl}" style="color:var(--green)">Retour à la boutique →</a>` : ''}</div>`
        : `<form id="f">
      <label>Téléphone Mobile Money</label>
      <input id="phone" name="phone" type="tel" placeholder="+22177…" value="${phoneVal}" required />
      <label>Opérateur</label>
      <select id="method" name="method">
        <option value="auto">Auto</option>
        <option value="wave">Wave</option>
        <option value="orange_money">Orange Money</option>
        <option value="free_money">Free Money</option>
      </select>
      <button type="submit" id="btn">Payer avec Joko</button>
      <div class="err" id="err"></div>
      <p class="hint">Tu recevras une demande sur ton téléphone (Wave / Orange / Free). En sandbox, le marchand finalise via l’API.</p>
    </form>`
    }
  </div>
  ${
    done
      ? ''
      : `<script>
  const f=document.getElementById('f');
  f.addEventListener('submit',async(e)=>{
    e.preventDefault();
    const btn=document.getElementById('btn');
    const err=document.getElementById('err');
    err.textContent='';
    btn.disabled=true;
    try{
      const res=await fetch('/api/v1/pay/${escapeHtml(payment.id)}/confirm?token=${escapeHtml(payment.checkoutToken)}',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({phone:document.getElementById('phone').value,method:document.getElementById('method').value})
      });
      const data=await res.json().catch(()=>({}));
      if(!res.ok){err.textContent=data.error||'Échec';btn.disabled=false;return;}
      if(data.status==='completed' && data.return_url){location.href=data.return_url;return;}
      location.reload();
    }catch(x){err.textContent='Réseau indisponible';btn.disabled=false;}
  });
</script>`
  }
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(html);
  } catch (err) {
    if (err instanceof PartnerPaymentError) {
      res.status(err.status).send(`<!doctype html><p>${escapeHtml(err.message)}</p>`);
      return;
    }
    throw err;
  }
}

export async function partnerPayConfirm(req, res) {
  const id = req.query.id;
  const token = req.query.token ?? req.body?.token;
  const schema = z.object({
    phone: z.string().min(8).max(20),
    method: z.enum(['wave', 'orange_money', 'free_money', 'auto']).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'phone required' });
    return;
  }
  try {
    const payment = await confirmPartnerCheckout(id, token, parsed.data);
    res.json(paymentShape(payment));
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

/** Slice 2 — in-store POS: merchant enters amount, customer scans QR / opens payment_url. */
export async function partnerPosSessions(req, res) {
  if (!(await requirePartner(req, res))) return;
  try {
    const body = {
      ...(req.body ?? {}),
      channel: 'pos',
      metadata: {
        channel: 'pos',
        kind: 'pos',
        ...((req.body ?? {}).metadata ?? {}),
      },
    };
    if (!body.reference) {
      body.reference = `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
    // Phone optional at create — customer enters on hosted page / phone MM
    const { payment, created } = await createPartnerPayment(req.partnerId, body);
    const shape = paymentShape(payment);
    res.status(created ? 201 : 200).json({
      ...shape,
      terminal: {
        display_amount_xof: shape.amount_xof,
        qr_payload: shape.qr_payload,
        instructions:
          'Show QR or open payment_url on the customer phone. Customer confirms MM operator + phone, then approves the push.',
      },
    });
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

export async function partnerPosGet(req, res) {
  return partnerPaymentGet(req, res);
}

/** Slice 3 — partner payouts. */
export async function partnerPayoutsCreate(req, res) {
  if (!(await requirePartner(req, res))) return;
  try {
    const body = req.body ?? {};
    const { payout, created } = await createPartnerPayout(req.partnerId, body);
    let result = payout;
    if (body.execute === true || body.execute === 'true') {
      result = await executePartnerPayout(req.partnerId, payout.reference);
    }
    res.status(created ? 201 : 200).json(payoutShape(result));
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

export async function partnerPayoutGet(req, res) {
  if (!(await requirePartner(req, res))) return;
  const reference = req.query.reference ?? req.query.id;
  if (!reference) {
    res.status(400).json({ error: 'reference required' });
    return;
  }
  try {
    const payout = await getPartnerPayoutByReference(req.partnerId, reference);
    if (!payout) {
      res.status(404).json({ error: 'Payout not found', code: 'not_found' });
      return;
    }
    res.json(payoutShape(payout));
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

export async function partnerPayoutSandboxComplete(req, res) {
  if (!(await requirePartner(req, res))) return;
  const reference = req.query.reference ?? req.body?.reference;
  if (!reference) {
    res.status(400).json({ error: 'reference required' });
    return;
  }
  try {
    const payout = await sandboxCompletePartnerPayout(req.partnerId, reference);
    res.json(payoutShape(payout));
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

/** Slice 4 — Mbolo Business CS. */
export async function partnerSupportAgentsCreate(req, res) {
  if (!(await requirePartner(req, res))) return;
  try {
    const { agent, created } = await registerSupportAgent(req.partnerId, req.body ?? {});
    res.status(created ? 201 : 200).json(agentShape(agent));
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

export async function partnerSupportAgentsList(req, res) {
  if (!(await requirePartner(req, res))) return;
  try {
    const agents = await listSupportAgents(req.partnerId, {
      shopExternalId: req.query.shop_external_id,
    });
    res.json({ agents: agents.map(agentShape) });
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

export async function partnerSupportThreadsCreate(req, res) {
  if (!(await requirePartner(req, res))) return;
  try {
    const { thread, created } = await openSupportThread(req.partnerId, req.body ?? {});
    res.status(created ? 201 : 200).json(threadShape(thread));
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

export async function partnerSupportThreadsList(req, res) {
  if (!(await requirePartner(req, res))) return;
  try {
    const threads = await listSupportThreads(req.partnerId, {
      status: req.query.status,
      shopExternalId: req.query.shop_external_id,
    });
    res.json({ threads: threads.map(threadShape) });
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

export async function partnerSupportThreadAssign(req, res) {
  if (!(await requirePartner(req, res))) return;
  const threadId = req.query.id;
  const agentId = req.body?.agent_id;
  if (!threadId || !agentId) {
    res.status(400).json({ error: 'thread id and agent_id required' });
    return;
  }
  try {
    const thread = await assignSupportThread(req.partnerId, threadId, agentId);
    res.json(threadShape(thread));
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}

export async function partnerSupportThreadMessage(req, res) {
  if (!(await requirePartner(req, res))) return;
  const threadId = req.query.id;
  if (!threadId) {
    res.status(400).json({ error: 'thread id required' });
    return;
  }
  try {
    const result = await postSupportMessage(req.partnerId, threadId, req.body ?? {});
    res.status(201).json(result);
  } catch (err) {
    if (partnerError(res, err)) return;
    throw err;
  }
}
