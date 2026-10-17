import { AccessToken } from 'livekit-server-sdk';
import { prisma } from './prisma.js';

/**
 * Voice/video calls in Mboolo — powered by a self-hosted LiveKit server.
 * The API only mints short-lived room tokens; all media flows through the
 * LiveKit server (LIVEKIT_URL), never through Vercel. One room per Mboolo
 * thread, so a call is always scoped to an existing conversation and only
 * thread members can get a token.
 *
 * Env (see docs/K21-CALLS-LIVEKIT.md):
 *   LIVEKIT_URL        wss://calls.example.com
 *   LIVEKIT_API_KEY    from livekit-server keys
 *   LIVEKIT_API_SECRET from livekit-server keys
 */

export class CallError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.name = 'CallError';
    this.status = status;
  }
}

export function callsConfigured() {
  return Boolean(
    process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET,
  );
}

const TOKEN_TTL_SECONDS = 60 * 60; // one call session

export async function mintCallToken(userId, threadId) {
  if (!callsConfigured()) {
    throw new CallError(
      'calls_unavailable',
      'Les appels ne sont pas encore activés sur ce serveur. L’admin doit configurer LiveKit (voir docs/K21-CALLS-LIVEKIT.md).',
      503,
    );
  }

  const member = await prisma.mboloMember.findUnique({
    where: { threadId_userId: { threadId: String(threadId ?? ''), userId } },
  });
  if (!member || member.status !== 'active') throw new CallError('not_a_member', 'Conversation introuvable.', 403);
  // No ringing a stranger whose message request is still pending.
  const pending = await prisma.mboloMember.count({ where: { threadId: member.threadId, status: { not: 'active' } } });
  const thread = await prisma.mboloThread.findUnique({ where: { id: member.threadId }, select: { type: true } });
  if (pending > 0 && thread?.type === 'direct') {
    throw new CallError('request_pending', 'Attends que ta demande de message soit acceptée.', 403);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, handle: true },
  });

  const room = `mbolo-${threadId}`;
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: userId,
    name: user?.name || user?.handle || 'Membre K21',
    ttl: `${TOKEN_TTL_SECONDS}s`,
  });
  at.addGrant({
    room,
    roomJoin: true,
    roomCreate: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const token = await at.toJwt();
  return { url: process.env.LIVEKIT_URL, token, room };
}
