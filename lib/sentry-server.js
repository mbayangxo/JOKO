import * as Sentry from '@sentry/node';
import { redactText, safeError } from './log-redact.js';

let initialized = false;

export function initServerSentry() {
  if (initialized) return;
  initialized = true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    enabled: process.env.NODE_ENV === 'production' || process.env.SENTRY_ENABLED === 'true',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    // Prisma/provider errors echo query arguments: redact before sending.
    beforeSend(event) {
      for (const ex of event.exception?.values ?? []) {
        if (ex.value) ex.value = redactText(ex.value);
      }
      if (event.message) event.message = redactText(event.message);
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) delete event.request.headers.authorization;
      }
      for (const b of event.breadcrumbs ?? []) {
        if (b.message) b.message = redactText(b.message);
        delete b.data;
      }
      return event;
    },
  });
}

export function captureServerError(error, context = {}) {
  if (!process.env.SENTRY_DSN) {
    console.error('[api]', safeError(error));
    return;
  }
  Sentry.withScope((scope) => {
    if (context.path) scope.setTag('api_path', context.path);
    if (context.method) scope.setTag('http_method', context.method);
    if (context.userId) scope.setUser({ id: context.userId });
    if (context.adminId) scope.setTag('admin_id', context.adminId);
    Sentry.captureException(error);
  });
}

export { Sentry };
