import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { getAccessToken, getOrCreateDeviceId, getRefreshToken, saveSessionTokens, clearSession, touchActivity } from './secure-storage.js';
import { captureApiError } from './sentry.js';
import { loadPreferences } from './preferences-storage.js';

const API_BASE =
  process.env.EXPO_PUBLIC_API_URL ??
  Constants.expoConfig?.extra?.apiUrl ??
  'https://keit-six.vercel.app';
const GET_CACHE = new Map();
const CACHE_TTL_MS = 45_000;

let prefsCache = null;
async function getNetworkPrefs() {
  if (!prefsCache) prefsCache = await loadPreferences();
  return prefsCache;
}

export function clearApiCache() {
  GET_CACHE.clear();
  prefsCache = null;
}

// EXPO_PUBLIC_API_URL is often set to a bare host (e.g. "keit-six.vercel.app",
// copy-pasted from Vercel's dashboard without the scheme) — treat that as
// https rather than hard-failing with a cryptic "requires HTTPS" error.
function normalizeBase(base) {
  if (!base) return base;
  if (base.startsWith('http://') || base.startsWith('https://')) return base;
  return `https://${base}`;
}

export function resolveUrl(path) {
  if (path.startsWith('http')) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  // Web deploys ship frontend + /api on the same Vercel origin. Never call a
  // different host (e.g. EXPO_PUBLIC_API_URL=keit-six while on os-projects).
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    if (normalizedPath.startsWith('/api')) {
      return normalizedPath;
    }
    const base = normalizeBase(API_BASE);
    const origin = window.location.origin;
    if (!base || base.replace(/\/$/, '') === origin) {
      return normalizedPath;
    }
  }

  const base = normalizeBase(API_BASE) || (Platform.OS === 'web' ? '' : 'https://localhost');
  return `${base}${normalizedPath}`;
}

function assertHttps(url) {
  if (__DEV__ && (url.includes('localhost') || url.includes('127.0.0.1'))) return;
  // Same-origin relative paths (/api/*) inherit HTTPS from the page on web.
  if (url.startsWith('/')) return;
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.protocol === 'https:') {
    if (url.startsWith('https://') || url.startsWith(window.location.origin)) return;
  }
  if (!url.startsWith('https://')) {
    throw new Error('K21 requires HTTPS — connection refused');
  }
}

export function getSslPinConfig() {
  return process.env.EXPO_PUBLIC_SSL_PIN_SHA256 ?? null;
}

