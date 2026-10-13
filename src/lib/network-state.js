/**
 * J12 — what the app knows about the network, derived from real requests (no native dependency):
 *   online   last request answered in time
 *   weak     last request answered slowly (≥ SLOW_MS) or needed its automatic retry
 *   offline  last request could not reach the server (or the browser reports offline)
 * Pure store + subscribe; the UI shows it, the money flows never rely on it (the server decides).
 */
export const SLOW_MS = 8_000;
let state = { status: 'online', since: Date.now() };
const listeners = new Set();

export function networkState() {
  return state;
}

function set(status, now = Date.now()) {
  if (state.status === status) return;
  state = { status, since: now };
  for (const l of listeners) {
    try {
      l(state);
    } catch {
      /* a listener never breaks reporting */
    }
  }
}

/** Called by the API client after every request attempt. */
export function reportRequest({ ok, unreachable = false, ms = 0, retried = false }) {
  if (unreachable) set('offline');
  else if (ok || ms) set(ms >= SLOW_MS || retried ? 'weak' : 'online');
}

export function reportBrowserOnline(online) {
  set(online ? 'online' : 'offline');
}

export function subscribeNetwork(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** User-facing text: honest about what does and does not happen while offline. */
export function networkMessage(status) {
  if (status === 'offline') return 'Hors ligne — rien n’est envoyé. Tes messages attendent ; un paiement ne part jamais hors ligne.';
  if (status === 'weak') return 'Connexion lente — les envois peuvent prendre du temps. Ne renouvelle pas un paiement en cours.';
  return null;
}

export function __resetNetworkState() {
  state = { status: 'online', since: Date.now() };
  listeners.clear();
}
