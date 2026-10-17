/**
 * Supabase Edge Function — thin proxy to Vercel cron API.
 * Deploy: supabase functions deploy financial-integrity-check
 * Schedule via pg_cron (see supabase/migrations) or Supabase Dashboard cron.
 */
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const JOBS: Record<string, string> = {
  'financial-integrity-check': '/api/cron/financial-integrity',
  'pending-transaction-resolver': '/api/cron/pending-transactions',
  'fraud-monitor': '/api/cron/fraud-monitor',
  'tontine-processor': '/api/cron/tontine-processor',
  'rider-status-updater': '/api/cron/rider-status',
  'daily-financial-report': '/api/cron/daily-financial-report',
  'delivery-auto-release': '/api/cron/delivery-auto-release',
  'agent-monthly-payout': '/api/cron/agent-monthly-payout',
  'agent-cash-sweep': '/api/cron/agent-cash-sweep',
};

serve(async (req) => {
  const jobName = Deno.env.get('CRON_JOB_NAME') ?? new URL(req.url).pathname.split('/').pop();
  const path = JOBS[jobName ?? ''];
  if (!path) {
    return new Response(JSON.stringify({ error: 'Unknown job', jobName }), { status: 400 });
  }

  const base = Deno.env.get('CRON_API_URL')?.replace(/\/$/, '');
  const secret = Deno.env.get('CRON_SECRET');
  if (!base || !secret) {
    return new Response(JSON.stringify({ error: 'CRON_API_URL and CRON_SECRET required' }), {
      status: 500,
    });
  }

  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
});