function cacheKey(method, url) {
  return `${method}:${url}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function newIdempotencyKey() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export async function apiFetch(path, { method = 'GET', body, stepUpToken, auth = true, skipCache = false, _retry401 = true, accessToken: accessTokenOverride, idempotencyKey } = {}) {
  // Every write carries ONE Idempotency-Key for all of its attempts (timeout
  // retry below, 401 refresh retry) so the server never executes it twice.
  const writeKey = method === 'GET' ? null : idempotencyKey ?? newIdempotencyKey();
  const url = resolveUrl(path);
  assertHttps(url);
  const prefs = await getNetworkPrefs();
  const timeoutMs = prefs.lowDataMode ? 45_000 : 25_000;

  if (method === 'GET' && prefs.lowDataMode && !skipCache) {
    const key = cacheKey(method, url);
    const hit = GET_CACHE.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  }

  const headers = { 'Content-Type': 'application/json' };
  const deviceId = await getOrCreateDeviceId();
  headers['X-Device-Id'] = deviceId;
  if (prefs.lowDataMode) headers['X-Low-Data'] = '1';
  if (auth) {
    const token = accessTokenOverride ?? (await getAccessToken());
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (stepUpToken) headers['X-Step-Up-Token'] = stepUpToken;
  if (writeKey) headers['Idempotency-Key'] = writeKey;

  const pin = getSslPinConfig();
  if (pin && Platform.OS !== 'web') {
    headers['X-K21-Pin-Expected'] = pin.slice(0, 8);
  }

  const options = {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  };

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (auth && response.ok) await touchActivity();

      const data = await response.json().catch(() => ({}));
      if (response.status === 202) {
        const error = new Error(
          data.message ?? 'Nous vérifions cette transaction — tu auras de nos nouvelles sous peu.',
        );
        error.status = 202;
        error.code = data.status ?? 'pending_review';
        error.data = data;
        throw error;
      }
      if (!response.ok) {
        if (response.status === 401 && auth && _retry401 && path !== '/api/auth/refresh' && !accessTokenOverride) {
          const refreshToken = await getRefreshToken();
          if (refreshToken) {
            try {
              const refreshed = await authRefreshToken(refreshToken);
              await saveSessionTokens({
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken,
              });
              return apiFetch(path, { method, body, stepUpToken, auth, skipCache, _retry401: false, accessToken: accessTokenOverride, idempotencyKey: writeKey });
            } catch {
              await clearSession();
            }
          }
        }
        const baseMsg =
          data.error ??
          (data.details ? 'Validation failed — check your input' : null) ??
          (response.status === 405 ? 'Server misconfigured — API route not found' : null) ??
          `Request failed (${response.status})`;
        // Beta only: the server tags 401s with a `debug` reason — show it
        // inline so a screenshot is enough to diagnose, no logs needed.
        const msg = data.debug ? `${baseMsg} [${data.debug}]` : baseMsg;
        const error = new Error(msg);
        error.status = response.status;
        error.code = data.code;
        error.category = data.category ?? null;
        error.idempotencyKey = writeKey;
        error.data = data;
        if (response.status >= 500) {
          captureApiError(error, { path, status: response.status, code: data.code });
        }
        throw error;
      }

      if (method === 'GET' && prefs.lowDataMode) {
        GET_CACHE.set(cacheKey(method, url), { at: Date.now(), data });
      }
      return data;
    } catch (error) {
      lastError = error;
      const retryable =
        error.name === 'AbortError' ||
        error.message?.includes('Network') ||
        error.message?.includes('fetch');
      if (!retryable || attempt === 1) break;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  const raw = lastError?.message ?? '';
  const lost = lastError?.name === 'AbortError' || raw === 'Load failed' || raw.includes('Failed to fetch') || raw.includes('Network request failed');
  if (lost && writeKey) {
    // J4: a WRITE whose response was lost may have executed. Never tell the
    // user to "retry" (a new tap = a new payment): report an unknown outcome
    // with the intent key so the screen can ask GET /api/money/intents/:key.
    const unknown = new Error('Vérification du paiement en cours… Ne le renouvelle pas.');
    unknown.code = 'outcome_unknown';
    unknown.idempotencyKey = writeKey;
    throw unknown;
  }
  if (lastError?.name === 'AbortError') {
    const slow = new Error('Connexion lente — réessaie dans un instant');
    slow.code = 'timeout';
    throw slow;
  }
  if (lost) {
    const network = new Error('Connexion impossible — vérifie ta connexion et réessaie');
    network.code = 'network';
    throw network;
  }
  throw lastError;
}

export function lookupUser(query) {
  const q = String(query).trim();
  if (q.length < 3) return Promise.reject(new Error('Query too short'));
  return apiFetch(`/api/users/lookup?q=${encodeURIComponent(q)}`, { skipCache: true });
}

export function transferUndo(reference) {
  return apiFetch(`/api/transfers/${encodeURIComponent(reference)}/undo`, { method: 'POST', skipCache: true });
}

export function getCultureFeed(country = 'SN', query = '') {
  const params = new URLSearchParams({ country });
  if (query) params.set('q', query);
  return apiFetch(`/api/culture/feed?${params.toString()}`, { skipCache: true });
}

export function getTrendingFeed(tab = 'all', query = '') {
  const params = new URLSearchParams({ tab });
  if (query) params.set('q', query);
  return apiFetch(`/api/trending/feed?${params.toString()}`, { skipCache: true });
}

export function getTrendingAlert(alertId) {
  return apiFetch(`/api/trending/alerts/${encodeURIComponent(alertId)}`, { skipCache: true });
}

export function markTrendingAlertRead(alertId) {
  return apiFetch(`/api/trending/alerts/${encodeURIComponent(alertId)}/read`, { method: 'POST', skipCache: true });
}

export function getTrendingAlertShareMessage(alertId) {
  return apiFetch(`/api/trending/alerts/${encodeURIComponent(alertId)}/share`, { method: 'POST', skipCache: true });
}

export function authRecover(phone, email) {
  return apiFetch('/api/auth/recover', { method: 'POST', body: { phone, email: email.trim().toLowerCase() }, auth: false, skipCache: true });
}

export function authEmail(email, intent = 'login') {
  return apiFetch('/api/auth/email', {
    method: 'POST',
    body: { email: email.trim().toLowerCase(), intent },
    auth: false,
    skipCache: true,
  });
}

export function authPhone(phone, intent = 'signup') {
  return apiFetch('/api/auth/phone', { method: 'POST', body: { phone, intent }, auth: false, skipCache: true });
}

export function authVerify(phoneOrOpts, otp, intent = 'signup') {
  const body =
    typeof phoneOrOpts === 'object' && phoneOrOpts !== null
      ? { ...phoneOrOpts, otp: String(phoneOrOpts.otp ?? '').trim() }
      : { phone: phoneOrOpts, otp: String(otp).trim(), intent };
  return apiFetch('/api/auth/verify', { method: 'POST', body, auth: false, skipCache: true });
}

export function authPasswordLogin(email, password) {
  return apiFetch('/api/auth/password/login', {
    method: 'POST',
    body: { email: String(email).trim().toLowerCase(), password },
    auth: false,
    skipCache: true,
  });
}

export function authPasswordSet(password) {
  return apiFetch('/api/auth/password/set', { method: 'POST', body: { password }, skipCache: true });
}

export function authPasswordSetWithOtp(email, password, otp) {
  return apiFetch('/api/auth/password/set-with-otp', {
    method: 'POST',
    body: { email: String(email).trim().toLowerCase(), password, otp: String(otp).trim() },
    auth: false,
    skipCache: true,
  });
}

export function authCompleteProfile(body) {
  return apiFetch('/api/auth/complete-profile', { method: 'POST', body, skipCache: true });
}

/** Best-effort server sign-out (revokes this device's refresh token). */
export function authLogout(refreshToken) {
  return apiFetch('/api/auth/logout', { method: 'POST', body: { refreshToken }, skipCache: true, _retry401: false });
}

/** Sign out of every device. */
export function authLogoutAll() {
  return apiFetch('/api/auth/logout-all', { method: 'POST', body: {}, skipCache: true, _retry401: false });
}

export function authRefreshToken(refreshToken) {
  return apiFetch('/api/auth/refresh', { method: 'POST', body: { refreshToken }, auth: false, skipCache: true, _retry401: false });
}

export function getMe(accessToken) {
  return apiFetch('/api/me', { skipCache: true, accessToken, _retry401: !accessToken });
}

export function getMeSummary() {
  return apiFetch('/api/me/summary', { skipCache: true });
}

export function getStudentPass() {
  return apiFetch('/api/me/student-pass', { skipCache: true });
}

export function enrollStudentPass(schoolName) {
  return apiFetch('/api/me/student-pass', {
    method: 'POST',
    body: { schoolName },
    skipCache: true,
  });
}

export function patchMe(body) {
  return apiFetch('/api/me', { method: 'PATCH', body, skipCache: true });
}

export function mePhoneRequest(phone) {
  return apiFetch('/api/me/phone', { method: 'POST', body: { phone }, skipCache: true });
}

export function mePhoneConfirm(phone, otp) {
  return apiFetch('/api/me/phone/confirm', { method: 'POST', body: { phone, otp: String(otp).trim() }, skipCache: true });
}

export function getPlatformConfig() {
  return apiFetch('/api/platform/config', { skipCache: true, auth: false });
}

export function getWallet(accessToken) {
  return apiFetch('/api/wallet', { skipCache: true, accessToken, _retry401: !accessToken });
}

export function getTransactions(limit = 20, accessToken) {
  return apiFetch(`/api/transactions?limit=${limit}`, { skipCache: true, accessToken, _retry401: !accessToken });
}

export function transferSend({
  recipientHandle,
  amount,
  currency = 'kori',
  note,
  voiceNoteUrl,
  photoUrl,
  videoUrl,
  gifUrl,
  giftCardTheme,
  threadId,
  stepUpToken,
  intentKey,
}) {
  const handle = String(recipientHandle).replace(/^@/, '');
  return apiFetch('/api/transfers/send', {
    method: 'POST',
    body: { recipientHandle: handle, amount, currency, note, voiceNoteUrl, photoUrl, videoUrl, gifUrl, giftCardTheme, threadId },
    stepUpToken,
    skipCache: true,
    idempotencyKey: intentKey,
  });
}

export function getMerchantPublic(idOrKebuId) {
  return apiFetch(`/api/merchants/${encodeURIComponent(idOrKebuId)}/public`, { skipCache: true });
}

export function merchantPay(businessId, { amount, currency = 'kori', stepUpToken, useVoucher, threadId, intentKey }) {
  return apiFetch(`/api/merchants/${encodeURIComponent(businessId)}/pay`, {
    method: 'POST',
    body: { amount, currency, stepUpToken, useVoucher: useVoucher === true ? true : undefined, threadId },
    skipCache: true,
    idempotencyKey: intentKey,
  });
}

export function getMerchantVouchers() {
  return apiFetch('/api/merchant-vouchers/mine', { skipCache: true });
}

export function cashIn({ amount, operator = 'orange_money', phone, intentKey }) {
  return apiFetch('/api/cash/in', {
    method: 'POST',
    body: { amount, operator, phone },
    skipCache: true,
    idempotencyKey: intentKey,
  });
}

export function cashOut({ amount, operator = 'orange_money', phone, stepUpToken, intentKey }) {
  return apiFetch('/api/cash/out', {
    method: 'POST',
    body: { amount, operator, phone },
    stepUpToken,
    skipCache: true,
    idempotencyKey: intentKey,
  });
}

/** Beta / diaspora test credits — requires ALLOW_BETA_DEPOSITS on the server. */
export function depositNational({ amount, source = 'beta' }) {
  return apiFetch('/api/deposits/national', {
    method: 'POST',
    body: { amount, source },
    skipCache: true,
  });
}

/** J6: cash-in intent at an agent. One `intentKey` per attempt (never a second intent on retry). */
export function createCashIntent({ kind, amountXof, intentKey, stepUpToken }) {
  return apiFetch(kind === 'cash_out' ? '/api/agent-cash/out' : '/api/agent-cash/in', { method: 'POST', body: { amountXof }, idempotencyKey: intentKey, stepUpToken, skipCache: true });
}

export function getCashTx(id) {
  return apiFetch(`/api/agent-cash/tx/${encodeURIComponent(id)}`, { skipCache: true });
}

export function listCashTx() {
  return apiFetch('/api/agent-cash/tx', { skipCache: true });
}

/** Customer confirms the bound point + amount (cash-in) or authorizes it with the PIN (cash-out). */
export function confirmCashTx(id, bindingHash, stepUpToken) {
  return apiFetch(`/api/agent-cash/tx/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: { bindingHash }, stepUpToken, skipCache: true });
}

