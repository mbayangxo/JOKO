import { z } from 'zod';
import { prisma } from './prisma.js';
import { validationError } from './validation.js';
import {
  createUserSupportTicket,
  getCustomerServiceContact,
  getUserSupportTicket,
  listUserSupportTickets,
  replyUserSupportTicket,
} from './support-service.js';
import { clientErrorMessage } from './log-redact.js';

export async function supportContactInfo(req, res) {
  res.json(getCustomerServiceContact());
}

export async function supportTicketsMine(req, res) {
  const tickets = await listUserSupportTickets(prisma, req.userId);
  res.json({ tickets });
}

export async function supportTicketCreate(req, res) {
  const schema = z.object({
    subject: z.string().min(3).max(120),
    body: z.string().min(10).max(4000),
    channel: z.enum(['app', 'phone', 'whatsapp']).optional(),
    csPhone: z.string().max(24).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const ticket = await createUserSupportTicket(prisma, {
      userId: req.userId,
      subject: parsed.data.subject,
      body: parsed.data.body,
      channel: parsed.data.channel ?? 'app',
      csPhone: parsed.data.csPhone,
    });
    res.status(201).json(ticket);
  } catch (err) {
    res.status(400).json({ error: clientErrorMessage(err, 'Unable to create ticket') });
  }
}

export async function supportTicketGet(req, res) {
  const ticketId = String(req.query.id ?? '');
  if (!ticketId) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  const ticket = await getUserSupportTicket(prisma, { userId: req.userId, ticketId });
  if (!ticket) {
    res.status(404).json({ error: 'Ticket introuvable' });
    return;
  }
  res.json(ticket);
}

export async function supportTicketReply(req, res) {
  const ticketId = String(req.query.id ?? '');
  const schema = z.object({ body: z.string().min(1).max(4000) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success || !ticketId) return validationError(res, parsed.error ?? { issues: [] });

  try {
    const ticket = await replyUserSupportTicket(prisma, {
      userId: req.userId,
      ticketId,
      body: parsed.data.body,
    });
    res.json(ticket);
  } catch (err) {
    res.status(400).json({ error: clientErrorMessage(err, 'Reply failed') });
  }
}
