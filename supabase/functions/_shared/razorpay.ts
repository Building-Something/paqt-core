const RAZORPAY_API = 'https://api.razorpay.com/v1';

function requireEnv(name: string): string {
  const value = (Deno.env.get(name) || '').trim();
  if (!value) {
    throw new Error(`Missing Deno env: ${name}`);
  }
  return value;
}

export interface RazorpayEnv {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

export function getRazorpayEnv(): RazorpayEnv {
  return {
    keyId: requireEnv('RAZORPAY_KEY_ID'),
    keySecret: requireEnv('RAZORPAY_KEY_SECRET'),
    webhookSecret: Deno.env.get('RAZORPAY_WEBHOOK_SECRET') || '',
  };
}

export class RazorpayError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface RazorpayCustomer {
  id: string;
  email: string;
  name: string;
}

export interface RazorpaySubscriptionEntity {
  id: string;
  status: string;
  plan_id: string;
  short_url?: string | null;
  customer_id?: string | null;
  current_start?: number | null;
  current_end?: number | null;
  ended_at?: number | null;
  start_at?: number | null;
  charge_at?: number | null;
  end_at?: number | null;
  paid_count?: number | null;
  total_count?: number | null;
  has_scheduled_changes?: boolean | null;
  change_scheduled_at?: number | null;
  cancel_at_cycle_end?: boolean | null;
  notes?: Record<string, unknown> | null;
}

function basicAuth(keyId: string, keySecret: string): string {
  return `Basic ${btoa(`${keyId}:${keySecret}`)}`;
}

export async function razorpayFetch(
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  const { keyId, keySecret } = getRazorpayEnv();
  const method = init.method || (init.body ? 'POST' : 'GET');
  return fetch(`${RAZORPAY_API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(keyId, keySecret),
    },
    body: init.body,
  });
}

export async function razorpayJson<T>(
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<T> {
  const response = await razorpayFetch(path, init);
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const detail =
      (parsed as { error?: { description?: string; message?: string; code?: string } })
        ?.error || {};
    console.error(`[razorpay] ${response.status} ${path}`, parsed);
    throw new RazorpayError(
      detail.description || detail.message || `Razorpay request failed (${response.status}).`,
      detail.code || 'razorpay_error',
      response.status,
    );
  }
  return parsed as T;
}

export async function createRazorpayCustomer(input: {
  email: string;
  name?: string;
  userId: string;
}): Promise<RazorpayCustomer> {
  return razorpayJson<RazorpayCustomer>('/customers', {
    method: 'POST',
    body: JSON.stringify({
      email: input.email,
      name: input.name || input.email,
      notes: { paqt_user_id: input.userId },
    }),
  });
}

export async function verifyRazorpaySignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!secret || !signature) {
    return false;
  }
  const encoder = new TextEncoder();
  const expected = signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return false;
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    return false;
  }
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const digest = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return timingSafeEqual(digest, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}