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

const BASE_ENV = {
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'http-test-access-secret-0123456789',
  JWT_REFRESH_SECRET: 'http-test-refresh-secret-0123456789',
  ADMIN_JWT_SECRET: 'http-test-admin-secret-0123456789abcd',
  CRON_SECRET: 'http-test-cron-secret',
  EXTERNAL_API_TIMEOUT_MS: '300',
  EXTERNAL_API_RETRY_GAP_MS: '10',
  EXTERNAL_API_MAX_RETRIES: '1',
};

/** Env keys that must never leak from the developer shell into a prod-mode test server. */
const SCRUB = [
  'JULAYA_API_KEY', 'JULAYA_API_KEY_SANDBOX', 'JULAYA_API_KEY_PRODUCTION', 'JULAYA_WEBHOOK_SECRET',
  'ALLOW_BETA_OTP', 'ALLOW_BETA_DEPOSITS', 'RESEND_API_KEY', 'AFRICASTALKING_API_KEY', 'TWILIO_ACCOUNT_SID',
  'JOKO_API_KEY', 'JOKO_API_KEYS', 'PARTNER_SETTLEMENT_USER_ID', 'PLATFORM_INCENTIVES_ENABLED',
  'LEMFI_API_KEY', 'LEMFI_API_KEY_SANDBOX', 'STRIPE_SECRET_KEY',
];

export async function startApiServer(overrides = {}) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  Object.assign(env, BASE_ENV, {
    DATABASE_URL: normalizeDatabaseUrl(process.env.DATABASE_URL?.trim() || DEFAULT_DB),
  }, overrides);

  const child = spawn(process.execPath, [join(here, 'prod-api-server.mjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', (d) => { logs += d; });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`API server did not start:\n${logs}`)), 20_000);
    child.stdout.on('data', (d) => {
      logs += d;
      const m = String(d).match(/LISTENING (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => reject(new Error(`API server exited ${code}:\n${logs}`)));
  });

  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    logs: () => logs,
    stop: () =>
      new Promise((resolve) => {
        child.removeAllListeners('exit');
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
    client: makeClient(base),
  };
}

let ipCounter = 0;
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
    return { status: res.status, body: json };
  };
}

export function randomHandle(prefix = 'qa') {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}
