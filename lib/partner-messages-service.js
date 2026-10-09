import { randomBytes } from 'node:crypto';
import { prisma } from './prisma.js';
import { canonicalPhone, phoneVariants } from './phone-normalize.js';
import { sendSms } from './sms-service.js';

export class PartnerMessageError extends Error {
  constructor(message, status = 400, code = 'invalid') {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'PartnerMessageError';
  }
}

function msgId() {
  return `msg_${randomBytes(12).toString('hex')}`;
}

async function findUserByPhone(phone) {
  const variants = phoneVariants(phone);
  if (!variants.length) return null;
  return prisma.user.findFirst({
    where: { phone: { in: variants } },
    select: { id: true, phone: true, handle: true, name: true },
  });
}

const PARTNER_MESSAGES_PER_RECIPIENT_DAY = 10;

async function deliverViaMbolo({ partnerId, recipientUserId, text, metadata }) {
  const systemUserId = process.env.PARTNER_MESSAGING_USER_ID?.trim() || process.env.PARTNER_SETTLEMENT_USER_ID?.trim();
  if (!systemUserId) {
    return { ok: false, reason: 'PARTNER_MESSAGING_USER_ID not configured' };
  }

  const system = await prisma.user.findUnique({ where: { id: systemUserId }, select: { id: true } });
  if (!system) return { ok: false, reason: 'messaging system user missing' };

  const commerceRef = `partner:${partnerId}:${recipientUserId}`;
  let thread = await prisma.mboloThread.findFirst({
    where: {
      type: 'partner',
      commerceType: 'partner_notify',
      commerceRefId: commerceRef,
    },
  });
  if (thread) {
    // J10-F2: the recipient's block of this partner thread is honoured, and a partner cannot flood one person.
    const member = await prisma.mboloMember.findUnique({ where: { threadId_userId: { threadId: thread.id, userId: recipientUserId } } });
    if (member && member.status !== 'active') return { ok: false, reason: 'recipient_blocked', final: true };
    const recent = await prisma.mboloMessage.count({ where: { threadId: thread.id, createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
    if (recent >= PARTNER_MESSAGES_PER_RECIPIENT_DAY) return { ok: false, reason: 'recipient_daily_limit', final: true };
  }

  if (!thread) {
    thread = await prisma.mboloThread.create({
      data: {
        creatorId: systemUserId,
        name: `Joko · ${partnerId}`,
        type: 'partner',
        commerceType: 'partner_notify',
        commerceRefId: commerceRef,
        members: {
          create: [
            { userId: systemUserId, role: 'system' },
            { userId: recipientUserId, role: 'member' },
          ],
        },
      },
    });
  }

  // J10-F2: always attributed to the partner — a partner message never looks like Jokko itself
  // (an unattributed "verification" text is a phishing pattern).
  const prefix = `[${metadata?.partner ?? partnerId}] `;

  await prisma.mboloMessage.create({
    data: {
      threadId: thread.id,
      senderId: systemUserId,
      body: `${prefix}${text}`.slice(0, 4000),
      kind: 'text',
    },
  });
  await prisma.mboloThread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });

  return { ok: true, threadId: thread.id };
}

/**
 * Partner send — Mbolo if Joko user exists, else SMS, else honest failed.
 */
export async function sendPartnerMessage(partnerId, body, { idempotencyKey } = {}) {
  const toPhoneRaw = body.to_phone ?? body.toPhone ?? body.phone;
  const text = String(body.text ?? '').trim();
  if (!toPhoneRaw) throw new PartnerMessageError('to_phone required');
  if (!text || text.length > 1600) throw new PartnerMessageError('text required (max 1600 chars)');

  const toPhone = canonicalPhone(String(toPhoneRaw));
  if (!toPhone) throw new PartnerMessageError('to_phone must be valid E.164');

  const channel = String(body.channel ?? 'mbolo_auto').toLowerCase();
  const metadata =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata
      : {};

  if (idempotencyKey) {
    const existing = await prisma.partnerMessage.findUnique({ where: { idempotencyKey } });
    if (existing) {
      return {
        id: existing.id,
        status: existing.status,
        channel_used: existing.channelUsed,
        error: existing.error,
      };
    }
  }

  const row = await prisma.partnerMessage.create({
    data: {
      id: msgId(),
      partnerId,
      toPhone,
      text,
      status: 'queued',
      channelUsed: 'none',
      metadataJson: JSON.stringify({ partner: partnerId, ...metadata }),
      idempotencyKey: idempotencyKey || null,
    },
  });

  let status = 'failed';
  let channelUsed = 'none';
  let error = null;

  const user = await findUserByPhone(toPhone);
  if (user && (channel === 'mbolo_auto' || channel === 'mbolo')) {
    const delivered = await deliverViaMbolo({
      partnerId,
      recipientUserId: user.id,
      text,
      metadata: { partner: partnerId, ...metadata },
    });
    if (delivered.ok) {
      status = 'sent';
      channelUsed = 'mbolo';
    } else {
      error = delivered.reason;
    }
    // A block / cap is the person's choice or a protection: never route around it by SMS.
    if (delivered.final) {
      const updated = await prisma.partnerMessage.update({ where: { id: row.id }, data: { status: 'failed', channelUsed: 'none', error } });
      return { id: updated.id, status: updated.status, channel_used: updated.channelUsed, error: updated.error };
    }
  }

  if (status !== 'sent' && (channel === 'mbolo_auto' || channel === 'sms')) {
    const sms = await sendSms(toPhone, text, { purpose: metadata.kind === 'verification' ? 'otp' : 'partner' });
    if (sms.ok) {
      status = sms.status === 'mock' ? 'sent' : 'sent';
      channelUsed = 'sms';
      error = null;
    } else if (!error) {
      error = sms.status === 'no_provider' ? 'no_sms_provider' : sms.status || 'sms_failed';
    }
  }

  if (status !== 'sent' && !error) {
    error = user
      ? 'delivery_failed'
      : 'no_joko_user_and_no_sms — recipient has no Joko account; configure SMS or ask them to install Joko';
  }

  const updated = await prisma.partnerMessage.update({
    where: { id: row.id },
    data: { status, channelUsed, error },
  });

  return {
    id: updated.id,
    status: updated.status,
    channel_used: updated.channelUsed,
    error: updated.error,
  };
}
