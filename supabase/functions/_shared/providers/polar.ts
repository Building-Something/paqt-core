/**
 * Polar adapter.
 *
 * Translates Polar's vocabulary into the provider-agnostic contracts in
 * `providers/types.ts`. Everything Polar-specific — ISO timestamps, product-id
 * addressing, the signature scheme, the absence of a webhook event id — is
 * contained in this file.
 *
 * Verified against the Polar `2026-10` API.
 */
import { derivedEventId, isoToMs, mapPolarStatus } from './domain.ts';
import {
  type BillingSubscription,
  type CheckoutResult,
  type CreateCheckoutInput,
  type NormalizedBillingEvent,
  type PaymentProvider,
  type PlanPrice,
  type WebhookHeaders,
  ProviderError,
} from './types.ts';

const PROVIDER = 'polar' as const;

const ACCESS_TOKEN = Deno.env.get('POLAR_ACCESS_TOKEN') ?? '';
const WEBHOOK_SECRET = Deno.env.get('POLAR_WEBHOOK_SECRET') ?? '';
const ENVIRONMENT = (Deno.env.get('POLAR_ENVIRONMENT') ?? 'sandbox').trim().toLowerCase();

/**
 * Sandbox and production are fully isolated, so the base URL has to follow the
 * environment explicitly: pointing sandbox credentials at production (or the
 * reverse) would charge real cards or refuse every call.
 */
const BASE_URL = (
  Deno.env.get('POLAR_API_BASE_URL') ??
  (ENVIRONMENT === 'production' ? 'https://api.polar.sh/v1' : 'https://sandbox-api.polar.sh/v1')
).replace(/\/+$/, '');

/** Every provider call gets a hard deadline so a hung socket cannot pin an edge
 *  invocation (and the user's billing claim) open. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Polar disables an endpoint after 10 consecutive non-2xx responses, so a handler
 *  must answer fast. 2s is the documented target. */
const WEBHOOK_MAX_BODY_BYTES = 1_000_000;

/** Standard Webhooks rejects timestamps outside this window, which is what stops a
 *  captured delivery from being replayed indefinitely. */
const WEBHOOK_TOLERANCE_SECONDS = 300;

export function polarConfigured(): boolean {
  return Boolean(ACCESS_TOKEN);
}

export class PolarError extends ProviderError {
  constructor(status: number, code: string, detail: string) {
    super(PROVIDER, status, code, detail);
    this.name = 'PolarError';
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  if (!polarConfigured()) {
    throw new PolarError(0, 'not_configured', 'POLAR_ACCESS_TOKEN missing');
  }
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout is genuinely uncertain: the request may or may not have been
    // applied upstream, so callers must reconcile rather than retry blindly.
    throw new PolarError(0, 'transport_error', (err as Error)?.message ?? 'network failure');
  }
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  if (!response.ok) {
    throw new PolarError(
      response.status,
      polarErrorCode(parsed, response.status),
      polarErrorDetail(parsed, text),
    );
  }
  return parsed as T;
}

/**
 * Polar's `detail` is a validation-error array rather than a string. The first
 * entry's `msg` is the closest thing to a usable code; the 409/403 detail
 * strings carry the operational meaning ("already revoked", "not scheduled to
 * cancel") that the bare status does not.
 */
function polarErrorCode(parsed: Record<string, unknown>, status: number): string {
  const detail = parsed.detail;
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0] as { msg?: unknown; type?: unknown };
    if (typeof first?.msg === 'string') {
      return first.msg;
    }
    if (typeof first?.type === 'string') {
      return first.type;
    }
  }
  if (typeof detail === 'string' && detail) {
    return detail;
  }
  return `http_${status}`;
}

function polarErrorDetail(parsed: Record<string, unknown>, raw: string): string {
  const detail = parsed.detail;
  if (typeof detail === 'string' && detail) {
    return detail;
  }
  if (Array.isArray(detail)) {
    return JSON.stringify(detail).slice(0, 300);
  }
  return raw.slice(0, 300);
}

