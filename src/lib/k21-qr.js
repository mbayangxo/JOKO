/** Client-side K21 QR deep-link parsing (mirrors lib/k21-qr.js). */

import { Platform } from 'react-native';

export function normalizeHandle(handle) {
  return String(handle ?? '').replace(/^@/, '').trim().toLowerCase();
}

export function getAppPublicOrigin() {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin.replace(/\/$/, '');
  }
  const base = String(process.env.EXPO_PUBLIC_API_URL ?? '').trim();
  if (!base) return '';
  if (base.startsWith('http://') || base.startsWith('https://')) {
    return base.replace(/\/$/, '');
  }
  return `https://${base.replace(/\/$/, '')}`;
}

export function buildUserPayUrl(handle) {
  const h = normalizeHandle(handle);
  if (!h) throw new Error('Handle required');
  return `k21://pay/@${h}`;
}

export function buildUserProfileUrl(handle) {
  const h = normalizeHandle(handle);
  if (!h) throw new Error('Handle required');
  return `k21://u/@${h}`;
}

export function buildWebFriendUrl(handle) {
  const h = normalizeHandle(handle);
  if (!h) throw new Error('Handle required');
  const origin = getAppPublicOrigin();
  return origin ? `${origin}/u/${h}` : `https://k21.app/u/${h}`;
}

export function buildWebPayUrl(handle) {
  const h = normalizeHandle(handle);
  if (!h) throw new Error('Handle required');
  const origin = getAppPublicOrigin();
  return origin ? `${origin}/pay/${h}` : `https://k21.app/pay/${h}`;
}

export function buildMerchantPayUrl(businessId) {
  const id = String(businessId ?? '').trim();
  if (!id) throw new Error('Business id required');
  return `k21://merchant/${id}`;
}

export function buildStudentPassUrl(handle) {
  const h = normalizeHandle(handle);
  if (!h) throw new Error('Handle required');
  return `k21://pass/@${h}`;
}

export function buildAgentDepositUrl(token) {
  const t = String(token ?? '').trim();
  if (!t) throw new Error('Token required');
  return `k21://agent-deposit/${t}`;
}

/**
 * Normalizes anything a user might paste into a "find account" field — a
 * plain @handle, a phone number, or a k21://... / web link/code — into a
 * query string ready for the lookup endpoint (which already tells phone
 * from handle apart by digit count). Links/codes get resolved to the
 * @handle they point to; everything else passes through unchanged.
 */
export function resolveAccountQuery(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const looksLikeLink = /^k21:\/\//i.test(text) || /^https?:\/\//i.test(text);
  if (!looksLikeLink) return text;
  const parsed = parseK21Qr(text);
  if (parsed?.handle) return `@${parsed.handle}`;
  return text;
}

export function buildTicketPassUrl(scanCode) {
  const code = String(scanCode ?? '').trim().toUpperCase();
  if (!code) throw new Error('Scan code required');
  return `k21://ticket/${code}`;
}

export function buildAgentWithdrawUrl(token) {
  const t = String(token ?? '').trim();
  if (!t) throw new Error('Token required');
  return `k21://agent-withdraw/${t}`;
}

export function buildGroupJoinUrl(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) throw new Error('Invite code required');
  return `k21://group-join/${c}`;
}

export function buildWebGroupJoinUrl(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) throw new Error('Invite code required');
  const origin = getAppPublicOrigin();
  return origin ? `${origin}/group-join/${c}` : `https://k21.app/group-join/${c}`;
}

/**
 * J4: a merchant charge QR carries only an opaque code. Merchant and amount are
 * read from the server; the client never trusts an amount encoded in a QR.
 */
export function buildChargeUrl(code) {
  const c = String(code ?? '').trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(c)) throw new Error('Charge code required');
  return `k21://charge/${c}`;
}

export function parseK21Qr(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const handleOnly = text.match(/^@?([a-z0-9_]{3,30})$/i);
  if (handleOnly) {
    return { kind: 'pay_user', handle: handleOnly[1].toLowerCase() };
  }

  const urlMatch = text.match(/^k21:\/\/([^/?#]+)\/?(.*)$/i);
  if (urlMatch) {
    const path = urlMatch[1].toLowerCase();
    const rest = (urlMatch[2] ?? '').replace(/^@/, '').trim();
    if (path === 'pay' && rest) return { kind: 'pay_user', handle: rest.toLowerCase() };
    if ((path === 'u' || path === 'user') && rest) return { kind: 'add_user', handle: rest.toLowerCase() };
    if (path === 'pass' && rest) return { kind: 'student_pass', handle: rest.toLowerCase() };
    if (path === 'merchant' && rest) return { kind: 'pay_merchant', businessId: rest };
    if (path === 'charge' && rest) return { kind: 'pay_charge', code: rest.split(/[?#/]/)[0] };
    if (path === 'agent-deposit' && rest) return { kind: 'agent_deposit', token: rest };
    if (path === 'agent-withdraw' && rest) return { kind: 'agent_withdraw', token: rest };
    if (path === 'aff' && rest) return { kind: 'affiliate_link', linkCode: rest.toUpperCase().split('?')[0] };
    if (path === 'group-join' && rest) return { kind: 'join_group', inviteCode: rest.toUpperCase() };
    if (path === 'shop' && rest) {
      const parts = rest.split('?')[0].split('/').filter(Boolean);
      const businessId = parts[0];
      let productId;
      const productIdx = parts.indexOf('product');
      if (productIdx >= 0 && parts[productIdx + 1]) productId = parts[productIdx + 1];
      const refMatch = rest.match(/[?&]ref=([^&]+)/i);
      const linkCode = refMatch ? refMatch[1].toUpperCase() : undefined;
      return { kind: 'affiliate_shop', businessId, productId, linkCode };
    }
  }

  try {
    const u = new URL(text, getAppPublicOrigin() || 'https://k21.app');
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'pay' && parts[1]) {
      return { kind: 'pay_user', handle: normalizeHandle(parts[1]) };
    }
    if (parts[0] === 'u' && parts[1]) {
      return { kind: 'add_user', handle: normalizeHandle(parts[1]) };
    }
    if (parts[0] === 'join' && u.searchParams.get('ref')) {
      return { kind: 'invite_ref', inviteCode: u.searchParams.get('ref').toUpperCase() };
    }
    if (parts[0] === 'group-join' && parts[1]) {
      return { kind: 'join_group', inviteCode: normalizeHandle(parts[1]).toUpperCase() };
    }
    if (parts[0] === 'charge' && parts[1]) {
      return { kind: 'pay_charge', code: parts[1] };
    }
    if (parts[0] === 'merchant' && parts[1]) {
      return { kind: 'pay_merchant', businessId: parts[1] };
    }
    if (parts[0] === 'pass' && parts[1]) {
      return { kind: 'student_pass', handle: normalizeHandle(parts[1]) };
    }
  } catch {
    /* not a URL */
  }

  return null;
}
