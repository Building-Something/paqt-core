/**
 * Paqt — server-side entitlement enforcement.
 *
 * The Paqt server proxy holds the Groq API key, so it is the only place a
 * quota can be *enforced* (the browser could otherwise just reset its own
 * counters and keep calling the AI for free). Every /api/groq request is:
 *
 *   1. authenticated — the caller must present a valid Supabase access token
 *      (verified via the admin client's getUser(), never read from JWT claims)
 *   2. gated — the user must hold an active subscription plan
 *   3. metered for 'analysis' / 'draft' — the DB does an atomic check-and-
 *      increment (paqt_consume) before the request is forwarded to Groq, and a
 *      refund (paqt_refund) when the upstream call fails.
 *
 * If Supabase is NOT configured on the server, the proxy falls back to the
 * previous open behaviour (useful for local dev without billing).
 */

import { createClient } from '@supabase/supabase-js';

const PLAN_STATUS_CACHE_MS = 60_000;

let admin = null;
let configured = false;
let warned = false;

/** @type {Map<string, { active: boolean; expiresAt: number }>} */
const planStatusCache = new Map();

function loadEnv() {
  // groqProxy.initKey() already loads .env into process.env before any
  // request is handled; this module just reads the vars.
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) {
    if (!warned) {
      warned = true;
      console.warn(
        '[paqt] billing not configured (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). Quotas are NOT enforced.',
      );
    }
    return;
  }
  admin = createClient(url, key, { auth: { persistSession: false } });
  configured = true;
}

export function isBillingConfigured() {
  if (!admin) {
    loadEnv();
  }
  return configured;
}

/** Verifies a Supabase access token and returns { userId } or null. */
export async function verifyUser(authHeader) {
  if (!isBillingConfigured()) {
    return null;
  }
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return null;
  }
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user?.id) {
      return null;
    }
    return { userId: data.user.id };
  } catch {
    return null;
  }
}

/**
 * True when the user holds an active plan. Used for unmetered ops (chat,
 * clause edits, drafting questions). Cached briefly to avoid hammering the DB.
 */
export async function isPlanActive(userId) {
  const cached = planStatusCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.active;
  }
  let active = false;
  try {
    const { data } = await admin.rpc('paqt_plan_status', { p_user: userId });
    active = Boolean(data && data.active === true);
  } catch {
    active = false; // fail closed
  }
  planStatusCache.set(userId, { active, expiresAt: Date.now() + PLAN_STATUS_CACHE_MS });
  return active;
}

function mapDeniedReason(result) {
  switch (result.reason) {
    case 'plan_required':
      return {
        status: 402,
        code: 'plan_required',
        message: 'This feature requires an active Paqt subscription.',
      };
    case 'plan_expired':
      return {
        status: 402,
        code: 'plan_expired',
        message: 'Your subscription period has ended. Renew your subscription to continue.',
      };
    case 'quota_exhausted':
      return {
        status: 402,
        code: 'quota_exhausted',
        message: 'Monthly quota reached for this feature. Upgrade your plan to get more.',
      };
    case 'no_run':
      // A client asked to be metered without supplying an idempotency key. This
      // is a client-side bug (or a forged request); never charge in that state.
      return {
        status: 400,
        code: 'metering_key_required',
        message: 'This request was metered without a run id. Refresh and try again.',
      };
    case 'credits_exhausted':
      return {
        status: 402,
        code: 'credits_exhausted',
        message: 'Your plan credit balance is used up. Contact your account manager to top up.',
      };
    case 'past_due':
    case 'unpaid':
    case 'canceled':
      return {
        status: 402,
        code: 'plan_required',
        message: 'Your subscription is not active. Please update your payment details.',
      };
    default:
      return {
        status: 402,
        code: 'plan_required',
        message: 'This feature requires an active Paqt subscription.',
      };
  }
}

/**
 * Attempts to book one unit of `op`. Pass a `runId` (the analysis/draft entry
 * id) to make the charge idempotent: the first call for a run id books the
 * unit, later calls for the same run id are free so retries and checkpoint
 * resumes never double-charge. Returns { allowed, userId, error } where
 * `error` is a shaped { status, code, message } for unmetered failures, or
 * returns the DB result for metering decisions. Throws on infrastructure
 * failure so the caller can fail closed.
 */
export async function consume(userId, op, runId) {
  if (op !== 'analysis' && op !== 'draft') {
    return { allowed: true, userId };
  }
  let data;
  try {
    const { data: result, error } = await admin.rpc('paqt_consume', {
      p_user: userId,
      p_op: op,
      p_run: runId ?? null,
    });
    if (error) {
      throw error;
    }
    data = result;
  } catch (err) {
    const mapped = {
      status: 503,
      code: 'meter_unavailable',
      message: 'Usage metering is temporarily unavailable. Try again in a moment.',
    };
    console.error('[paqt] paqt_consume failed:', err?.message ?? err);
    throw createMeterError(mapped);
  }
  if (data?.allowed !== true) {
    const mapped = mapDeniedReason(data ?? {});
    const reason = data?.reason ?? 'plan_required';
    throw createMeterError(mapped, {
      reason,
      used: data?.used,
      quota: data?.quota,
      balance: data?.balance,
    });
  }
  return { allowed: true, userId, meta: data };
}

/** Restores a metered unit after an upstream Groq failure. Requires the same
 * run id that `consume()` booked, otherwise it cannot reference the ledger row
 * (and must never credit blindly). */
export async function refund(userId, op, runId) {
  if (!admin || (op !== 'analysis' && op !== 'draft')) {
    return;
  }
  if (!runId) {
    console.warn(`[paqt] refund skipped: no run id for ${op}`);
    return;
  }
  try {
    await admin.rpc('paqt_refund', { p_user: userId, p_op: op, p_run: runId });
  } catch (err) {
    console.error('[paqt] paqt_refund failed:', err?.message ?? err);
  }
}

export class MeterError extends Error {
  constructor(payload, extra) {
    super(payload.message);
    this.name = 'MeterError';
    this.status = payload.status;
    this.code = payload.code;
    this.message = payload.message;
    this.extra = extra ?? null;
  }
}

function createMeterError(payload, extra) {
  return new MeterError(payload, extra);
}

export function clearPlanStatusCache() {
  planStatusCache.clear();
}