export function cancelCashTx(id) {
  return apiFetch(`/api/agent-cash/tx/${encodeURIComponent(id)}/cancel`, { method: 'POST', skipCache: true });
}

/** New QR for the SAME (still unbound) transaction; the previous QR stops working. */
export function reissueCashChallenge(id) {
  return apiFetch(`/api/agent-cash/tx/${encodeURIComponent(id)}/challenge`, { method: 'POST', skipCache: true });
}

export function getAgentDepositStatus(reference) {
  return apiFetch(`/api/deposits/agent/${encodeURIComponent(reference)}`, { skipCache: true });
}

export function createStripeDepositSession({ amount }) {
  return apiFetch('/api/deposits/card/session', {
    method: 'POST',
    body: { amount },
    skipCache: true,
  });
}

export function getStripeDepositStatus(reference) {
  return apiFetch(`/api/deposits/card/${encodeURIComponent(reference)}`, { skipCache: true });
}

export function getAgentMe() {
  return apiFetch('/api/agent/me', { skipCache: true });
}

/** J6: agent scans the customer's QR (binds this point; reserves float for a cash-in). */
export function agentScanCash(qr) {
  return apiFetch('/api/agent/cash/scan', { method: 'POST', body: { qr }, skipCache: true });
}

/** J6: agent completes after the physical handoff — PIN step-up required. */
export function agentCompleteCash(id, bindingHash, stepUpToken) {
  return apiFetch(`/api/agent/cash/${encodeURIComponent(id)}/complete`, { method: 'POST', body: { bindingHash }, stepUpToken, skipCache: true });
}

export function agentDeclineCash(id, reason) {
  return apiFetch(`/api/agent/cash/${encodeURIComponent(id)}/decline`, { method: 'POST', body: { reason }, skipCache: true });
}

export function getAgentCommissions() {
  return apiFetch('/api/agent/commissions', { skipCache: true });
}

export function settleAgentCommissions(intentKey) {
  return apiFetch('/api/agent/commissions/settle', { method: 'POST', idempotencyKey: intentKey, skipCache: true });
}

export function getAgentCash() {
  return apiFetch('/api/agent/cash', { skipCache: true });
}

export function getMboloThreads() {
  return apiFetch('/api/mbolo/threads', { skipCache: true });
}

/** Incoming message requests (strangers). */
export function getMboloRequests() {
  return apiFetch('/api/mbolo/requests', { skipCache: true });
}

/** action: 'accept' | 'decline' | 'block' */
export function respondMboloRequest(threadId, action) {
  return apiFetch(`/api/mbolo/threads/${encodeURIComponent(threadId)}/${action}`, {
    method: 'POST',
    skipCache: true,
  });
}

export function reportMboloRequest(threadId, { category = 'spam', reason } = {}) {
  return apiFetch(`/api/mbolo/threads/${encodeURIComponent(threadId)}/report`, {
    method: 'POST',
    body: { category, reason },
    skipCache: true,
  });
}

export function createMboloThread({ name, memberHandles = [] }) {
  return apiFetch('/api/mbolo/threads', {
    method: 'POST',
    body: { name, memberHandles },
    skipCache: true,
  });
}

export function broadcastMboloMessage({ recipientHandles, body, kind = 'text', mediaUrl }) {
  return apiFetch('/api/mbolo/broadcast', {
    method: 'POST',
    body: { recipientHandles, body, kind, mediaUrl },
    skipCache: true,
  });
}

export function addMboloThreadMembers(threadId, handles) {
  return apiFetch(`/api/mbolo/threads/${encodeURIComponent(threadId)}/members`, {
    method: 'POST',
    body: { handles },
    skipCache: true,
  });
}

export function getMboloThreadInvite(threadId) {
  return apiFetch(`/api/mbolo/threads/${encodeURIComponent(threadId)}/invite`, {
    method: 'POST',
    skipCache: true,
  });
}

export function joinMboloGroup(code) {
  return apiFetch('/api/mbolo/join-group', {
    method: 'POST',
    body: { code },
    skipCache: true,
  });
}

export function getMboloMessages(threadId, { q, cursor, limit } = {}) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return apiFetch(
    `/api/mbolo/threads/${encodeURIComponent(threadId)}/messages${qs ? `?${qs}` : ''}`,
    { skipCache: true },
  );
}

export function getMboloStorageStatus() {
  return apiFetch('/api/mbolo/storage/status', { skipCache: true });
}

export function mboloMediaUploadUrl(body) {
  return apiFetch('/api/mbolo/media/upload-url', { method: 'POST', body, skipCache: true });
}

export function mboloMediaComplete(body) {
  return apiFetch('/api/mbolo/media/complete', { method: 'POST', body, skipCache: true });
}

export function getMboloVault() {
  return apiFetch('/api/mbolo/vault', { skipCache: true });
}

export function deleteMboloVaultItem(assetId) {
  return apiFetch(`/api/mbolo/vault/${encodeURIComponent(assetId)}`, { method: 'DELETE', skipCache: true });
}

export function getMboloGifs() {
  return apiFetch('/api/mbolo/gifs', { skipCache: true });
}

export function createMboloGif(body) {
  return apiFetch('/api/mbolo/gifs', { method: 'POST', body, skipCache: true });
}

export function useMboloGif(gifId) {
  return apiFetch(`/api/mbolo/gifs/${encodeURIComponent(gifId)}/use`, { method: 'POST', body: {}, skipCache: true });
}

