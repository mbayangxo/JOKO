/**
 * J12 — offline drafts for NON-financial forms (pure core + storage adapter; unit-tested).
 *  - Only forms on the allowlist can be drafted. Money forms (amounts, recipients, payouts) are never
 *    drafted: a payment is always typed and confirmed fresh.
 *  - Per user (a shared phone never shows A's draft to B), expire after 7 days, size-capped, and all of
 *    the signed-out user's drafts are removed at sign-out.
 *  - A draft is only text the user typed; restoring it never submits anything.
 */
export const DRAFTABLE = ['work-post', 'work-evidence-note', 'collective-dispute', 'support-ticket', 'mbolo-compose', 'report-reason'];
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DRAFT_MAX_CHARS = 8_000;
const KEY = 'k21_drafts_v1';
const MONEY_FIELD = /amount|montant|kori|xof|rate|units|price|prix|wage|recipient|destinataire|iban|pin|otp|password|card/i;

const defaultStorage = {
  async get() {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(KEY);
    const SecureStore = await import('expo-secure-store');
    return SecureStore.getItemAsync(KEY);
  },
  async set(v) {
    if (typeof localStorage !== 'undefined') return localStorage.setItem(KEY, v);
    const SecureStore = await import('expo-secure-store');
    return SecureStore.setItemAsync(KEY, v);
  },
};

async function readAll(storage) {
  try {
    const v = JSON.parse((await storage.get()) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const slot = (userId, form, scope) => `${userId}|${form}|${scope ?? ''}`;

/** Keep only plain text fields that are not money/credential fields. */
export function sanitizeDraft(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (MONEY_FIELD.test(k)) continue;
    if (typeof v === 'string' && v.trim()) out[k] = v.slice(0, DRAFT_MAX_CHARS);
  }
  return out;
}

export async function saveDraft({ userId, form, scope = '', fields, now = Date.now() }, storage = defaultStorage) {
  if (!userId || !DRAFTABLE.includes(form)) return false;
  const all = await readAll(storage);
  const clean = sanitizeDraft(fields);
  const k = slot(userId, form, scope);
  if (Object.keys(clean).length === 0) delete all[k];
  else all[k] = { fields: clean, savedAt: now };
  await storage.set(JSON.stringify(all));
  return true;
}

export async function loadDraft({ userId, form, scope = '', now = Date.now() }, storage = defaultStorage) {
  if (!userId || !DRAFTABLE.includes(form)) return null;
  const all = await readAll(storage);
  const d = all[slot(userId, form, scope)];
  if (!d) return null;
  if (now - d.savedAt > DRAFT_TTL_MS || d.savedAt - now > 5 * 60 * 1000) return null; // expired or clock-ambiguous
  return d;
}

export async function clearDraft({ userId, form, scope = '' }, storage = defaultStorage) {
  const all = await readAll(storage);
  delete all[slot(userId, form, scope)];
  await storage.set(JSON.stringify(all));
}

/** Sign-out: remove every draft of that user, and anything expired. */
export async function clearUserDrafts(userId, { now = Date.now() } = {}, storage = defaultStorage) {
  const all = await readAll(storage);
  for (const [k, d] of Object.entries(all)) {
    if (k.startsWith(`${userId}|`) || now - (d?.savedAt ?? 0) > DRAFT_TTL_MS) delete all[k];
  }
  await storage.set(JSON.stringify(all));
}