// ---------------------------------------------------------------------------
// Polar payloads
// ---------------------------------------------------------------------------

/** Every timestamp on a Polar object is an ISO-8601 string, never an epoch int. */
export interface PolarSubscription {
  id: string;
  status: string;
  product_id: string;
  customer_id: string;
  created_at: string;
  /** Present on newer API versions; older payloads only carry the period start. */
  started_at?: string | null;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  ended_at: string | null;
  amount?: number | null;
  currency?: string | null;
  recurring_interval?: string | null;
  metadata?: Record<string, string | number | boolean> | null;
  customer?: { external_id?: string | null } | null;
  pending_update?: { product_id?: string | null } | null;
}

export interface PolarCheckout {
  id: string;
  url: string;
  status?: string;
  amount?: number | null;
  total_amount?: number | null;
  currency?: string | null;
  product_id?: string | null;
  customer_id?: string | null;
  external_customer_id?: string | null;
  subscription_id?: string | null;
}

export interface PolarOrder {
  id: string;
  amount?: number | null;
  net_amount?: number | null;
  total_amount?: number | null;
  currency?: string | null;
  customer_id?: string | null;
  subscription_id?: string | null;
  product_id?: string | null;
  /** Checkout metadata is carried onto the order, which is how `order.paid` is attributed. */
  metadata?: Record<string, string | number | boolean> | null;
  created_at?: string | null;
}

interface PolarWebhookEnvelope<T> {
  type: string;
  timestamp: string;
  api_version?: string;
  data?: T;
}

/** Metadata key carrying the Paqt user id onto the resulting subscription. */
const USER_ID_METADATA_KEY = 'paqt_user_id';
/** Polar rejects metadata keys over 40 characters and string values over 500. */
const METADATA_KEY_LIMIT = 40;
const METADATA_VALUE_LIMIT = 500;

