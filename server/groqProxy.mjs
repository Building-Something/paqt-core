import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const BODY_LIMIT = 20 * 1024 * 1024; // 20 MB
const UPSTREAM_TIMEOUT_MS = 120_000; // 120 seconds
const REASONING_EFFORT = 'low';
const INCLUDE_REASONING = false;
const REASONING_LEVELS = ['low', 'medium', 'high'];
const PLAN_GRACE_MS = 5 * 60 * 1000; // let webhook-applied renewals breathe

const RATE_LIMIT_HEADERS = [
  'retry-after',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
];

function copyUpstreamRateLimitHeaders(upstream, target) {
  for (const name of RATE_LIMIT_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) {
      target.setHeader(name, value);
    }
  }
}

function durationToSeconds(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return undefined;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const match = raw.match(/^(?:(\d+)m)?\s*(\d+(?:\.\d+)?)s$/i);
  if (!match) {
    return undefined;
  }
  const minutes = Number(match[1] ?? 0);
  const seconds = Number(match[2] ?? 0);
  return minutes * 60 + seconds;
}

function retryAfterMs(upstream) {
  const fromRetryAfter = durationToSeconds(
    upstream.headers.get('retry-after'),
  );
  const fromResetTokens = durationToSeconds(
    upstream.headers.get('x-ratelimit-reset-tokens'),
  );
  const fromResetRequests = durationToSeconds(
    upstream.headers.get('x-ratelimit-reset-requests'),
  );
  const seconds = fromRetryAfter ?? fromResetTokens ?? fromResetRequests;
  if (seconds === undefined || seconds < 0) {
    return undefined;
  }
  return Math.max(0, Math.round(seconds * 1000));
}

let apiKey = '';
let billingUrl = '';
let billingServiceKey = '';
let adminClient = null;

