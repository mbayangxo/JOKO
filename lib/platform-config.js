import { betaDepositsAllowed } from './runtime-safety.js';
import { callsConfigured } from './calls-service.js';
import { stripeConfigured } from './stripe-service.js';

/**
 * Joko platform capability flags — wallet app. Partner products (KEBU, Rect) are separate installs.
 */
export function getPlatformConfig() {
  const allowBetaDeposits = betaDepositsAllowed(); // never advertised in production (J15 S-1)
  const production = process.env.NODE_ENV === 'production';
  const julayaKey = process.env.JULAYA_API_KEY ?? process.env.JULAYA_API_KEY_SANDBOX ?? '';
  const julayaLive =
    Boolean(julayaKey) && !julayaKey.toLowerCase().includes('sandbox') && !julayaKey.startsWith('test_');
  const agentsLive = process.env.AGENT_DEPOSITS_ENABLED !== 'false';
  const stripeLive = stripeConfigured();

  return {
    platform: 'joko',
    version: 1,
    region: 'SN',
    message:
      'Joko est le wallet (₭, envois, Mboolo, marketplace). KEBU est un site commerce B2B séparé — il utilise l’API Joko pour les paiements.',
    apps: {
      joko: {
        id: 'joko',
        name: 'Joko',
        install: 'this',
        scope: ['wallet', 'marketplace', 'mboolo'],
      },
      kebu: {
        id: 'kebu',
        name: 'KEBU',
        separateApp: true,
        install: 'separate',
        scope: ['business', 'b2b', 'payroll', 'distribution'],
        paymentsVia: 'joko-api',
      },
      k21: {
        id: 'k21',
        name: 'K21',
        install: 'this',
        scope: ['wallet', 'marketplace', 'mboolo'],
        aliasOf: 'joko',
      },
      rect: {
        id: 'rect',
        name: 'Rect',
        separateApp: true,
        install: 'separate',
        scope: ['culture', 'identity', 'creators'],
        paymentsVia: 'k21-api',
      },
    },
    auth: {
      emailOnly: true,
      phoneRequired: false,
    },
    features: {
      wallet: {
        send: true,
        receive: true,
        requests: true,
        undo: true,
        tontine: true,
      },
      cash: {
        /** Real Mobile Money rails — not beta test credit */
        depositsLive: julayaLive,
        withdrawalsLive: julayaLive,
        /** Admin ALLOW_BETA_DEPOSITS test credits */
        betaDeposits: allowBetaDeposits,
        /** Show Cash screens (beta, agents, stripe, or live MM) */
        available: allowBetaDeposits || agentsLive || stripeLive || !production || julayaLive,
        /** Path B — in-person K21 agents (float-backed) */
        agentDeposits: agentsLive,
        agentWithdrawals: agentsLive,
        /** Path A — Stripe card (diaspora) */
        stripeDeposits: stripeLive,
      },
      marketplace: {
        delivery: true,
        movement: true,
        seller: true,
        events: true,
        tickets: true,
        merchantPay: true,
      },
      mboolo: {
        chat: true,
        voiceNotes: true,
        voiceCalls: callsConfigured(),
        videoCalls: callsConfigured(),
      },
      comingSoon: {
        nuLekk: true,
        familyWallet: true,
        merchantQrOffline: true,
        float: true,
        wakhna: true,
        lemFiLive: Boolean(process.env.LEMFI_API_KEY && !process.env.LEMFI_API_KEY.includes('sandbox')),
      },
    },
  };
}