/** Trims a metadata value to what Polar accepts, rather than failing the checkout. */
function clampMetadata(value: string): string {
  return value.length > METADATA_VALUE_LIMIT ? value.slice(0, METADATA_VALUE_LIMIT) : value;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Polar subscription -> Paqt subscription.
 *
 * ISO timestamps become ms epoch here, and `cancel_at_period_end` is folded into
 * the derived status so a period-end cancellation reads as `canceling` rather
 * than as an ended subscription.
 */
export function toBillingSubscription(sub: PolarSubscription): BillingSubscription {
  return {
    provider: PROVIDER,
    id: sub.id,
    customerId: sub.customer_id ?? null,
    providerProductId: sub.product_id ?? null,
    status: mapPolarStatus(sub.status, sub.cancel_at_period_end === true),
    providerStatus: sub.status ?? '',
    startedAt: isoToMs(sub.started_at ?? sub.current_period_start ?? sub.created_at),
    currentPeriodStart: isoToMs(sub.current_period_start),
    currentPeriodEnd: isoToMs(sub.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    canceledAt: isoToMs(sub.canceled_at),
    endedAt: isoToMs(sub.ended_at),
    pendingProductId: sub.pending_update?.product_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export async function fetchSubscription(id: string): Promise<BillingSubscription> {
  const sub = await call<PolarSubscription>('GET', `/subscriptions/${encodeURIComponent(id)}`);
  return toBillingSubscription(sub);
}

/**
 * Stops billing at the end of the already-paid period.
 *
 * Polar answers with the same subscription carrying `cancel_at_period_end: true`;
 * access continues to `current_period_end`, so nothing is revoked early. The
 * update variants are mutually exclusive (`additionalProperties: false`), so
 * this must not be combined with a plan change.
 */
export async function cancelAtPeriodEnd(id: string): Promise<BillingSubscription> {
  const sub = await call<PolarSubscription>('PATCH', `/subscriptions/${encodeURIComponent(id)}`, {
    cancel_at_period_end: true,
  });
  const mapped = toBillingSubscription(sub);
  // A provider that acknowledged the flag without reflecting it would let a
  // customer believe a cancellation was scheduled while the next charge went
  // through, which is exactly the failure this call exists to prevent.
  if (mapped.cancelAtPeriodEnd !== true) {
    throw new PolarError(409, 'cancel_not_confirmed', 'subscription did not confirm cancel_at_period_end');
  }
  return mapped;
}

/** Clears a scheduled cancellation so the subscription keeps billing. */
export async function undoScheduledCancel(id: string): Promise<BillingSubscription> {
  const sub = await call<PolarSubscription>('PATCH', `/subscriptions/${encodeURIComponent(id)}`, {
    cancel_at_period_end: false,
  });
  return toBillingSubscription(sub);
}

/**
 * Revokes immediately, ending access now.
 *
 * Correct only where no paid period is left to protect (an abandoned checkout, or
 * a refund revoking a plan). Irreversible, and Polar answers 403 when the
 * subscription is already revoked, which is surfaced rather than swallowed.
 */
export async function cancelNow(id: string): Promise<BillingSubscription> {
  const sub = await call<PolarSubscription>('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
  return toBillingSubscription(sub);
}

/**
 * Moves an existing subscription onto another product.
 *
 * `next_period` schedules the change for the next cycle, leaving the paid period on
 * the current plan; `prorate` applies it immediately and bills the difference.
 * Plan changes are rejected on a subscription that is already canceled or
 * scheduled to cancel, so an uncancel has to happen first.
 */
export async function changePlan(
  id: string,
  toProductId: string,
  when: 'period_end' | 'immediate',
): Promise<BillingSubscription> {
  const sub = await call<PolarSubscription>('PATCH', `/subscriptions/${encodeURIComponent(id)}`, {
    product_id: toProductId,
    proration_behavior: when === 'period_end' ? 'next_period' : 'prorate',
  });
  return toBillingSubscription(sub);
}

/**
 * Lists a customer's subscriptions, newest first.
 *
 * Paqt's user id is Polar's `external_customer_id`, so the provider filters for
 * us — unlike Razorpay, which has no customer filter and has to be paginated and
 * filtered locally. Returns [] on failure so a listing hiccup degrades to
 * "cannot confirm" rather than blocking a purchase.
 */
export async function listSubscriptions(userId: string): Promise<BillingSubscription[]> {
  try {
    const seen = new Map<string, BillingSubscription>();
    for (let page = 1; page <= 20; page += 1) {
      const query = new URLSearchParams({
        external_customer_id: userId,
        page: String(page),
        limit: '100',
        sorting: '-started_at',
      });
      const response = await call<{ items?: PolarSubscription[]; pagination?: { max_page?: number } }>(
        'GET',
        `/subscriptions/?${query.toString()}`,
      );
      for (const sub of response.items ?? []) {
        if (sub?.id) {
          seen.set(sub.id, toBillingSubscription(sub));
        }
      }
      const maxPage = response.pagination?.max_page;
      if ((response.items ?? []).length === 0 || (typeof maxPage === 'number' && page >= maxPage)) {
        break;
      }
    }
    return [...seen.values()];
  } catch (err) {
    console.error('[polar] listSubscriptions failed:', (err as Error)?.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * Creates a hosted checkout session and returns the URL to send the customer to.
 *
 * Polar is addressed by *product* id, not price id: `products` takes the product
 * and the catalogue price on that product is what gets charged. Only one product
 * is ever passed, because passing several makes the checkout let the customer
 * switch plans themselves — Paqt has already decided the plan.
 *
 * `external_customer_id` is Paqt's user id, which links (or creates) the Polar
 * customer and is what later lets `listSubscriptions` find the subscription.
 * Metadata set here is copied onto the resulting subscription, which is how a
 * webhook with no customer context still resolves to the right account.
 */
export async function createCheckout(input: CreateCheckoutInput, price: PlanPrice): Promise<CheckoutResult> {
  const metadata: Record<string, string> = {
    [USER_ID_METADATA_KEY.slice(0, METADATA_KEY_LIMIT)]: clampMetadata(input.userId),
    op_id: clampMetadata(input.operationId),
  };
  // Only documented fields are sent. `CheckoutProductsCreate` takes `products`,
  // and anything outside its schema risks a 422 that surfaces to the customer as
  // a broken checkout page. Notably there is no `cancel_url` — the documented
  // field is `return_url`, which renders a back button rather than an automatic
  // redirect, so the customer leaves via the browser back button instead.
  const checkout = await call<PolarCheckout>('POST', '/checkouts/', {
    products: [price.providerProductId],
    success_url: appendCheckoutId(input.successUrl),
    return_url: input.cancelUrl,
    external_customer_id: input.userId,
    customer_email: input.email || undefined,
    metadata,
  });
  return {
    provider: PROVIDER,
    planId: price.planId,
    url: checkout.url,
    checkoutRef: checkout.id,
    redirect: true,
  };
}

/** Polar substitutes `{CHECKOUT_ID}` so the return trip can identify the session. */
function appendCheckoutId(successUrl: string): string {
  return successUrl.includes('{CHECKOUT_ID}') ? successUrl : `${successUrl}{CHECKOUT_ID}`;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Verifies a Polar webhook signature.
 *
 * Secrets created on or after 2026-09-08 are Standard Webhooks: the signed
 * payload is `id.timestamp.body`, the key is the base64-decoded `whsec_…`
 * string, and each signature is `v1,<base64>`. Older secrets are Polar's own
 * HMAC over the raw body with the whole `whsec_…` string as the key. Both are
 * tried so an endpoint created before the cutover keeps verifying.
 *
 * Constant-time comparison throughout; a signature must never be partially
 * matched.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!headers.signature || !secret) {
    return false;
  }
  const encoder = new TextEncoder();

  if (headers.id && headers.timestamp) {
    const timestampSec = Number(headers.timestamp);
    if (!Number.isFinite(timestampSec)) {
      return false;
    }
    // Reject a delivery outside the tolerance window: without this a captured
    // request could be replayed forever, since the signature itself stays valid.
    if (Math.abs(nowMs / 1000 - timestampSec) > WEBHOOK_TOLERANCE_SECONDS) {
      return false;
    }
    const signedPayload = `${headers.id}.${headers.timestamp}.${rawBody}`;
    // Both derivations must be tried. The Standard Webhooks spec says to strip the
    // `whsec_` prefix and base64-decode the remainder, but Polar signs with the
    // literal UTF-8 bytes of the whole secret, prefix included. Verifying only the
    // spec-conformant way rejects every real delivery; Polar's own SDKs accept
    // either, so the same tolerance belongs here.
    for (const material of signingKeyCandidates(secret)) {
      let key: CryptoKey;
      try {
        key = await importHmacKey(material);
      } catch {
        continue;
      }
      const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
      if (signatureMatches(headers.signature, bytesToBase64(new Uint8Array(digest)))) {
        return true;
      }
    }
    return false;
  }

  // Legacy Polar HMAC fallback.
  let key: CryptoKey;
  try {
    key = await importHmacKey(encoder.encode(secret));
  } catch {
    return false;
  }
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = bytesToBase64(new Uint8Array(digest));
  return signatureMatches(headers.signature, expected);
}

function importHmacKey(material: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', material as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

/**
 * Base64 without Node's Buffer.
 *
 * Buffer is a Node global and is absent from the Deno runtime that actually
 * executes these edge functions, so relying on it would pass under vitest and
 * fail on every deployed call. atob/btoa exist in both.
 */
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Extracts the signing key from a Standard Webhooks secret.
 *
 * The secret is `whsec_` followed by base64, and the HMAC key is the base64 part
 * only. Decoding the whole string yields different bytes than the sender used, so
 * every signature would fail.
 */
/**
 * The key material Polar may have signed with, in preference order.
 *
 * Polar's own SDKs verify against either the spec-conformant key (strip `whsec_`,
 * base64-decode what remains) or the literal bytes of the full secret, because the
 * server does the latter while documenting the former. Which one a given endpoint
 * uses is not something the payload reveals, so both are offered and the signature
 * decides. A secret whose remainder is not valid base64 yields only the literal
 * form, which is why this degrades rather than throwing.
 */
function signingKeyCandidates(secret: string): Uint8Array[] {
  const literal = encoderBytes(secret);
  if (!secret.startsWith('whsec_')) {
    return [literal];
  }
  const trimmed = secret.slice('whsec_'.length);
  if (!trimmed || !isBase64(trimmed)) {
    return [literal];
  }
  try {
    const decoded = base64ToBytes(trimmed);
    // Guard against a secret that happens to be valid base64 but decodes to the
    // same bytes either way, so we never compute the same signature twice.
    return bytesEqual(decoded, literal) ? [literal] : [decoded, literal];
  } catch {
    return [literal];
  }
}

/** True when every character is in the standard base64 alphabet, with legal padding. */
function isBase64(value: string): boolean {
  if (value.length % 4 !== 0) {
    return false;
  }
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let same = true;
  for (let i = 0; i < a.length; i += 1) {
    same = (a[i] === b[i]) && same;
  }
  return same;
}

function encoderBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * A Standard Webhooks signature header holds one or more space-separated `v1,<sig>`
 * entries, and providers append rather than replace them across key rotations, so
 * every entry is checked.
 */
function signatureMatches(header: string, expected: string): boolean {
  let matched = false;
  for (const part of header.split(' ')) {
    const [scheme, value] = part.split(',');
    if (scheme !== 'v1' || !value) {
      continue;
    }
    matched = constantTimeEquals(value, expected) || matched;
  }
  return matched;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Subscription events that only change the lifecycle record. */
const SUBSCRIPTION_EVENTS = new Set([
  'subscription.created',
  'subscription.active',
  'subscription.updated',
  'subscription.canceled',
  'subscription.uncanceled',
  'subscription.cycled',
  'subscription.revoked',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
  // Fired when Polar takes over billing for a subscription migrated from another
  // provider — i.e. exactly the Razorpay-to-Polar cutover this integration
  // performs. Polar sends neither `subscription.created` nor `subscription.active`
  // on that path, so ignoring this event would leave migrated customers with no
  // entitlement at all. It arrives as `subscription.updated` then
  // `subscription.migrated`, and carries `provider`/`provider_subscription_id`
  // for correlating back to the old subscription.
  'subscription.migrated',
]);

/**
 * Reduces a verified Polar delivery to normalized events.
 *
 * Two Polar quirks are handled here. `subscription.canceled` is ambiguous — it
 * fires both for a period-end cancellation (still `active`) and for an immediate
 * revocation — so the status in the payload decides, and the derived status does
 * the same work for entitlement. And the envelope carries no event id, so one is
 * derived from the event's contents to keep redeliveries idempotent.
 */
export async function parseWebhook(
  raw: string,
  headers: WebhookHeaders,
  secret: string,
): Promise<NormalizedBillingEvent[]> {
  if (raw.length > WEBHOOK_MAX_BODY_BYTES) {
    throw new PolarError(413, 'payload_too_large', 'webhook body over the size limit');
  }
  if (!(await verifyWebhookSignature(raw, headers, secret))) {
    throw new PolarError(400, 'invalid_signature', 'webhook signature verification failed');
  }
  let envelope: PolarWebhookEnvelope<PolarSubscription & { order?: PolarOrder }>;
  try {
    envelope = JSON.parse(raw) as PolarWebhookEnvelope<PolarSubscription & { order?: PolarOrder }>;
  } catch {
    throw new PolarError(400, 'bad_request', 'webhook body is not JSON');
  }
  const type = typeof envelope.type === 'string' ? envelope.type : '';
  if (!type) {
    throw new PolarError(400, 'bad_request', 'webhook body has no event type');
  }
  const occurredAt = isoToMs(envelope.timestamp);
  const data = envelope.data;
  const isOrderEvent = ORDER_EVENTS.has(type);
  const isSubscriptionEvent = SUBSCRIPTION_EVENTS.has(type);

  // The envelope's `data` is polymorphic: for subscription events it IS the
  // subscription, and for order events it IS the order. Reading `data.order`
  // would therefore find nothing on `order.paid` and silently drop the payment
  // record, so the two shapes are told apart by event type.
  const order = isOrderEvent ? (data as unknown as PolarOrder | undefined) : data?.order ?? null;
  const subscription = isSubscriptionEvent && data?.id ? toBillingSubscription(data) : null;

  const eventId = await derivedEventId({
    type,
    subscriptionId: subscription?.id ?? data?.id ?? null,
    status: typeof data?.status === 'string' ? data.status : null,
    occurredAt: envelope.timestamp ?? null,
  });

  return [
    {
      provider: PROVIDER,
      eventId,
      type,
      occurredAt,
      subscription,
      // An order carries only a reference to the subscription it paid for, so the
      // full payload is absent here and this id is the only link back.
      providerSubscriptionId: subscription?.id ?? order?.subscription_id ?? null,
      // `order.paid` is the authoritative proof of money; a subscription event
      // alone only proves a state change, and `subscription.cycled` fires before
      // the renewal order exists even if the payment then fails.
      moneyMoved: type === 'order.paid' || type === 'order.refunded',
      paymentRef: order?.id ?? null,
      paymentAmount: order?.amount ?? order?.total_amount ?? null,
      paymentCurrency: order?.currency ?? null,
      userId: resolveUserId(data, subscription),
    },
  ];
}

/** Payment events, whose envelope payload is an Order rather than a subscription. */
const ORDER_EVENTS = new Set(['order.paid', 'order.refunded']);

/**
 * Resolves the Paqt user a webhook belongs to.
 *
 * Metadata copied onto the subscription at checkout is authoritative. The
 * customer's `external_id` is the fallback, and it is the only one available
 * before the first subscription exists. Order payloads are read too: Polar
 * carries checkout metadata onto the order, which is what makes `order.paid`
 * attributable before any subscription event has been processed.
 */
function resolveUserId(
  data: (PolarSubscription & { order?: PolarOrder }) | undefined,
  subscription: BillingSubscription | null,
): string | null {
  void subscription;
  const fromMetadata = data?.metadata?.[USER_ID_METADATA_KEY];
  if (typeof fromMetadata === 'string' && fromMetadata) {
    return fromMetadata;
  }
  const fromCustomer = data?.customer?.external_id;
  if (typeof fromCustomer === 'string' && fromCustomer) {
    return fromCustomer;
  }
  const order = data?.order;
  const fromOrderMetadata = order?.metadata?.[USER_ID_METADATA_KEY];
  return typeof fromOrderMetadata === 'string' && fromOrderMetadata ? fromOrderMetadata : null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const polarProvider: PaymentProvider = {
  name: PROVIDER,

  capabilities: {
    planChange: true,
    deferredCancel: true,
    // Polar can pause a subscription, but this adapter exposes no pause method,
    // so it must not advertise the capability: a caller that trusted the flag
    // would offer a button with nothing behind it.
    pause: false,
    hostedCheckout: true,
  },

  createCheckout,
  fetchSubscription,

  cancelAtPeriodEnd,
  cancelNow,
  undoScheduledCancel,
  changePlan,

  listSubscriptions: async (_customerId: string | null, userId: string) => listSubscriptions(userId),

  parseWebhook,
};

export function polarEnvironment(): string {
  return ENVIRONMENT;
}

export { WEBHOOK_SECRET as polarWebhookSecret };