function loadEnvFile(filePath) {
  let contents;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function initKey() {
  try {
    loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  } catch {
    // Never crash merely because .env is absent; process.env may already be set.
  }
  apiKey = process.env.GROQ_API_KEY || '';
  billingUrl = process.env.SUPABASE_URL || '';
  billingServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return isConfigured();
}

export function isConfigured() {
  return Boolean(apiKey);
}

export function isBillingConfigured() {
  return Boolean(billingUrl && billingServiceKey);
}

function getAdminClient() {
  if (!isBillingConfigured()) {
    return null;
  }
  if (!adminClient) {
    adminClient = createClient(billingUrl, billingServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return adminClient;
}

// True while the row says 'active' and the current cycle has not ended.
function hasActiveAccess(sub) {
  if (!sub || sub.status !== 'active') {
    return false;
  }
  const periodEndMs = Number(sub.current_period_end) * 1000;
  if (!Number.isFinite(periodEndMs) || periodEndMs <= 0) {
    return false;
  }
  return Date.now() <= periodEndMs + PLAN_GRACE_MS;
}

// Returns true when the request may continue, false once an error is sent.
async function enforcePlanAccess(req, res) {
  const admin = getAdminClient();
  if (!admin) {
    // No Supabase credentials configured: dev mode, skip enforcement.
    return true;
  }

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (!token) {
    sendError(res, createError(401, 'auth_required', 'Sign in to use Paqt.'));
    return false;
  }

  let user;
  try {
    const { data } = await admin.auth.getUser(token);
    user = data?.user ?? null;
  } catch {
    user = null;
  }
  if (!user) {
    sendError(
      res,
      createError(401, 'auth_required', 'Your session has expired. Please sign in again.'),
    );
    return false;
  }

  let subscriptions;
  try {
    const { data, error } = await admin
      .from('subscriptions')
      .select('status, current_period_end')
      .eq('user_id', user.id)
      .in('status', ['active', 'pending']);
    if (error) {
      throw error;
    }
    subscriptions = data ?? [];
  } catch (error) {
    console.error('[groq] billing check failed:', error);
    sendError(
      res,
      createError(503, 'billing_unavailable', 'Could not verify your plan. Please try again.'),
    );
    return false;
  }

  if (!subscriptions.some(hasActiveAccess)) {
    sendError(
      res,
      createError(
        402,
        'plan_required',
        'An active Paqt plan is required to analyze contracts. Choose a plan from the Pricing page to continue.',
      ),
    );
    return false;
  }
  return true;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;

    const finish = (settle, value) => {
      if (done) {
        return;
      }
      done = true;
      chunks.length = 0;
      settle(value);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (!done && size > BODY_LIMIT) {
        finish(reject, createError(413, 'oversized', 'Request body is too large.'));
        return;
      }
      if (!done) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (done) {
        return;
      }
      finish(resolve, Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => finish(reject, error));
  });
}

function createError(status, code, message) {
  return {
    status,
    code,
    message,
  };
}

function sendError(res, error) {
  if (res.headersSent) {
    return;
  }
  res.setHeader('Connection', 'close');
  res.status(error.status || 500).json({
    error: {
      code: error.code || 'unknown',
      message: error.message || 'Something went wrong.',
    },
  });
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return false;
  }
  return messages.every(
    (message) =>
      message &&
      typeof message === 'object' &&
      typeof message.content === 'string' &&
      (message.role === 'user' || message.role === 'assistant' || message.role === 'system'),
  );
}

function mapUpstreamError(status, body) {
  if (status === 401 || status === 403) {
    return createError(status, 'invalid_key', 'Your Groq API key was rejected.');
  }
  if (status === 429) {
    return createError(status, 'rate_limited', 'The AI service is temporarily rate-limited.');
  }
  if (status >= 500) {
    return createError(status, 'upstream', 'The AI service is temporarily unavailable.');
  }
  if (status === 400) {
    const detail = body && body.error && body.error.message;
    return createError(
      status,
      'bad_request',
      detail || 'The AI service rejected the request.',
    );
  }
  return createError(status, 'upstream', 'The AI service returned an unexpected response.');
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

export async function groqProxyHandler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { code: 'bad_request', message: 'Use POST.' } });
    return;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    sendError(res, error);
    return;
  }

  let body;
  try {
    if (rawBody.charCodeAt(0) === 0xfeff) {
      rawBody = rawBody.slice(1);
    }
    body = JSON.parse(rawBody);
  } catch {
    sendError(res, createError(400, 'bad_request', 'Request body must be valid JSON.'));
    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, createError(400, 'bad_request', 'Request body must be a JSON object.'));
    return;
  }

  if (!validateMessages(body.messages)) {
    sendError(res, createError(400, 'bad_request', 'Provide a non-empty messages array.'));
    return;
  }

  if (!isConfigured()) {
    sendError(
      res,
      createError(
        503,
        'not_configured',
        'Groq API key is not configured on the server. Add GROQ_API_KEY and restart Paqt.',
      ),
    );
    return;
  }

  if (!(await enforcePlanAccess(req, res))) {
    return;
  }

  // Clamp to the model's supported set; fall back to the default for anything unknown.
  const requestedEffort = body.reasoning_effort;
  const reasoningEffort =
    typeof requestedEffort === 'string' && REASONING_LEVELS.includes(requestedEffort)
      ? requestedEffort
      : REASONING_EFFORT;

  const upstreamBody = {
    model: GROQ_MODEL,
    messages: body.messages,
    temperature: clampNumber(body.temperature, 0.3, 0, 2),
    max_tokens: clampNumber(body.max_tokens, 4096, 1, 16384),
    reasoning_effort: reasoningEffort,
    include_reasoning: INCLUDE_REASONING,
  };

  if (body.response_format && typeof body.response_format === 'object') {
    upstreamBody.response_format = body.response_format;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      sendError(res, createError(504, 'timeout', 'The AI analysis took too long.'));
    } else {
      sendError(
        res,
        createError(502, 'upstream', 'Could not reach the AI service.'),
      );
    }
    return;
  }
  clearTimeout(timer);

  let upstreamText;
  try {
    upstreamText = await upstream.text();
  } catch {
    sendError(res, createError(502, 'upstream', 'Could not read the AI response.'));
    return;
  }

  copyUpstreamRateLimitHeaders(upstream, res);

  if (!upstream.ok) {
    let parsed = null;
    try {
      parsed = JSON.parse(upstreamText);
    } catch {
      parsed = null;
    }
    const detail =
      parsed && parsed.error && parsed.error.message
        ? parsed.error.message
        : (upstreamText || '').slice(0, 300);
    const error = mapUpstreamError(upstream.status, parsed);
    if (upstream.status === 429) {
      const remainingRequests = Number(
        upstream.headers.get('x-ratelimit-remaining-requests'),
      );
      const upstreamMessage =
        parsed && parsed.error && typeof parsed.error.message === 'string'
          ? parsed.error.message
          : '';
      const tpdExhausted =
        upstreamMessage.toLowerCase().includes('tokens per day') ||
        upstreamMessage.toLowerCase().includes('tpd');
      const dailyCap =
        (Number.isFinite(remainingRequests) && remainingRequests <= 0) ||
        tpdExhausted;
      const afterMs = retryAfterMs(upstream);
      if (dailyCap) {
        error.code = 'rate_limited_daily';
        error.message = tpdExhausted
          ? `The plan's daily AI token allowance is used up. ${upstreamMessage}`
          : 'Daily AI request allowance reached.';
      }
      console.error(`[groq] upstream 429 (${tpdExhausted ? 'daily tokens' : dailyCap ? 'daily requests' : 'per-minute tokens'}): ${detail}`);
      if (afterMs !== undefined) {
        res.setHeader('Connection', 'close');
        res.status(error.status).json({
          error: { code: error.code, message: error.message, retryAfterMs: afterMs },
        });
        return;
      }
    }
    if (upstream.status === 429) {
      console.error(`[groq] upstream 429 (no reset window reported): ${detail}`);
    }
    sendError(res, error);
    return;
  }

  res.status(upstream.status).set('Content-Type', upstream.headers.get('content-type') || 'application/json');
  res.send(upstreamText);
}