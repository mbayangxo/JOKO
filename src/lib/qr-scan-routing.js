import { parseK21Qr } from './k21-qr';

/** Shared QR → navigation logic for camera and paste flows. */
export async function routeQrScan({ raw, mode, navigation, route, api, showToast }) {
  const text = String(raw ?? '').trim();
  if (text.length < 3) {
    showToast('Code QR ou @handle invalide');
    return { ok: false };
  }

  const parsed = parseK21Qr(text);
  if (!parsed && !text.match(/^@?[a-z0-9_]{3,30}$/i)) {
    showToast('Code QR ou @handle invalide');
    return { ok: false };
  }

  if (parsed?.kind === 'pay_charge') {
    // Opaque reference: merchant + amount come from the server, never from the QR.
    navigation.replace('PayMerchant', { chargeCode: parsed.code });
    return { ok: true };
  }

  if (parsed?.kind === 'pay_merchant' || mode === 'merchant') {
    const businessId = parsed?.businessId ?? parsed?.handle ?? text;
    const merchant = await api.getMerchantPublic(businessId);
    navigation.replace('PayMerchant', {
      merchantId: merchant.id,
      merchantName: merchant.name,
      merchantVerified: merchant.verified,
      merchantArr: merchant.arrondissement ?? merchant.category ?? 'K21',
    });
    return { ok: true };
  }

  if (mode === 'vouch') {
    const handle = parsed?.handle ?? text.replace(/^@/, '').trim();
    const result = await api.vouchForUser(handle);
    showToast(
      result.newlyConfirmed
        ? `${result.target?.name ?? 'Membre'} confirmé 🛡️`
        : `${result.target?.name ?? 'Membre'} était déjà confirmé ✓`,
    );
    navigation.goBack();
    return { ok: true };
  }

  if (parsed?.kind === 'add_user' || mode === 'friend') {
    const handle = parsed?.handle ?? text.replace(/^@/, '').trim();
    const result = await api.addFriend(handle);
    showToast(
      result.alreadyFriends
        ? 'Déjà dans tes amis ✓'
        : result.autoAccepted || result.accepted
          ? `${result.friend?.name ?? 'Nouvel ami'} ajouté ✓`
          : 'Demande envoyée ✓ — en attente de sa réponse',
    );
    navigation.goBack();
    return { ok: true };
  }

  if (mode === 'tontine_member') {
    const handle = parsed?.handle ?? text.replace(/^@/, '').trim();
    const profile = await api.lookupUser(handle);
    navigation.navigate('Tontine', { pickedMember: profile });
    return { ok: true };
  }

  if (mode === 'agent') {
    if (parsed?.kind === 'agent_deposit' || parsed?.kind === 'agent_withdraw' || text.includes('agent-deposit') || text.includes('agent-withdraw')) {
      navigation.navigate('AgentHome', { scannedQr: text });
      return { ok: true };
    }
    showToast('QR agent requis (agent-deposit ou agent-withdraw)');
    return { ok: false };
  }

  if (mode === 'ticket' || parsed?.kind === 'ticket_pass') {
    const scanCode = parsed?.scanCode ?? text.replace(/^.*ticket\//i, '').trim();
    navigation.navigate('EventScanner', { prefilledCode: scanCode });
    return { ok: true };
  }

  if (parsed?.kind === 'affiliate_shop' || parsed?.kind === 'affiliate_link') {
    let businessId = parsed.businessId;
    let productId = parsed.productId;
    let linkCode = parsed.linkCode;
    if (parsed.kind === 'affiliate_link' && linkCode) {
      try {
        const resolved = await api.resolveAffiliate(linkCode);
        businessId = resolved.business?.id ?? businessId;
        productId = resolved.product?.id ?? productId;
      } catch {
        showToast('Lien affilié invalide');
        return { ok: false };
      }
    }
    if (businessId) {
      navigation.navigate('Main', {
        screen: 'MarketplaceTab',
        params: {
          screen: 'ShopDetail',
          params: {
            businessId,
            affiliateRef: linkCode,
            highlightProductId: productId,
          },
        },
      });
      if (linkCode) api.trackAffiliateClick(linkCode).catch(() => {});
      return { ok: true };
    }
    showToast('Lien affilié incomplet');
    return { ok: false };
  }

  if (parsed?.kind === 'join_group' || mode === 'group_join') {
    const code = parsed?.inviteCode ?? text.trim().toUpperCase();
    const thread = await api.joinMboloGroup(code);
    showToast('Groupe rejoint ✓');
    navigation.replace('Main', {
      screen: 'MbooloTab',
      params: { screen: 'MbooloChat', params: { threadId: thread.id, thread, title: thread.name ?? 'Conversation' } },
    });
    return { ok: true };
  }

  const handle = parsed?.handle ?? text.replace(/^@/, '').trim();
  const profile = await api.lookupUser(handle);
  navigation.replace('SendMoney', {
    recipientHandle: profile.handle,
    prefilledAmount: route.params?.amount,
  });
  return { ok: true };
}
