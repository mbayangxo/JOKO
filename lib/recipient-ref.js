/**
 * J13-4 — mandatory recipient identity binding for P2P payments (policy approved 2026-10-13).
 *
 * Handles and phone numbers are LABELS: a handle can be renamed and reclaimed, a number can move to another
 * person. Neither is ever used as the immutable payment identifier. Two server-signed, short-lived tokens:
 *
 *   recipientRef  (rr2) — issued by users/lookup. Binds: sender id, recipient ACCOUNT ID, the identifier the
 *                         sender searched by (handle or phone, hashed) and an expiry.
 *   instructionRef (ri2) — issued by transfers/confirm from a valid recipientRef. Additionally binds the
 *                         confirmed amount and the payment's idempotency key, so the confirmation can only
 *                         ever execute ONE payment (a replay under a new key is refused; the same key is the
 *                         normal idempotent replay).
 *
 * transfers/send re-verifies everything against the CURRENT state before any money moves: signature, kind,
 * expiry, sender, recipient account id, the identifier still belonging to that account, amount and key.
 * Tokens are encrypted + authenticated (AES-256-GCM), stateless (no storage), unforgeable and unreadable
 * without the server secret.
 */
import crypto from 'node:crypto';
import { authNotConfiguredError, jwtSecretConfigured } from './auth-config.js';

export const RECIPIENT_REF_TTL_MS = 15 * 60_000;
export const INSTRUCTION_REF_TTL_MS = 10 * 60_000;

const KINDS = { recipient: 'rr2', instruction: 'ri2' };

export class RecipientBindingError extends Error {
  /** @param {'forged'|'expired'|'cross_account'|'recipient_changed'|'instruction_changed'|'confirmation_required'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function key() {
  if (!jwtSecretConfigured('JWT_ACCESS_SECRET')) throw authNotConfiguredError();
  // A dedicated subkey: these tokens can never be confused with (or replayed as) session JWTs.
  return crypto.createHmac('sha256', process.env.JWT_ACCESS_SECRET.trim()).update('k21-recipient-binding:v2').digest();
}

/** Normalised, hashed identifier — the token never carries a phone number or handle in clear. */
export function identifierHash(via, value) {
  const norm = via === 'phone' ? String(value ?? '').replace(/[^\d+]/g, '') : String(value ?? '').replace(/^@/, '').toLowerCase();
  return crypto.createHash('sha256').update(`${via}:${norm}`).digest('base64url').slice(0, 22);
}

// AES-256-GCM: the payload (account ids, expiry, amount, key) is ENCRYPTED, not just signed — a token reveals
// nothing — and the GCM tag authenticates it (any change → 'forged'). The kind is bound as associated data,
// so a recipient token can never be presented as an instruction token or vice versa.
function sign(kind, payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(KINDS[kind]));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return `${KINDS[kind]}.${iv.toString('base64url')}.${Buffer.concat([ct, cipher.getAuthTag()]).toString('base64url')}`;
}

function open(kind, token) {
  const bad = () => new RecipientBindingError('forged', 'Confirmation invalide.');
  if (typeof token !== 'string' || token.length > 1024) throw bad();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== KINDS[kind]) throw bad();
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const blob = Buffer.from(parts[2], 'base64url');
    if (iv.length !== 12 || blob.length < 17) throw bad();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAAD(Buffer.from(parts[0]));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    const pt = Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch {
    throw bad();
  }
}

/** users/lookup: bind the found account to the viewer and to the identifier they searched by. */
export function issueRecipientRef({ senderId, recipient, via, now = Date.now() }) {
  const value = via === 'phone' ? recipient.phone : recipient.handle;
  return sign('recipient', { s: senderId, r: recipient.id, via, k: identifierHash(via, value), exp: now + RECIPIENT_REF_TTL_MS });
}

/**
 * Checks shared by confirm and send: signature, expiry, the viewer, and that the identifier the sender
 * used STILL belongs to the same account (renamed / reclaimed handle, moved phone number → refused).
 * `recipient` is the account currently resolved by the request; `holderOf(via)` returns its identifier.
 */
function checkBinding(p, { senderId, recipient, now }) {
  if (typeof p?.exp !== 'number' || p.exp <= now) throw new RecipientBindingError('expired', 'Cette confirmation a expiré. Vérifie à nouveau le destinataire.');
  if (p.s !== senderId) throw new RecipientBindingError('cross_account', 'Confirmation invalide.');
  if (!recipient || p.r !== recipient.id) {
    throw new RecipientBindingError('recipient_changed', 'Le destinataire a changé depuis ta vérification. Aucun argent n’a été envoyé — vérifie à nouveau.');
  }
  const current = p.via === 'phone' ? recipient.phone : recipient.handle;
  if (!['handle', 'phone'].includes(p.via) || identifierHash(p.via, current) !== p.k) {
    throw new RecipientBindingError('recipient_changed', 'Le destinataire a changé depuis ta vérification. Aucun argent n’a été envoyé — vérifie à nouveau.');
  }
}

/** Reads the recipient account id out of a VERIFIED recipientRef (signature + expiry + viewer only). */
export function recipientIdFromRef(token, { senderId, now = Date.now() }) {
  const p = open('recipient', token);
  if (typeof p?.exp !== 'number' || p.exp <= now) throw new RecipientBindingError('expired', 'Cette confirmation a expiré. Vérifie à nouveau le destinataire.');
  if (p.s !== senderId) throw new RecipientBindingError('cross_account', 'Confirmation invalide.');
  return p.r;
}

/** transfers/confirm: recipientRef + confirmed amount + idempotency key → single-payment instructionRef. */
export function issueInstructionRef({ recipientRef, senderId, recipient, amountKori, intentKey, now = Date.now() }) {
  const p = open('recipient', recipientRef);
  checkBinding(p, { senderId, recipient, now });
  if (!Number.isInteger(amountKori) || amountKori <= 0) throw new RecipientBindingError('instruction_changed', 'Montant invalide.');
  if (typeof intentKey !== 'string' || intentKey.length < 8) throw new RecipientBindingError('instruction_changed', 'Clé de paiement manquante.');
  return sign('instruction', { s: senderId, r: recipient.id, via: p.via, k: p.k, a: amountKori, i: intentKey, exp: now + INSTRUCTION_REF_TTL_MS });
}

/** transfers/send: the instruction must match this sender, this account, this amount and this key — now. */
export function verifyInstructionRef(token, { senderId, recipient, amountKori, intentKey, now = Date.now() }) {
  if (token === undefined || token === null || token === '') throw new RecipientBindingError('confirmation_required', 'Confirme le destinataire avant d’envoyer.');
  const p = open('instruction', token);
  checkBinding(p, { senderId, recipient, now });
  if (p.a !== amountKori) throw new RecipientBindingError('instruction_changed', 'Le montant ne correspond pas à ta confirmation. Aucun argent n’a été envoyé.');
  if (!intentKey || p.i !== intentKey) throw new RecipientBindingError('instruction_changed', 'Cette confirmation appartient à un autre paiement. Aucun argent n’a été envoyé.');
  return p;
}

export const BINDING_STATUS = {
  forged: 409,
  expired: 409,
  cross_account: 409,
  recipient_changed: 409,
  instruction_changed: 409,
  confirmation_required: 428,
};
