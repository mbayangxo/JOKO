/**
 * Transactional email — OTP recovery. Mock when no provider key (beta logs to console).
 */

import { fetchExternalJson } from './external-fetch.js';
import { maskEmail, redactText } from './log-redact.js';

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export function formatOtpEmailHtml(code) {
  return `<p>Ton code K21 est <strong>${code}</strong>.</p><p>Valide 10 minutes. Ne le partage avec personne.</p>`;
}

export async function sendOtpEmail(to, code) {
  const email = String(to ?? '')
    .trim()
    .toLowerCase();
  if (!email || !email.includes('@')) {
    throw new Error('Invalid email');
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim() || 'K21 <noreply@k21.app>';

  if (!apiKey) {
    if (process.env.NODE_ENV !== 'production') console.info('[email:mock] OTP to', maskEmail(email), 'code', code);
    return { provider: 'mock', delivered: false };
  }

  const result = await fetchExternalJson('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Ton code K21',
      html: formatOtpEmailHtml(code),
    }),
  });

  if (!result.ok) {
    const detail =
      result.body?.message ??
      result.body?.error ??
      (typeof result.body === 'string' ? result.body : null) ??
      `Resend HTTP ${result.status ?? 'error'}`;
    console.error('[email] OTP send failed', maskEmail(email), redactText(detail));
    throw new Error(detail);
  }

  return { provider: 'resend', delivered: true };
}

export async function sendAlertEmail(to, subject, text) {
  const email = String(to ?? '')
    .trim()
    .toLowerCase();
  if (!email || !email.includes('@')) return { provider: 'skip', delivered: false };

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim() || 'K21 <noreply@k21.app>';

  if (!apiKey) {
    if (process.env.NODE_ENV !== 'production') console.info('[email:mock] alert to', maskEmail(email), subject);
    return { provider: 'mock', delivered: false };
  }

  const result = await fetchExternalJson('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject,
      html: `<p>${String(text).replace(/\n/g, '<br/>')}</p>`,
    }),
  });

  if (!result.ok) {
    console.error('[email] alert send failed', maskEmail(email), subject, redactText(JSON.stringify(result.body ?? '')));
    return { provider: 'resend', delivered: false };
  }

  return { provider: 'resend', delivered: true };
}
