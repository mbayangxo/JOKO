/**
 * J14-F1 (S4) HTTP. Partner: request / read / cancel its own debit instructions (scopes partner.debits.*).
 * Business (Jokko app): list, detail with every recipient, approve (business.pay + FRESH step-up + matching
 * detailsHash), reject. Dormant unless PARTNER_DEBIT_INSTRUCTIONS_ENABLED=true.
 */
import { assertStepUp } from '../step-up.js';
import {
  PartnerDebitError, approveBusinessDebit, businessDebitDetail, cancelPartnerDebit, createPartnerDebit, getPartnerDebit,
  listBusinessDebits, rejectBusinessDebit,
} from './partner-debits.js';

async function partner(req, res) {
  const { requirePartner } = await import('../partner-handlers.js');
  return requirePartner(req, res);
}
function fail(res, e) {
  if (e instanceof PartnerDebitError) {
    res.status(e.status).json({ error: e.message, code: e.code, ...(e.problems ? { problems: e.problems } : {}), ...(e.reasons ? { reasons: e.reasons } : {}) });
    return true;
  }
  if (e?.name === 'StepUpRequiredError') {
    res.status(e.status ?? 403).json({ error: e.message, code: e.code ?? 'step_up_required', reason: e.reason });
    return true;
  }
  return false;
}
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
};

export const partnerDebitCreate = wrap(async (req, res) => {
  if (!(await partner(req, res))) return;
  const r = await createPartnerDebit(req.partnerId, req.body ?? {});
  res.status(r.created ? 201 : 200).json(r.instruction);
});
export const partnerDebitGet = wrap(async (req, res) => {
  if (!(await partner(req, res))) return;
  res.json(await getPartnerDebit(req.partnerId, req.query.id));
});
export const partnerDebitCancel = wrap(async (req, res) => {
  if (!(await partner(req, res))) return;
  res.json(await cancelPartnerDebit(req.partnerId, req.query.id));
});

export const businessDebitsList = wrap(async (req, res) => {
  res.json({ instructions: await listBusinessDebits(req.userId, String(req.query.id), { status: req.query.status }) });
});
export const businessDebitGet = wrap(async (req, res) => {
  res.json(await businessDebitDetail(req.userId, String(req.query.id), String(req.query.subId)));
});
export const businessDebitApprove = wrap(async (req, res) => {
  await assertStepUp(req, 'partner_debit_approval'); // fresh authentication on EVERY approval
  res.json(await approveBusinessDebit(req.userId, String(req.query.id), String(req.query.subId), { detailsHash: req.body?.detailsHash }));
});
export const businessDebitReject = wrap(async (req, res) => {
  res.json(await rejectBusinessDebit(req.userId, String(req.query.id), String(req.query.subId), { reason: req.body?.reason }));
});