export function sendMboloMessage(threadId, payload) {
  return apiFetch(`/api/mbolo/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    body: payload,
    skipCache: true,
  });
}

export function saveMboloMessageMedia(messageId, { retention = 'vault' } = {}) {
  return apiFetch(`/api/mbolo/messages/${encodeURIComponent(messageId)}/save`, {
    method: 'POST',
    body: { retention },
    skipCache: true,
  });
}

export function getMboloThreadPresence(threadId) {
  return apiFetch(`/api/mbolo/threads/${encodeURIComponent(threadId)}/presence`, { skipCache: true });
}

export function markMboloThreadTyping(threadId) {
  return apiFetch(`/api/mbolo/threads/${encodeURIComponent(threadId)}/typing`, {
    method: 'POST',
    body: {},
    skipCache: true,
  });
}

export function markMboloThreadRead(threadId) {
  return apiFetch(`/api/mbolo/threads/${encodeURIComponent(threadId)}/read`, {
    method: 'POST',
    body: {},
    skipCache: true,
  });
}

export function getMboloStories() {
  return apiFetch('/api/mbolo/stories', { skipCache: true });
}

export function postMboloStory(body) {
  return apiFetch('/api/mbolo/stories', { method: 'POST', body, skipCache: true });
}

export function registerMboloDeviceKey(body) {
  return apiFetch('/api/mbolo/device-keys', { method: 'POST', body, skipCache: true });
}

export function shareToMbolo({ threadId, refType, refId }) {
  return apiFetch('/api/mbolo/share', {
    method: 'POST',
    body: { threadId, refType, refId },
    skipCache: true,
  });
}

/**
 * Config for @vercel/blob/client's upload() — it PUTs the video straight to
 * Blob storage, only calling back to our handleUploadUrl route to mint a
 * short-lived token, so we build that request's auth headers by hand here
 * rather than routing through apiFetch.
 */
export async function getMboloVideoUploadConfig() {
  const [token, deviceId] = await Promise.all([getAccessToken(), getOrCreateDeviceId()]);
  return {
    handleUploadUrl: resolveUrl('/api/mbolo/video/upload-token'),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Device-Id': deviceId,
    },
  };
}

// Event tickets — platform API for separate K21 Events app (not used in main K21 UI)
export function getEvents() {
  return apiFetch('/api/events', { skipCache: true });
}

export function purchaseEventTickets(eventId, quantity = 1) {
  return apiFetch(`/api/events/${encodeURIComponent(eventId)}/tickets`, {
    method: 'POST',
    body: { quantity },
    skipCache: true,
  });
}

export function createEvent(body) {
  return apiFetch('/api/events', { method: 'POST', body, skipCache: true });
}

export function getMyTickets() {
  return apiFetch('/api/tickets/mine', { skipCache: true });
}

export function getMyEvents() {
  return apiFetch('/api/events/mine', { skipCache: true });
}

export function checkInEventTicket(scanCode) {
  const code = String(scanCode).replace(/^.*ticket\//i, '').trim();
  return apiFetch('/api/tickets/check-in', { method: 'POST', body: { scanCode: code }, skipCache: true });
}

export function getJekkalCampaigns(status = 'active') {
  return apiFetch(`/api/jekkal/campaigns?status=${encodeURIComponent(status)}`, { skipCache: true });
}

export function getJekkalCampaign(id) {
  return apiFetch(`/api/jekkal/campaigns/${encodeURIComponent(id)}`, { skipCache: true });
}

export function createJekkalCampaign(body) {
  return apiFetch('/api/jekkal/campaigns', { method: 'POST', body, skipCache: true });
}

export function contributeJekkal(campaignId, body) {
  return apiFetch(`/api/jekkal/campaigns/${encodeURIComponent(campaignId)}/contribute`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function applyAgent(body) {
  return apiFetch('/api/agent/apply', { method: 'POST', body, skipCache: true });
}

export function getAgentApplication() {
  return apiFetch('/api/agent/application', { skipCache: true });
}

/** Self-service float recharge request — an admin still approves it. */
export function requestAgentFloatTopUp(amountXof, note) {
  return apiFetch('/api/agent/float/topup-request', {
    method: 'POST',
    body: { amountXof, note },
    skipCache: true,
  });
}

export function getMyFloatTopUpRequests() {
  return apiFetch('/api/agent/float/topup-requests/mine', { skipCache: true });
}

/** J6.14: active service points only; declared hours; no float / availability claims. */
export function getAgentsNearby({ lat, lng, mode = 'deposit', amount } = {}) {
  const params = new URLSearchParams();
  if (lat != null) params.set('lat', String(lat));
  if (lng != null) params.set('lng', String(lng));
  params.set('service', mode === 'withdraw' ? 'cash_out' : 'cash_in');
  if (amount != null) params.set('amount', String(amount));
  return apiFetch(`/api/agent-cash/points?${params.toString()}`, { skipCache: true });
}


export function getAgentWithdrawStatus(reference) {
  return apiFetch(`/api/withdrawals/agent/${encodeURIComponent(reference)}`, { skipCache: true });
}



export function getInviteShare() {
  return apiFetch('/api/invite/share', { skipCache: true });
}

export function getAgentPayouts() {
  return apiFetch('/api/agent/payouts', { skipCache: true });
}

export function getAffiliateMe() {
  return apiFetch('/api/affiliate/me', { skipCache: true });
}

export function registerAffiliate(displayName) {
  return apiFetch('/api/affiliate/me', { method: 'POST', body: displayName ? { displayName } : {}, skipCache: true });
}

export function createAffiliateLink(body) {
  return apiFetch('/api/affiliate/links', { method: 'POST', body, skipCache: true });
}

export function trackAffiliateClick(linkCode) {
  return apiFetch(`/api/affiliate/links/${encodeURIComponent(linkCode)}/click`, { method: 'POST', skipCache: true });
}

export function shareAffiliateToMbolo(body) {
  return apiFetch('/api/affiliate/mbolo-share', { method: 'POST', body, skipCache: true });
}

export function resolveAffiliate(linkCode) {
  return apiFetch(`/api/affiliate/resolve/${encodeURIComponent(linkCode)}`, { skipCache: true });
}

export function getProducts(category) {
  const q = category ? `?category=${encodeURIComponent(category)}` : '';
  return apiFetch(`/api/products${q}`, { skipCache: true });
}

export function createProduct(body) {
  return apiFetch('/api/products', { method: 'POST', body, skipCache: true });
}

export function getSellerProfile() {
  return apiFetch('/api/sellers/profile', { skipCache: true });
}

export function marketplaceSearch({ q, lat, lng, category }) {
  const params = new URLSearchParams({ q });
  if (lat != null) params.set('lat', String(lat));
  if (lng != null) params.set('lng', String(lng));
  if (category) params.set('category', category);
  return apiFetch(`/api/marketplace/search?${params}`, { skipCache: true });
}

export function marketplaceShopsNearby({ lat, lng, category }) {
  const params = new URLSearchParams();
  if (lat != null) params.set('lat', String(lat));
  if (lng != null) params.set('lng', String(lng));
  if (category) params.set('category', category);
  const q = params.toString() ? `?${params}` : '';
  return apiFetch(`/api/marketplace/shops/nearby${q}`, { skipCache: true });
}

export function getMarketplaceShop(businessId, { lat, lng } = {}) {
  const params = new URLSearchParams();
  if (lat != null) params.set('lat', String(lat));
  if (lng != null) params.set('lng', String(lng));
  const q = params.toString() ? `?${params}` : '';
  return apiFetch(`/api/marketplace/shops/${encodeURIComponent(businessId)}${q}`, { skipCache: true });
}

export function getMarketplaceHubs({ lat, lng, country } = {}) {
  const params = new URLSearchParams();
  if (lat != null) params.set('lat', String(lat));
  if (lng != null) params.set('lng', String(lng));
  if (country) params.set('country', country);
  const q = params.toString() ? `?${params}` : '';
  return apiFetch(`/api/marketplace/hubs${q}`, { skipCache: true });
}

export function getMyHubParcels() {
  return apiFetch('/api/hubs/parcels/mine', { skipCache: true });
}

export function createHubParcel(body) {
  return apiFetch('/api/hubs/parcels', { method: 'POST', body, skipCache: true });
}

export function getHubParcel(parcelId) {
  return apiFetch(`/api/hubs/parcels/${encodeURIComponent(parcelId)}`, { skipCache: true });
}

export function markHubParcelInTransit(parcelId) {
  return apiFetch(`/api/hubs/parcels/${encodeURIComponent(parcelId)}/in-transit`, {
    method: 'POST',
    skipCache: true,
  });
}

export function requestHubParcelLastMile(parcelId, body) {
  return apiFetch(`/api/hubs/parcels/${encodeURIComponent(parcelId)}/last-mile`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function confirmHubParcelPickup(parcelId, pickupCode) {
  return apiFetch(`/api/hubs/parcels/${encodeURIComponent(parcelId)}/pickup`, {
    method: 'POST',
    body: { pickupCode },
    skipCache: true,
  });
}

export function hubParcelArrive(parcelId) {
  return apiFetch(`/api/hubs/parcels/${encodeURIComponent(parcelId)}/arrive`, {
    method: 'POST',
    skipCache: true,
  });
}

export function placeMarketplaceOrder(body, { stepUpToken } = {}) {
  return apiFetch('/api/marketplace/orders', { method: 'POST', body, stepUpToken, skipCache: true });
}

export function getMyMarketplaceOrders() {
  return apiFetch('/api/marketplace/orders/mine', { skipCache: true });
}

export function getMerchantOrders(businessId) {
  return apiFetch(`/api/marketplace/orders/merchant?businessId=${encodeURIComponent(businessId)}`, { skipCache: true });
}

export function getMerchantCatalog(businessId) {
  return apiFetch(`/api/marketplace/catalog/mine?businessId=${encodeURIComponent(businessId)}`, { skipCache: true });
}

export function updateMarketplaceProduct(productId, body) {
  return apiFetch(`/api/marketplace/products/${encodeURIComponent(productId)}`, {
    method: 'PATCH',
    body,
    skipCache: true,
  });
}

export function deleteMarketplaceProduct(productId) {
  return apiFetch(`/api/marketplace/products/${encodeURIComponent(productId)}`, {
    method: 'DELETE',
    skipCache: true,
  });
}

export function recordProductView(productId) {
  return apiFetch(`/api/marketplace/products/${encodeURIComponent(productId)}/view`, {
    method: 'POST',
    skipCache: true,
  });
}

export function getMerchantAnalytics(businessId) {
  return apiFetch(`/api/marketplace/analytics?businessId=${encodeURIComponent(businessId)}`, { skipCache: true });
}

export function updateMarketplaceBusinessSettings(businessId, body) {
  return apiFetch(`/api/marketplace/business/${encodeURIComponent(businessId)}/settings`, {
    method: 'PATCH',
    body,
    skipCache: true,
  });
}

export function getPaymentFunds() {
  return apiFetch('/api/payment-funds', { skipCache: true });
}

export function createPaymentFund(body) {
  return apiFetch('/api/payment-funds', { method: 'POST', body, skipCache: true });
}

export function fundPaymentPot(fundId, amountKori) {
  return apiFetch(`/api/payment-funds/${encodeURIComponent(fundId)}/fund`, {
    method: 'POST',
    body: { amountKori },
    skipCache: true,
  });
}

export function withdrawPaymentFund(fundId, amountKori) {
  return apiFetch(`/api/payment-funds/${encodeURIComponent(fundId)}/withdraw`, {
    method: 'POST',
    body: { amountKori },
    skipCache: true,
  });
}

export function getScheduledPayments() {
  return apiFetch('/api/scheduled-payments', { skipCache: true });
}

export function createScheduledPayment(body) {
  return apiFetch('/api/scheduled-payments', { method: 'POST', body, skipCache: true });
}

export function toggleScheduledPayment(scheduleId, active) {
  return apiFetch(`/api/scheduled-payments/${encodeURIComponent(scheduleId)}`, {
    method: 'PATCH',
    body: { active },
    skipCache: true,
  });
}

export function registerSellerProfile(body) {
  return apiFetch('/api/sellers/profile', { method: 'POST', body, skipCache: true });
}

export function getBusinesses(category) {
  const q = category ? `?category=${encodeURIComponent(category)}` : '';
  return apiFetch(`/api/businesses${q}`, { skipCache: true });
}

export function createBusiness({ name, type = 'merchant', category, arrondissement, description, address, lat, lng }) {
  return apiFetch('/api/businesses', {
    method: 'POST',
    body: { name, type, category, arrondissement, description, address, lat, lng },
    skipCache: true,
  });
}

/** Business status update (owner/admin) — same idea as a personal status,
 * for the place itself: a promo, "on recrute", inscriptions ouvertes, etc. */
export function setBusinessStatus(businessId, statusText) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/status`, {
    method: 'POST',
    body: { statusText: statusText?.trim() || null },
    skipCache: true,
  });
}

