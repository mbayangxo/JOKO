/**
 * Payment rail configuration — switches sandbox vs production via NODE_ENV.
 * API keys and URLs live in environment variables only (never in code/git).
 */

const JULAYA_SANDBOX_DEFAULT = 'https://sandbox.api.julaya.co/v1';
const JULAYA_PRODUCTION_DEFAULT = 'https://api.julaya.co/v1';
const LEMFI_SANDBOX_DEFAULT = 'https://sandbox.api.lemfi.com/v1';
const LEMFI_PRODUCTION_DEFAULT = 'https://api.lemfi.com/v1';

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function pickUrl(sandboxEnv, productionEnv, sandboxDefault, productionDefault) {
  if (isProduction()) {
    return (productionEnv || sandboxEnv || productionDefault).replace(/\/$/, '');
  }
  return (sandboxEnv || productionEnv || sandboxDefault).replace(/\/$/, '');
}

export function julayaConfig() {
  const sandboxKey = process.env.JULAYA_API_KEY_SANDBOX?.trim();
  const productionKey = process.env.JULAYA_API_KEY?.trim() || process.env.JULAYA_API_KEY_PRODUCTION?.trim();

  const apiKey = isProduction() ? productionKey : sandboxKey || productionKey;
  const apiUrl = pickUrl(
    process.env.JULAYA_API_URL_SANDBOX,
    process.env.JULAYA_API_URL_PRODUCTION || process.env.JULAYA_API_URL,
    JULAYA_SANDBOX_DEFAULT,
    JULAYA_PRODUCTION_DEFAULT,
  );

  // Production never runs a mock rail: no key → 'unavailable' (fail closed).
  const mode = apiKey ? (isProduction() ? 'production' : 'sandbox') : isProduction() ? 'unavailable' : 'mock';

  if (!isProduction() && productionKey && !sandboxKey && process.env.JULAYA_API_KEY) {
    console.warn(
      '[payment-config] Development NODE_ENV with production JULAYA_API_KEY — use JULAYA_API_KEY_SANDBOX in development.',
    );
  }

  return {
    apiKey: apiKey || null,
    apiUrl,
    webhookSecret: process.env.JULAYA_WEBHOOK_SECRET?.trim() || null,
    callbackUrl: process.env.JULAYA_CALLBACK_URL?.trim() || null,
    mode,
  };
}

export function lemfiConfig() {
  const sandboxKey = process.env.LEMFI_API_KEY_SANDBOX?.trim();
  const productionKey = process.env.LEMFI_API_KEY?.trim() || process.env.LEMFI_API_KEY_PRODUCTION?.trim();
  const apiKey = isProduction() ? productionKey : sandboxKey || productionKey;
  const apiUrl = pickUrl(
    process.env.LEMFI_API_URL_SANDBOX,
    process.env.LEMFI_API_URL_PRODUCTION || process.env.LEMFI_API_URL,
    LEMFI_SANDBOX_DEFAULT,
    LEMFI_PRODUCTION_DEFAULT,
  );

  return {
    apiKey: apiKey || null,
    apiUrl,
    mode: apiKey ? (isProduction() ? 'production' : 'sandbox') : isProduction() ? 'unavailable' : 'mock',
  };
}

export function julayaConfigured() {
  return Boolean(julayaConfig().apiKey);
}

export function julayaMode() {
  const { mode } = julayaConfig();
  if (mode === 'unavailable') return 'unavailable';
  if (mode === 'mock') return 'sandbox';
  return mode === 'production' ? 'live' : 'sandbox';
}

/** True when the Julaya rail can actually move money (live or sandbox key, or dev mock). */
export function julayaOperational() {
  return julayaConfig().mode !== 'unavailable';
}
