/**
 * ClearPath Health — Anthropic API Proxy (authenticated, rate-limited)
 * Vercel serverless function: /api/generate
 *
 * DEVELOPER SETUP:
 * 1. Go to console.anthropic.com → create account → add billing → generate API key
 * 2. In Vercel dashboard → your project → Settings → Environment Variables
 *    Add: ANTHROPIC_API_KEY = sk-ant-...your key...
 * 3. (Optional, for email alerts on repeated errors) Add:
 *    RESEND_API_KEY = your Resend.com API key (free tier works)
 *    ALERT_EMAIL    = the address that should receive alert emails
 * 4. Run supabase_migration.sql in your Supabase project's SQL Editor once
 *    (creates the outcomes, api_usage, error_logs tables + aggregate functions).
 *
 * Every request must include an "Authorization: Bearer <supabase access token>"
 * header — the client (public/index.html) attaches this automatically once
 * signed in. Requests without a valid session are rejected.
 */

const SUPABASE_URL = 'https://nuybyvryvrgomzkcxlnk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im51eWJ5dnJ5dnJnb216a2N4bG5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3NTI0MTYsImV4cCI6MjA5ODMyODQxNn0.2tzsWm8o05JiWrTgnP8xL34WOlFUxYrMke0rUoJYNMM';

// Only these user-triggered actions count against the hourly cap. Internal
// sub-steps (summarization, gap-flag screening) that happen automatically as
// part of one of these are NOT separately limited.
const RATE_LIMIT_ACTIONS = new Set(['note_generate', 'appeal_generate', 'extract_info']);
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

async function getUser(token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON },
  });
  if (!res.ok) return null;
  return res.json();
}

async function checkAndRecordRateLimit(token, userId, action) {
  if (!RATE_LIMIT_ACTIONS.has(action)) return { ok: true };
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const actionList = Array.from(RATE_LIMIT_ACTIONS).join(',');
  const countRes = await fetch(
    `${SUPABASE_URL}/rest/v1/api_usage?user_id=eq.${userId}&action=in.(${actionList})&created_at=gte.${since}&select=id`,
    { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON, Prefer: 'count=exact' } }
  );
  const range = countRes.headers.get('content-range');
  const count = range ? parseInt(range.split('/')[1], 10) || 0 : 0;
  if (count >= RATE_LIMIT_MAX) return { ok: false };

  await fetch(`${SUPABASE_URL}/rest/v1/api_usage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ user_id: userId, action }),
  });
  return { ok: true };
}

async function logErrorAndMaybeAlert(token, email, context, message) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/error_logs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ user_email: email, context, message: String(message).slice(0, 2000) }),
    });
  } catch (e) {
    console.error('Failed to write error_logs:', e);
    return;
  }

  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL) return;

  try {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const countRes = await fetch(`${SUPABASE_URL}/rest/v1/error_logs?created_at=gte.${since}&select=id`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON, Prefer: 'count=exact' },
    });
    const range = countRes.headers.get('content-range');
    const recentCount = range ? parseInt(range.split('/')[1], 10) || 0 : 0;
    if (recentCount < 3) return;

    const stateRes = await fetch(`${SUPABASE_URL}/rest/v1/alert_state?id=eq.1&select=last_alert_at`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON },
    });
    const state = await stateRes.json();
    const lastAlert = state[0] && state[0].last_alert_at ? new Date(state[0].last_alert_at).getTime() : 0;
    if (Date.now() - lastAlert < 30 * 60 * 1000) return; // throttle: max 1 email / 30 min

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'ClearPath Alerts <alerts@resend.dev>',
        to: process.env.ALERT_EMAIL,
        subject: `ClearPath Health: ${recentCount} errors in the last 15 minutes`,
        text: `ClearPath's AI generation endpoint has logged ${recentCount} errors in the last 15 minutes.\n\nLatest (${context}):\n${message}`,
      }),
    });

    await fetch(`${SUPABASE_URL}/rest/v1/alert_state?id=eq.1`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ last_alert_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.error('Alert pipeline failed:', e);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed', message: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'not_configured', message: 'API key not configured on the server.' });
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'auth_required', message: 'Sign in required.' });
  }

  const user = await getUser(token);
  if (!user || !user.id) {
    return res.status(401).json({ error: 'auth_required', message: 'Your session expired — please sign in again.' });
  }

  const body = req.body || {};
  const action = body.action || 'unspecified';

  const limit = await checkAndRecordRateLimit(token, user.id, action);
  if (!limit.ok) {
    return res.status(429).json({
      error: 'rate_limited',
      message: `Hourly generation limit reached (${RATE_LIMIT_MAX}/hour). Please try again later.`,
    });
  }

  try {
    const isStreaming = body.stream === true;
    const anthropicBody = { ...body };
    delete anthropicBody.action;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      await logErrorAndMaybeAlert(token, user.email, action, `Anthropic ${upstream.status}: ${errText.slice(0, 500)}`);
      return res.status(upstream.status).json({
        error: 'upstream_error',
        message: 'The AI service returned an error. Please try again in a moment.',
      });
    }

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } else {
      const data = await upstream.json();
      return res.status(200).json(data);
    }
  } catch (err) {
    console.error('Proxy error:', err);
    await logErrorAndMaybeAlert(token, user.email, action, err.message);
    return res.status(500).json({ error: 'proxy_error', message: 'Internal error. Please try again.' });
  }
}