/** Community status — posted by a student (K21 Pass linked here) or staff
 * member, not the business itself. Shows alongside the official status. */
export function setBusinessCommunityStatus(businessId, statusText) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/community-status`, {
    method: 'POST',
    body: { statusText: statusText?.trim() || null },
    skipCache: true,
  });
}

export function getMyBusinesses() {
  return apiFetch('/api/businesses/mine', { skipCache: true });
}

export function getBusiness(id) {
  return apiFetch(`/api/businesses/${encodeURIComponent(id)}`, { skipCache: true });
}

export function getBusinessWallet(businessId, limit = 30) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/wallet?limit=${limit}`, { skipCache: true });
}

export function getBusinessCreditSummary(businessId) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/credit-summary`, { skipCache: true });
}

export function transferBusinessFunds(businessId, body) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/transfer`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function getBusinessMembers(businessId) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/members`, { skipCache: true });
}

export function inviteBusinessMember(businessId, body) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/members`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function getPayrollGroups(businessId) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/payroll/groups`, { skipCache: true });
}

export function createPayrollGroup(businessId, body) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/payroll/groups`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function getPayrollEmployees(businessId) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/payroll/employees`, { skipCache: true });
}

export function addPayrollEmployee(businessId, body) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/payroll/employees`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function payPayrollEmployee(businessId, body) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/payroll/pay`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function runPayrollBatch(businessId, body = {}) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/payroll/run`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function getSchoolStudents(businessId) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/school/students`, { skipCache: true });
}

export function enrollSchoolStudent(businessId, body) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/school/students`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function getSchoolFeePeriods(businessId) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/school/periods`, { skipCache: true });
}

export function createSchoolFeePeriod(businessId, body) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/school/periods`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function getSchoolPeriodStatus(businessId, periodId) {
  return apiFetch(
    `/api/businesses/${encodeURIComponent(businessId)}/school/periods/${encodeURIComponent(periodId)}/status`,
    { skipCache: true },
  );
}

export function paySchoolFee(businessId, body) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/school/pay`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function remindSchoolFees(businessId, periodId) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/school/remind`, {
    method: 'POST',
    body: { periodId },
    skipCache: true,
  });
}

