/**
 * Redaction for logs and error reports. Prisma errors echo the query
 * arguments (phone numbers, emails, token hashes, even PIN hashes on a
 * failed user update), and provider errors can echo request bodies. Nothing
 * that reaches console.* or Sentry from the API may carry those values.
 */
const PATTERNS = [
  [/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,60}/g, '[bcrypt]'],
  [/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[jwt]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  [/\b[a-f0-9]{40,128}\b/gi, '[hash]'],
  [/(\b(?:code|otp|pin|currentPin|password|token|secret|apiKey)\b["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1[redacted]'],
  [/\+?\d[\d ]{7,16}\d/g, '[number]'],
];

export function redactText(value) {
  let s = String(value ?? '');
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

/** A log-safe copy of an error: name, code, redacted message + stack. */
export function safeError(error) {
  if (!error || typeof error !== 'object') return redactText(error);
  const out = new Error(redactText(error.message));
  out.name = error.name ?? 'Error';
  if (error.code) out.code = error.code;
  if (error.meta?.modelName) out.model = error.meta.modelName;
  if (error.meta?.target) out.target = error.meta.target;
  out.stack = redactText(error.stack ?? '');
  return out;
}

/** user@example.com → u***@example.com (for operator logs that need a hint). */
export function maskEmail(email) {
  const [local, domain] = String(email ?? '').split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : '[email]';
}

/**
 * Message safe to return to a client from a catch-all: our own thrown
 * messages pass (redacted), but database/driver errors — which echo query
 * arguments and schema details — become the generic fallback.
 */
export function clientErrorMessage(error, fallback = 'Requête impossible') {
  const name = String(error?.name ?? '');
  const msg = String(error?.message ?? '');
  if (!msg || name.startsWith('Prisma') || /prisma|invocation|constraint|column|relation|SQL/i.test(msg)) return fallback;
  return redactText(msg).slice(0, 300);
}
