/**
 * J13-4 — when a P2P payment WITHOUT an instructionRef (an older client) may still execute.
 *
 * Target policy (approved): every payment carries a server-issued instructionRef. Older clients get a
 * TEMPORARY compatibility path, and only when the server can independently verify the exact intended
 * recipient; otherwise they fail closed with 426 update_required. There is no permanent exemption:
 *
 *   - COMPAT_SUNSET is a hard date in code. After it the compatibility path is closed for every client.
 *   - RECIPIENT_BINDING_ENFORCE=true closes it EARLIER (rollback-safe switch). No setting can extend it.
 *
 * Independent verification available to the server for a legacy request (it carries only a handle):
 *   (a) chat payment: a DIRECT thread whose two members are exactly the sender and the recipient — the
 *       membership was established by account id before this request, so the handle cannot have been
 *       re-pointed at someone else inside that conversation;
 *   (b) otherwise: the handle has NOT changed owner within LEGACY_HANDLE_STABILITY_MS (HandleRelease log).
 *       If no one released this handle recently, whoever the legacy client looked up is still its holder.
 *       A handle released recently → the server cannot tell who was meant → fail closed.
 */
export const COMPAT_SUNSET = new Date('2027-01-11T00:00:00.000Z');
export const LEGACY_HANDLE_STABILITY_MS = 30 * 24 * 3600_000;

export function recipientBindingMode(now = new Date()) {
  if (process.env.RECIPIENT_BINDING_ENFORCE === 'true') return 'enforce';
  if (now >= COMPAT_SUNSET) return 'enforce';
  return 'compat';
}

export const UPDATE_REQUIRED = {
  status: 426,
  body: {
    error: 'Mets à jour l’application K21 pour envoyer de l’argent. Aucun argent n’a été envoyé.',
    code: 'update_required',
    category: 'update_required',
  },
};

/**
 * @returns {Promise<{ ok: true, basis: 'direct_thread'|'stable_handle' } | { ok: false, reason: string }>}
 */
export async function verifyLegacyRecipient(db, { sender, recipient, handle, threadId, now = new Date() }) {
  if (recipientBindingMode(now) === 'enforce') return { ok: false, reason: 'enforced' };
  if (threadId) {
    const thread = await db.mboloThread.findUnique({ where: { id: threadId }, select: { type: true, members: { select: { userId: true } } } });
    const ids = (thread?.members ?? []).map((m) => m.userId).sort();
    const pair = [sender.id, recipient.id].sort();
    if (thread?.type === 'direct' && ids.length === 2 && ids[0] === pair[0] && ids[1] === pair[1]) return { ok: true, basis: 'direct_thread' };
    return { ok: false, reason: 'thread_not_direct_pair' };
  }
  const norm = String(handle ?? '').replace(/^@/, '').toLowerCase();
  const recent = await db.handleRelease.findFirst({
    where: { handle: norm, releasedAt: { gt: new Date(now.getTime() - LEGACY_HANDLE_STABILITY_MS) } },
    select: { id: true },
  });
  if (recent) return { ok: false, reason: 'handle_recently_reassigned' };
  return { ok: true, basis: 'stable_handle' };
}