export function getCooperativeDeliveries(businessId, query = {}) {
  const params = new URLSearchParams(query);
  const q = params.toString() ? `?${params}` : '';
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/cooperative/deliveries${q}`, {
    skipCache: true,
  });
}

export function logCooperativeDelivery(businessId, body) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/cooperative/deliveries`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function verifyCooperativeDelivery(businessId, deliveryId, body) {
  return apiFetch(
    `/api/businesses/${encodeURIComponent(businessId)}/cooperative/deliveries/${encodeURIComponent(deliveryId)}/verify`,
    { method: 'POST', body, skipCache: true },
  );
}

export function payoutCooperativeFarmer(businessId, body) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/cooperative/payout`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function syncOfflineQueue(items) {
  return apiFetch('/api/offline/sync', { method: 'POST', body: { items }, skipCache: true });
}

export function getBlocks() {
  return apiFetch('/api/trust/blocks', { skipCache: true });
}

export function blockTarget(body) {
  return apiFetch('/api/trust/block', { method: 'POST', body, skipCache: true });
}

export function unblockTarget(blockId) {
  return apiFetch(`/api/trust/block/${encodeURIComponent(blockId)}`, { method: 'DELETE', skipCache: true });
}

export function submitReport(body) {
  return apiFetch('/api/trust/report', { method: 'POST', body, skipCache: true });
}

export function getTontineGroups() {
  return apiFetch('/api/tontine/groups', { skipCache: true });
}

export function createTontineGroup(body) {
  return apiFetch('/api/tontine/groups', { method: 'POST', body, skipCache: true });
}

function tontineAction(groupId, action, body) {
  return apiFetch(`/api/tontine/groups/${encodeURIComponent(groupId)}/${action}`, { method: 'POST', body, skipCache: true });
}

/** Consent + escrow model: nothing is ever debited without the member's own action. */
export const acceptTontineInvite = (groupId) => tontineAction(groupId, 'accept');
export const declineTontineInvite = (groupId) => tontineAction(groupId, 'decline');
export const startTontine = (groupId) => tontineAction(groupId, 'start');
export const contributeToTontine = (groupId) => tontineAction(groupId, 'contribute');
export const cancelTontine = (groupId) => tontineAction(groupId, 'cancel');
export const leaveTontine = (groupId) => tontineAction(groupId, 'leave');

export function releaseTontinePot(groupId) {
  return apiFetch(`/api/tontine/groups/${encodeURIComponent(groupId)}/release`, {
    method: 'POST',
    skipCache: true,
  });
}

export function getFriends() {
  return apiFetch('/api/friends', { skipCache: true });
}

/** Sends a friend REQUEST (the other person must accept) — WeChat model. */
export function addFriend(handle, message) {
  return apiFetch('/api/friends', {
    method: 'POST',
    body: { handle: String(handle).replace(/^@/, ''), ...(message ? { message } : {}) },
    skipCache: true,
  });
}

export function getFriendRequests() {
  return apiFetch('/api/friends/requests', { skipCache: true });
}

export function respondFriendRequest(requestId, accept) {
  return apiFetch(`/api/friends/requests/${encodeURIComponent(requestId)}/respond`, {
    method: 'POST',
    body: { accept: accept !== false },
    skipCache: true,
  });
}

export function getVouchStatus() {
  return apiFetch('/api/trust/vouch', { skipCache: true });
}

/** LiveKit room token for a Mboolo call. ring=true announces the call. */
export function getCallToken({ threadId, video = false, ring = false }) {
  return apiFetch('/api/calls/token', {
    method: 'POST',
    body: { threadId, video, ring },
    skipCache: true,
  });
}

/** Confirm another member after scanning their QR (6-month+ accounts only). */
export function vouchForUser(handle) {
  return apiFetch('/api/trust/vouch', {
    method: 'POST',
    body: { handle: String(handle).replace(/^@/, '') },
    skipCache: true,
  });
}

export function removeFriend(friendUserId) {
  return apiFetch(`/api/friends/${encodeURIComponent(friendUserId)}`, { method: 'DELETE', skipCache: true });
}

export function getNotifications() {
  return apiFetch('/api/notifications', { skipCache: true });
}

export function markNotificationRead(id) {
  return apiFetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', skipCache: true });
}

export function transferRequest({ recipientHandle, amount, note, purposeCategory, lockToBusinessId, voiceNoteUrl, photoUrl, videoUrl }) {
  const handle = String(recipientHandle).replace(/^@/, '');
  return apiFetch('/api/transfers/request', {
    method: 'POST',
    body: {
      recipientHandle: handle,
      amount,
      currency: 'kori',
      purposeCategory: purposeCategory ?? 'general',
      note,
      lockToBusinessId,
      voiceNoteUrl,
      photoUrl,
      videoUrl,
    },
    skipCache: true,
  });
}

export function getTransferRequests(role = 'all') {
  return apiFetch(`/api/transfers/requests?role=${encodeURIComponent(role)}`, { skipCache: true });
}

export function acceptTransferRequest(id, { stepUpToken, intentKey } = {}) {
  return apiFetch(`/api/transfers/requests/${encodeURIComponent(id)}/accept`, {
    method: 'POST',
    stepUpToken,
    skipCache: true,
    idempotencyKey: intentKey,
  });
}

export function denyTransferRequest(id) {
  return apiFetch(`/api/transfers/requests/${encodeURIComponent(id)}/deny`, { method: 'POST', skipCache: true });
}

export function cancelTransferRequest(id) {
  return apiFetch(`/api/transfers/requests/${encodeURIComponent(id)}/cancel`, { method: 'POST', skipCache: true });
}

export function authPinSet(pin) {
  return apiFetch('/api/auth/pin/set', { method: 'POST', body: { pin } });
}

export function authPinVerify(pin, forStepUp = true) {
  return apiFetch('/api/auth/pin/verify', { method: 'POST', body: { pin, forStepUp } });
}

export function authPinUnlock(cniNumber) {
  return apiFetch('/api/auth/pin/unlock', { method: 'POST', body: { cniNumber } });
}

export function authBiometricEnable(enabled) {
  return apiFetch('/api/auth/biometric', { method: 'POST', body: { enabled } });
}

export function kycStatus() {
  return apiFetch('/api/kyc/status');
}

export function kycSubmitCni({ frontImage, backImage, selfieImage }) {
  return apiFetch('/api/kyc/cni/submit', {
    method: 'POST',
    body: { frontImage, backImage, selfieImage },
  });
}

export function kycSubmitAddress({ addressLine, city, region }) {
  return apiFetch('/api/kyc/address/submit', {
    method: 'POST',
    body: { addressLine, city, region },
  });
}

export function getNearbyDeliveries(query = {}) {
  const params = new URLSearchParams(query);
  const q = params.toString() ? `?${params}` : '';
  return apiFetch(`/api/deliveries/nearby${q}`, { skipCache: true });
}

export function acceptDelivery(deliveryId) {
  return apiFetch(`/api/deliveries/${encodeURIComponent(deliveryId)}/accept`, {
    method: 'POST',
    skipCache: true,
  });
}

export function getDeliveryDetail(deliveryId) {
  return apiFetch(`/api/deliveries/${encodeURIComponent(deliveryId)}`, { skipCache: true });
}

export function markDeliveryPickup(deliveryId) {
  return apiFetch(`/api/deliveries/${encodeURIComponent(deliveryId)}/pickup`, {
    method: 'POST',
    skipCache: true,
  });
}

export function markDeliveryDelivered(deliveryId) {
  return apiFetch(`/api/deliveries/${encodeURIComponent(deliveryId)}/deliver`, {
    method: 'POST',
    skipCache: true,
  });
}

export function confirmDelivery(deliveryId) {
  return apiFetch(`/api/deliveries/${encodeURIComponent(deliveryId)}/confirm`, {
    method: 'POST',
    skipCache: true,
  });
}

export function getMyActiveDeliveries() {
  return apiFetch('/api/deliveries/active/mine', { skipCache: true });
}

export function getMarketplaceOrder(orderId) {
  return apiFetch(`/api/marketplace/orders/${encodeURIComponent(orderId)}`, { skipCache: true });
}

export function updateMarketplaceOrderStatus(orderId, status) {
  return apiFetch(`/api/marketplace/orders/${encodeURIComponent(orderId)}/status`, {
    method: 'PATCH',
    body: { status },
    skipCache: true,
  });
}

export function confirmMarketplaceOrder(orderId, { stepUpToken } = {}) {
  return apiFetch(`/api/marketplace/orders/${encodeURIComponent(orderId)}/confirm`, {
    method: 'POST',
    stepUpToken,
    skipCache: true,
  });
}

export function getBuyerTradeSummary(businessId) {
  return apiFetch(`/api/distribution/trade-summary?businessId=${encodeURIComponent(businessId)}`, {
    skipCache: true,
  });
}

export function getBuyerPortalSuppliers() {
  return apiFetch('/api/distribution/buyer-portal', { skipCache: true });
}

export function getBuyerPortalCatalog(businessId) {
  return apiFetch(
    `/api/distribution/buyer-portal/catalog?businessId=${encodeURIComponent(businessId)}`,
    { skipCache: true },
  );
}

export function getSupplierReceivables(businessId) {
  return apiFetch(`/api/distribution/receivables?businessId=${encodeURIComponent(businessId)}`, {
    skipCache: true,
  });
}

/** KEBU score — built from real on-time invoice payment, KYC tier, tenure,
 * transaction volume, and reviews. Used to inform B2B credit decisions. */
export function getBusinessKebuScore(businessId) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/kebu-score`, { skipCache: true });
}

