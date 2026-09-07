import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const BODY_LIMIT = 20 * 1024 * 1024; // 20 MB
const UPSTREAM_TIMEOUT_MS = 120_000; // 120 seconds
const REASONING_EFFORT = 'low';
const INCLUDE_REASONING = false;

let apiKey = '';

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
  return isConfigured();
}

export function isConfigured() {
  return Boolean(apiKey);
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

  const upstreamBody = {
    model: GROQ_MODEL,
    messages: body.messages,
    temperature: clampNumber(body.temperature, 0.3, 0, 2),
    max_tokens: clampNumber(body.max_tokens, 4096, 1, 16384),
    reasoning_effort: REASONING_EFFORT,
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

  if (!upstream.ok) {
    let parsed = null;
    try {
      parsed = JSON.parse(upstreamText);
    } catch {
      parsed = null;
    }
    sendError(res, mapUpstreamError(upstream.status, parsed));
    return;
  }

  res.status(upstream.status).set('Content-Type', upstream.headers.get('content-type') || 'application/json');
  res.send(upstreamText);
}