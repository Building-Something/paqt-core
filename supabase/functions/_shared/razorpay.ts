import { createClient } from 'npm:@supabase/supabase-js@2';
import Razorpay from 'npm:razorpay@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RAZORPAY_KEY_ID = Deno.env.get('RAZORPAY_KEY_ID') ?? '';
const RAZORPAY_KEY_SECRET = Deno.env.get('RAZORPAY_KEY_SECRET') ?? '';
export const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});
export function createAdmin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
/** Converts Razorpay epoch-seconds to ms epoch as used across Paqt. */ export function ms(value) {
  if (value == null) {
    return null;
  }
  return BigInt(Math.round(value * 1000));
}
export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
export function jsonError(status, code, message) {
  return new Response(JSON.stringify({
    error: {
      code,
      message
    }
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders()
    }
  });
}
export function jsonOk(extra = {}) {
  return new Response(JSON.stringify({
    received: true,
    ...extra
  }), {
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders()
    }
  });
}
/** Low-level Razorpay REST call using basic auth (SDK lacks resume/plan-switch). */ async function razorpayApi(path, init = {}) {
  const auth = `Basic ${btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`)}`;
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch  {
    parsed = {};
  }
  if (!response.ok) {
    throw new Error(`Razorpay ${path} failed: ${response.status} ${text}`);
  }
  return parsed;
}
/** Undoes a scheduled cancellation (subscription.cancel at cycle end) so the sub resumes billing. */ export async function razorpayResume(subscriptionId) {
  return razorpayApi(`/subscriptions/${subscriptionId}/resume`, {
    method: 'POST'
  });
}
/** Switches the plan of a live subscription in place. */ export async function razorpayChangePlan(subscriptionId, planId) {
  return razorpayApi(`/subscriptions/${subscriptionId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      plan_id: planId
    })
  });
}
/** Resolves the Paqt plan id for a Razorpay plan id (stored in plans.price_id). */ export async function planIdForPrice(admin, priceId) {
  const { data } = await admin.from('plans').select('id').eq('price_id', priceId).maybeSingle();
  return data?.id ?? null;
}
/** Reads the current billing period from a Razorpay subscription entity. */ export function periodFromSubscription(subscription) {
  return {
    start: ms(subscription.current_start ?? null),
    end: ms(subscription.current_end ?? null)
  };
}
export async function getOrCreateCustomer(admin, userId, email, name) {
  const { data: profileRows } = await admin.from('profiles').select('payment_customer_id').eq('user_id', userId).maybeSingle();
  const existing = profileRows?.payment_customer_id;
  if (existing) {
    // The stored customer may come from a different mode (test vs live) if the
    // API keys were rotated; Razorpay rejects unknown ids during checkout, so
    // validate it and fall through to creating a fresh customer if it is gone.
    try {
      await razorpay.customers.fetch(existing);
      return existing;
    } catch  {
      await admin.from('profiles').update({
        payment_customer_id: null,
        updated_at: Date.now()
      }).eq('user_id', userId);
    }
  }
  // If a customer with the same email already exists on the merchant (for
  // example when the user deleted their Paqt account and re-registered, which
  // cascade-deletes the profile row but not the Razorpay customer), a plain
  // create fails with "Customer already exists for the merchant". With
  // fail_existing: '0' Razorpay returns that existing customer instead.
  const customer = await razorpay.customers.create({
    name: name || email.split('@')[0] || 'Paqt user',
    email: email || undefined,
    notes: {
      user_id: userId
    },
    fail_existing: '0'
  });
  await admin.from('profiles').upsert({
    user_id: userId,
    payment_customer_id: customer.id,
    updated_at: Date.now()
  }, {
    onConflict: 'user_id'
  });
  return customer.id;
}
/** Verifies the Razorpay webhook signature (HMAC-SHA256 over the raw body). */ export async function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) {
    return false;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {
    name: 'HMAC',
    hash: 'SHA-256'
  }, false, [
    'sign'
  ]);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = Array.from(new Uint8Array(digest)).map((byte)=>byte.toString(16).padStart(2, '0')).join('');
  const provided = signature.toLowerCase();
  if (expected.length !== provided.length) {
    return false;
  }
  let mismatch = 0;
  for(let i = 0; i < expected.length; i += 1){
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}