export function getSupportContact() {
  return apiFetch('/api/support/contact', { skipCache: true });
}

export function getMySupportTickets() {
  return apiFetch('/api/support/tickets/mine', { skipCache: true });
}

export function createSupportTicket(body) {
  return apiFetch('/api/support/tickets', { method: 'POST', body, skipCache: true });
}

export function getSupportTicket(ticketId) {
  return apiFetch(`/api/support/tickets/${encodeURIComponent(ticketId)}`, { skipCache: true });
}

export function replySupportTicket(ticketId, body) {
  return apiFetch(`/api/support/tickets/${encodeURIComponent(ticketId)}/reply`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function registerDistributionBrand(body) {
  return apiFetch('/api/distribution/brand/register', { method: 'POST', body, skipCache: true });
}

export function getMyDistributionBrand() {
  return apiFetch('/api/distribution/brand/mine', { skipCache: true });
}

export function getTradeAccounts(businessId) {
  return apiFetch(`/api/distribution/trade-accounts?businessId=${encodeURIComponent(businessId)}`, {
    skipCache: true,
  });
}

export function upsertTradeAccount(businessId, body) {
  return apiFetch(`/api/distribution/trade-accounts?businessId=${encodeURIComponent(businessId)}`, {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function getMyTradeInvoices(status) {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiFetch(`/api/distribution/invoices/mine${q}`, { skipCache: true });
}

export function getSupplierTradeInvoices(businessId, status) {
  const params = new URLSearchParams({ businessId });
  if (status) params.set('status', status);
  return apiFetch(`/api/distribution/invoices/supplier?${params}`, { skipCache: true });
}

export function payTradeInvoice(invoiceId, { stepUpToken, paymentSource, buyerBusinessId } = {}) {
  return apiFetch(`/api/distribution/invoices/${encodeURIComponent(invoiceId)}/pay`, {
    method: 'POST',
    body: { paymentSource, buyerBusinessId },
    stepUpToken,
    skipCache: true,
  });
}

export function disputeTradeInvoice(invoiceId, reason) {
  return apiFetch(`/api/distribution/invoices/${encodeURIComponent(invoiceId)}/dispute`, {
    method: 'POST',
    body: { reason },
    skipCache: true,
  });
}

export function resolveTradeInvoiceDispute(invoiceId, { action, note, newAmountKori } = {}) {
  return apiFetch(`/api/distribution/invoices/${encodeURIComponent(invoiceId)}/dispute-resolve`, {
    method: 'POST',
    body: { action, note, newAmountKori },
    skipCache: true,
  });
}

export function registerDriverProfile(body = {}) {
  return apiFetch('/api/drivers/profile', {
    method: 'POST',
    body,
    skipCache: true,
  });
}

export function getWorkerProfile() {
  return apiFetch('/api/workers/profile', { skipCache: true });
}

export function activateWorkerProfile(modes) {
  return apiFetch('/api/workers/profile', {
    method: 'POST',
    body: { modes },
    skipCache: true,
  });
}

export function getWorkerReceipts(limit = 50) {
  return apiFetch(`/api/workers/receipts?limit=${limit}`, { skipCache: true });
}

export function getWorkerCreditSummary() {
  return apiFetch('/api/workers/credit-summary', { skipCache: true });
}

export function requestDelivery(body) {
  return apiFetch('/api/deliveries', {
    method: 'POST',
    body,
    skipCache: true,
  });
}

// ── K21 Charts — community song poll + YouTube SN trending ──

export function getWeeklyChart() {
  return apiFetch('/api/charts', { skipCache: true });
}

export function submitChartSong({ title, artist, videoId }) {
  return apiFetch('/api/charts/submit', { method: 'POST', body: { title, artist, videoId }, skipCache: true });
}

export function searchChartSongs(q) {
  return apiFetch(`/api/charts/search?q=${encodeURIComponent(q)}`, { skipCache: true });
}

export function voteChartSong(songId) {
  return apiFetch('/api/charts/vote', { method: 'POST', body: { songId }, skipCache: true });
}

// ── OpenStreetMap address search (server-side Nominatim proxy) ──

export function geoSearchAddress(q) {
  return apiFetch(`/api/geo/search?q=${encodeURIComponent(q)}`, { skipCache: true });
}

// ── Real merchant reviews ──

export function getBusinessReviews(businessId) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/reviews`, { skipCache: true });
}

export function submitBusinessReview(businessId, { rating, text }) {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/reviews`, {
    method: 'POST',
    body: { rating, text },
    skipCache: true,
  });
}

// ── Public profiles + flash deals ──

export function getPublicProfile(handle) {
  return apiFetch(`/api/profiles/${encodeURIComponent(String(handle).replace(/^@+/, ''))}`, { skipCache: true });
}

export function getFlashDeals() {
  return apiFetch('/api/products?flash=1', { skipCache: true });
}

export function createFlashDeal({ businessId, title, price, flashPrice, flashHours, category = 'deal' }) {
  return apiFetch('/api/products', {
    method: 'POST',
    body: { businessId, title, price, flashPrice, flashHours, category },
    skipCache: true,
  });
}


// ── Profile polls ──

export function askProfilePoll({ question, options }) {
  return apiFetch('/api/polls', { method: 'POST', body: { question, options }, skipCache: true });
}

export function closeProfilePoll() {
  return apiFetch('/api/polls', { method: 'POST', body: { close: true }, skipCache: true });
}

export function voteProfilePoll(pollId, optionIx) {
  return apiFetch(`/api/polls/${encodeURIComponent(pollId)}/vote`, {
    method: 'POST',
    body: { optionIx },
    skipCache: true,
  });
}


// ── Channels ──

export function getMyChannel() {
  return apiFetch('/api/channels/mine', { skipCache: true });
}

export function saveMyChannel({ name, bio }) {
  return apiFetch('/api/channels/mine', { method: 'POST', body: { name, bio }, skipCache: true });
}

export function publishChannelPost({ body, imageUrl }) {
  return apiFetch('/api/channels/posts', { method: 'POST', body: { body, imageUrl }, skipCache: true });
}

export function deleteChannelPost(postId) {
  return apiFetch(`/api/channels/posts/${encodeURIComponent(postId)}/delete`, { method: 'POST', skipCache: true });
}

export function browseChannelsList() {
  return apiFetch('/api/channels', { skipCache: true });
}

export function getChannelFeed() {
  return apiFetch('/api/channels/feed', { skipCache: true });
}

export function getChannel(channelId) {
  return apiFetch(`/api/channels/${encodeURIComponent(channelId)}`, { skipCache: true });
}

export function followChannel(channelId, follow = true) {
  return apiFetch(`/api/channels/${encodeURIComponent(channelId)}/follow`, {
    method: 'POST',
    body: { follow },
    skipCache: true,
  });
}

// ── J4 Money read model & primitives ────────────────────────────────────────
export function getMoneyHome() {
  return apiFetch('/api/money/home', { skipCache: true });
}

export function getMoneyActivity({ limit = 30, before } = {}) {
  const q = new URLSearchParams({ limit: String(limit), ...(before ? { before } : {}) });
  return apiFetch(`/api/money/activity?${q}`, { skipCache: true });
}

export function getMoneyReceipt(reference) {
  return apiFetch(`/api/money/activity/${encodeURIComponent(reference)}`, { skipCache: true });
}

export function previewMoney(flow, amountKori) {
  return apiFetch('/api/money/preview', { method: 'POST', body: { flow, amountKori }, skipCache: true });
}

/** "Did my payment go through?" — never guess, never re-send blindly. */
export function getMoneyIntent(intentKey) {
  return apiFetch(`/api/money/intents/${encodeURIComponent(intentKey)}`, { skipCache: true });
}

export function createMerchantCharge({ businessId, amountKori, label, externalRef, orderId }) {
  return apiFetch('/api/money/charges', { method: 'POST', body: { businessId, amountKori, label, externalRef, orderId }, skipCache: true });
}

export function viewMerchantCharge(code) {
  return apiFetch(`/api/money/charges/${encodeURIComponent(code)}`, { skipCache: true });
}

export function payMerchantCharge(code, { expectedAmountKori, stepUpToken, intentKey }) {
  return apiFetch(`/api/money/charges/${encodeURIComponent(code)}/pay`, {
    method: 'POST',
    body: { expectedAmountKori },
    stepUpToken,
    skipCache: true,
    idempotencyKey: intentKey,
  });
}

export function refundReceivedPayment(reference, { amountKori, reason, intentKey }) {
  return apiFetch(`/api/money/payments/${encodeURIComponent(reference)}/refund`, {
    method: 'POST',
    body: { amountKori, reason },
    skipCache: true,
    idempotencyKey: intentKey,
  });
}

// ── J5 Merchant + Business OS ────────────────────────────────────────────────
const bos = (businessId, path = '') => `/api/businesses/${encodeURIComponent(businessId)}/os${path}`;
export const getBusinessAccess = (id) => apiFetch(bos(id, '/access'), { skipCache: true });
export const getBusinessProfile = (id) => apiFetch(bos(id, '/profile'), { skipCache: true });
export const updateBusinessProfile = (id, body) => apiFetch(bos(id, '/profile'), { method: 'PATCH', body, skipCache: true });
export const addBusinessLocation = (id, body) => apiFetch(bos(id, '/locations'), { method: 'POST', body, skipCache: true });
export const switchBusinessSettlement = (id) => apiFetch(bos(id, '/settlement'), { method: 'POST', body: {}, skipCache: true });
export const requestBusinessVerification = (id, note) => apiFetch(bos(id, '/verification'), { method: 'POST', body: { note }, skipCache: true });
export const getBusinessToday = (id) => apiFetch(bos(id, '/today'), { skipCache: true });
export const getBusinessCatalog = (id) => apiFetch(bos(id, '/catalog'), { skipCache: true });
export const createCatalogItem = (id, body) => apiFetch(bos(id, '/catalog'), { method: 'POST', body, skipCache: true });
export const updateCatalogItem = (id, productId, body) => apiFetch(bos(id, `/catalog/${encodeURIComponent(productId)}`), { method: 'PATCH', body, skipCache: true });
export const adjustStock = (id, productId, body) => apiFetch(bos(id, `/stock/${encodeURIComponent(productId)}/adjust`), { method: 'POST', body, skipCache: true });
export const getStockHistory = (id, productId) => apiFetch(bos(id, `/stock/${encodeURIComponent(productId)}/history`), { skipCache: true });
export const getBusinessOrders = (id, status) => apiFetch(bos(id, `/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`), { skipCache: true });
export const moveBusinessOrder = (id, orderId, status) => apiFetch(bos(id, `/orders/${encodeURIComponent(orderId)}/status`), { method: 'POST', body: { status }, skipCache: true });
export const cancelBusinessOrder = (id, orderId, reason, intentKey) =>
  apiFetch(bos(id, `/orders/${encodeURIComponent(orderId)}/cancel`), { method: 'POST', body: { reason }, skipCache: true, idempotencyKey: intentKey });
export const refundBusinessOrder = (id, orderId, { reason, restock }, intentKey) =>
  apiFetch(bos(id, `/orders/${encodeURIComponent(orderId)}/refund`), { method: 'POST', body: { reason, restock }, skipCache: true, idempotencyKey: intentKey });
export const cancelMyOrder = (orderId, reason, intentKey) =>
  apiFetch(`/api/marketplace/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST', body: { reason }, skipCache: true, idempotencyKey: intentKey });
export const getBusinessMoney = (id) => apiFetch(bos(id, '/money'), { skipCache: true });
export const getBusinessAnalytics = (id, period = '30d') => apiFetch(bos(id, `/analytics?period=${encodeURIComponent(period)}`), { skipCache: true });
export const getBusinessCustomers = (id) => apiFetch(bos(id, '/customers'), { skipCache: true });
export const getBusinessCharges = (id, status) => apiFetch(bos(id, `/charges${status ? `?status=${encodeURIComponent(status)}` : ''}`), { skipCache: true });
export const cancelMerchantCharge = (code) => apiFetch(`/api/money/charges/${encodeURIComponent(code)}/cancel`, { method: 'POST', body: {}, skipCache: true });
export const changeBusinessMemberRole = (id, memberId, role) =>
  apiFetch(`/api/businesses/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}/role`, { method: 'POST', body: { role }, skipCache: true });
export const removeBusinessMember = (id, memberId, reason) =>
  apiFetch(`/api/businesses/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}/remove`, { method: 'POST', body: { reason }, skipCache: true });
export const getBusinessPayments = (id) => apiFetch(bos(id, '/payments'), { skipCache: true });
export const recordManualSale = (id, body) => apiFetch(bos(id, '/sales/manual'), { method: 'POST', body, skipCache: true });
export const getMerchantRelationships = (id) => apiFetch(bos(id, '/relationships'), { skipCache: true });
export const respondMerchantRelationship = (id, relId, accept) =>
  apiFetch(bos(id, `/relationships/${encodeURIComponent(relId)}/respond`), { method: 'POST', body: { accept }, skipCache: true });
export const endMerchantRelationship = (id, relId) => apiFetch(bos(id, `/relationships/${encodeURIComponent(relId)}/end`), { method: 'POST', body: {}, skipCache: true });
