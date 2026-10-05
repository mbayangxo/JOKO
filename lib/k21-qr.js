/** Deep-link payloads for scan-to-pay and scan-to-add-friend. */

export function normalizeHandle(handle) {
  return String(handle ?? '').replace(/^@/, '').trim().toLowerCase();
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

export function buildMerchantPayUrl(businessId) {
  const id = String(businessId ?? '').trim();
  if (!id) throw new Error('Business id required');
  return `k21://merchant/${id}`;
}

/** J4: a merchant charge — the QR carries only the opaque code; amount and merchant are server state. */
export function buildChargeUrl(code) {
  const c = String(code ?? '').trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(c)) throw new Error('Charge code required');
  return `k21://charge/${c}`;
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

export function buildAgentWithdrawUrl(token) {
  const t = String(token ?? '').trim();
  if (!t) throw new Error('Token required');
  return `k21://agent-withdraw/${t}`;
}

export function buildWebJoinUrl(refCode) {
  const ref = String(refCode ?? '').trim().toUpperCase();
  if (!ref) throw new Error('Invite code required');
  return `${getAppPublicOrigin()}/join?ref=${encodeURIComponent(ref)}`;
}

export function buildGroupJoinUrl(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) throw new Error('Invite code required');
  return `k21://group-join/${c}`;
}

export function buildWebGroupJoinUrl(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) throw new Error('Invite code required');
  return `${getAppPublicOrigin()}/group-join/${c}`;
}

export function buildTicketPassUrl(scanCode) {
  const code = String(scanCode ?? '').trim().toUpperCase();
  if (!code) throw new Error('Scan code required');
  return `k21://ticket/${code}`;
}

export function buildAffiliateShopUrl({ businessId, productId, linkCode }) {
  const ref = String(linkCode ?? '').trim().toUpperCase();
  if (!ref) throw new Error('Link code required');
  const biz = String(businessId ?? '').trim();
  if (!biz) throw new Error('Business id required');
  const prod = productId ? String(productId).trim() : '';
  const base = prod ? `k21://shop/${biz}/product/${prod}` : `k21://shop/${biz}`;
  return `${base}?ref=${ref}`;
}

export function getAppPublicOrigin() {
  const base = String(process.env.EXPO_PUBLIC_API_URL ?? process.env.VERCEL_URL ?? '').trim();
  if (!base) return 'https://k21.app';
  if (base.startsWith('http://') || base.startsWith('https://')) {
    return base.replace(/\/$/, '');
  }
  return `https://${base.replace(/\/$/, '')}`;
}

export function buildWebFriendUrl(handle) {
  const h = normalizeHandle(handle);
  if (!h) throw new Error('Handle required');
  return `${getAppPublicOrigin()}/u/${h}`;
}

export function buildWebPayUrl(handle) {
  const h = normalizeHandle(handle);
  if (!h) throw new Error('Handle required');
  return `${getAppPublicOrigin()}/pay/${h}`;
}

/**
 * @returns {{ kind: 'pay_user'|'add_user'|'pay_merchant', handle?: string, businessId?: string } | null}
 */
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
    if (path === 'agent-deposit' && rest) return { kind: 'agent_deposit', token: rest };
    if (path === 'agent-withdraw' && rest) return { kind: 'agent_withdraw', token: rest };
    if (path === 'ticket' && rest) return { kind: 'ticket_pass', scanCode: rest.toUpperCase() };
    if (path === 'group-join' && rest) return { kind: 'join_group', inviteCode: rest.toUpperCase() };
    if (path === 'shop' && rest) {
      const parts = rest.split('/').filter(Boolean);
      const businessId = parts[0];
      let productId;
      let ref;
      const productIdx = parts.indexOf('product');
      if (productIdx >= 0 && parts[productIdx + 1]) productId = parts[productIdx + 1].split('?')[0];
      const refMatch = rest.match(/[?&]ref=([^&]+)/i);
      if (refMatch) ref = refMatch[1].toUpperCase();
      return { kind: 'affiliate_shop', businessId, productId, linkCode: ref };
    }
    if (path === 'aff' && rest) return { kind: 'affiliate_link', linkCode: rest.toUpperCase().split('?')[0] };
  }

  try {
    const u = new URL(text);
    const host = u.hostname.toLowerCase();
    if (host.includes('k21') || host.includes('vercel') || host.includes('localhost')) {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'pay' && parts[1]) {
        return { kind: 'pay_user', handle: normalizeHandle(parts[1]) };
      }
      if (parts[0] === 'u' && parts[1]) {
        return { kind: 'add_user', handle: normalizeHandle(parts[1]) };
      }
      if (parts[0] === 'invite' && parts[1]) {
        return { kind: 'add_user', handle: normalizeHandle(parts[1]) };
      }
      if (parts[0] === 'join' && u.searchParams.get('ref')) {
        return { kind: 'invite_ref', inviteCode: u.searchParams.get('ref').toUpperCase() };
      }
      if (parts[0] === 'group-join' && parts[1]) {
        return { kind: 'join_group', inviteCode: normalizeHandle(parts[1]).toUpperCase() };
      }
      if (parts[0] === 'merchant' && parts[1]) {
        return { kind: 'pay_merchant', businessId: parts[1] };
      }
    }
  } catch {
    /* not a URL */
  }

  return null;
}
