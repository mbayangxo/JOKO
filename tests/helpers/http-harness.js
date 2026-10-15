/**
 * Black-box HTTP harness: runs api/index.js in a child process with
 * NODE_ENV=production (or any env) against the test database, and a tiny
 * fetch client. Use for proofs that must hold in the production runtime.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeDatabaseUrl } from '../../lib/db-url.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB =
  'postgres://postgres:postgres@localhost:51214/template1?sslmode=disable&pgbouncer=true&connection_limit=20&pool_timeout=120';

export const BASE_ENV = {
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'http-test-access-secret-0123456789',
  JWT_REFRESH_SECRET: 'http-test-refresh-secret-0123456789',
  ADMIN_JWT_SECRET: 'http-test-admin-secret-0123456789abcd',
  CRON_SECRET: 'http-test-cron-secret',
  EXTERNAL_API_TIMEOUT_MS: '300',
  EXTERNAL_API_RETRY_GAP_MS: '10',
  EXTERNAL_API_MAX_RETRIES: '1',
  // J15-D3: partner limits are now shared across processes and test files (one Postgres counter); tests that
  // exercise limits set JOKO_PARTNER_RATE_LIMITS explicitly.
  JOKO_PARTNER_RATE_LIMIT_DEFAULT: '100000',
};

/** Env keys that must never leak from the developer shell into a prod-mode test server. */
export const SCRUB = [
  'JULAYA_API_KEY', 'JULAYA_API_KEY_SANDBOX', 'JULAYA_API_KEY_PRODUCTION', 'JULAYA_WEBHOOK_SECRET',
  'ALLOW_BETA_OTP', 'ALLOW_BETA_DEPOSITS', 'RESEND_API_KEY', 'AFRICASTALKING_API_KEY', 'TWILIO_ACCOUNT_SID',
  'JOKO_API_KEY', 'JOKO_API_KEYS', 'PARTNER_SETTLEMENT_USER_ID', 'PLATFORM_INCENTIVES_ENABLED',
  'LEMFI_API_KEY', 'LEMFI_API_KEY_SANDBOX', 'STRIPE_SECRET_KEY',
  // J14-S1: a dormant feature is enabled only by an explicit override, never inherited from the test process.
  'PARTNER_EVENTS_ENABLED', 'PARTNER_EVENTS_ALLOW_LOCAL',
  // J14-S6
  'PARTNER_SCOPED_KEYS_ENABLED', 'JOKO_PARTNER_RATE_LIMITS', 'PARTNER_PRODUCT_MAPPING_ENABLED', 'PARTNER_FULFILLMENT_ENABLED',
  'MBOLO_ORDER_CARD_ENABLED', 'PARTNER_LEGACY_SETTLEMENT_PARTNERS', 'PARTNER_LEGACY_PLATFORM_SETTLEMENT',
  'PARTNER_AUDIT_RETENTION_ENABLED', 'PARTNER_AUDIT_LEGAL_HOLD', 'PARTNER_AUDIT_RETENTION_DAYS', 'MBOLO_ORDER_EXPIRY_ENABLED',
  'PARTNER_DEBIT_INSTRUCTIONS_ENABLED',
  // J15 lab: never inherited; a lab server receives them explicitly.
  'JOKKO_LAB', 'JOKKO_LAB_ALLOW', 'IDEMPOTENCY_STALE_LEASE_MS', 'JOKKO_LAB_FAULT_FILE', 'JOKKO_LAB_EVENT_LOG', 'JOKKO_LAB_WORKER', 'VERCEL', 'VERCEL_ENV',
];

function spawnServer(env) {
  const child = spawn(process.execPath, [join(here, 'prod-api-server.mjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, logs: '' };
  child.stderr.on('data', (d) => { state.logs += d; });

  state.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`API server did not start:\n${state.logs}`)), 20_000);
    child.stdout.on('data', (d) => {
      state.logs += d;
      const m = String(d).match(/LISTENING (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => reject(new Error(`API server exited ${code}:\n${state.logs}`)));
  });
  state.stop = () =>
    new Promise((resolve) => {
      child.removeAllListeners('exit');
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  return state;
}

/**
 * J15 lab mode (opt-in, local only): LAB_HARNESS_WORKERS=N starts N API processes on the same database with
 * the lab fault hooks live (LAB_HARNESS_FAULT_FILE / LAB_HARNESS_EVENT_LOG) and spreads calls round-robin,
 * so every existing HTTP suite runs multi-instance. Unset (the default): exactly one process, as before.
 */
export async function startApiServer(overrides = {}) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  Object.assign(env, BASE_ENV, {
    DATABASE_URL: normalizeDatabaseUrl(process.env.DATABASE_URL?.trim() || DEFAULT_DB),
  }, overrides);
  const workers = Math.max(1, Number(process.env.LAB_HARNESS_WORKERS ?? 1) || 1);
  if (workers > 1) {
    Object.assign(env, { JOKKO_LAB: 'true', JOKKO_LAB_ALLOW: 'local-only' });
    if (process.env.LAB_HARNESS_FAULT_FILE) env.JOKKO_LAB_FAULT_FILE = process.env.LAB_HARNESS_FAULT_FILE;
    if (process.env.LAB_HARNESS_EVENT_LOG) env.JOKKO_LAB_EVENT_LOG = process.env.LAB_HARNESS_EVENT_LOG;
  }

  const servers = Array.from({ length: workers }, (_, i) => spawnServer(workers > 1 ? { ...env, JOKKO_LAB_WORKER: `w${i}` } : env));
  const ports = await Promise.all(servers.map((sv) => sv.ready));
  const bases = ports.map((port) => `http://127.0.0.1:${port}`);
  const clients = bases.map((b) => makeClient(b));
  let rr = 0;
  return {
    base: bases[0],
    bases,
    logs: () => servers.map((sv) => sv.logs).join('\n'),
    stop: () => Promise.all(servers.map((sv) => sv.stop())).then(() => undefined),
    client: workers > 1 ? (...a) => clients[(rr++) % workers](...a) : clients[0],
  };
}

// Random start per process: test files run in separate processes within the same 10-minute
// auth-limit window, and a fixed start made every file reuse 10.0.0.1… (shared per-IP OTP buckets).
let ipCounter = Math.floor(Math.random() * 0xfff000);
/** A distinct synthetic client IP per caller so per-IP limits don't bleed across tests. */
export function freshIp() {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export function makeClient(base) {
  return async function call(method, path, { token, body, headers = {}, device, ip, raw } = {}) {
    const res = await fetch(`${base}/api/${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        ...(ip ? { 'x-forwarded-for': ip } : {}),
        ...(device ? { 'x-device-id': device } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: Object.fromEntries(res.headers) };
  };
}

export function randomHandle(prefix = 'qa') {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}
