/**
 * Provider-agnostic billing contracts.
 *
 * The billing lifecycle Paqt cares about — a customer holds a plan, it renews,
 * they cancel, they change tier — is modelled once here. Each provider maps its
 * own vocabulary onto these types, so the edge functions can decide what to do
 * without knowing whether the answer came from Razorpay or Polar.
 *
 * Everything that is genuinely provider-specific (raw payloads, SDK handles,
 * provider error codes) stays inside an adapter and never reaches a caller.
 */

/** Which payment provider an operation or stored row belongs to. */
export type ProviderName = 'razorpay' | 'polar';

/**
 * Recurring interval, normalized to Polar's vocabulary because it is the smaller
 * set. Razorpay's `billing_period` ('monthly'/'yearly') is translated at the edge.
 */
export type BillingInterval = 'month' | 'year';

/**
 * One saleable price for one Paqt plan at one provider.
 *
 * A plan is a Paqt concept ('individual'); a provider needs its own identifier
 * for the thing being sold. Polar keys on the *product* id: checkout takes
 * `products: [product_id]` and a plan change takes `product_id`. Prices hang off
 * products rather than being addressed directly, so `providerProductId` is the
 * field that actually resolves a purchase. `providerPriceId` is optional and
 * carried for display only.
 */
export interface PlanPrice {
  planId: string;
  provider: ProviderName;
  providerProductId: string;
  providerPriceId?: string | null;
  currency: string;
  /** Minor units (cents for USD/paise for INR), matching every provider. */
  unitAmount: number;
  interval: BillingInterval;
}

/**
 * A subscription in Paqt's terms, whatever the provider calls it.
 *
 * Timestamps are ms epoch to match the rest of Paqt's storage convention; Polar's
 * ISO-8601 strings are converted on the way in.
 */
export interface BillingSubscription {
  provider: ProviderName;
  /** Provider's own subscription id, e.g. `sub_...`. */
  id: string;
  customerId: string | null;
  /** Provider's product id this subscription is currently billed against. */
  providerProductId: string | null;
  status: string;
  /**
   * The provider's own status string, verbatim and unnormalized.
   *
   * Required because the charge gate cannot run on `status`: `status` is Paqt's
   * vocabulary, while "did money actually move" is a question only the provider's
   * own wording can answer. It is also what reconciliation diffs against later.
   */
  providerStatus: string;
  startedAt: number | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  /** True when access continues to `currentPeriodEnd` and then stops. */
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
  endedAt: number | null;
  /** A plan change the provider has accepted but not yet applied. */
  pendingProductId: string | null;
}

/**
 * A provider event reduced to the facts the billing state machine needs.
 *
 * `eventId` must be stable across redeliveries of the same event: providers
 * deliver at-least-once, and the dedup ledger rejects a repeat. Polar's envelope
 * carries no id at all, so the adapter derives one from the event's contents.
 */
export interface NormalizedBillingEvent {
  provider: ProviderName;
  eventId: string;
  type: string;
  occurredAt: number | null;
  /** The subscription this event concerns, when it concerns one. */
  subscription: BillingSubscription | null;
  /**
   * A subscription id carried by an event that is *about* a subscription without
   * describing it.
   *
   * Order events are the case that needs this: Polar sends `subscription_id` on
   * the order but no subscription payload, so `subscription` is null. Without it a
   * paid renewal could be booked as a payment with no way to tell which
   * subscription earned it.
   */
  providerSubscriptionId: string | null;
  /** True when money definitely moved (a charge, or a refund going back). */
  moneyMoved: boolean;
  /** Payment/order id to book in the ledger, when the provider sent one. */
  paymentRef: string | null;
  paymentAmount: number | null;
  paymentCurrency: string | null;
  userId: string | null;
}

/**
 * What the caller needs to send a customer to a provider-hosted payment page.
 *
 * Polar returns a hosted URL the browser is redirected to; Razorpay instead
 * returns a key id plus subscription id for a JS modal. `url` is therefore
 * optional, and `redirect()` tells the caller which interaction it got.
 */
export interface CheckoutResult {
  provider: ProviderName;
  planId: string;
  /** Hosted page to navigate to, when the provider uses one. */
  url: string | null;
  /** Provider's checkout/session id, for reconciliation. */
  checkoutRef: string;
  /** True when the browser must navigate to `url` rather than open a modal. */
  redirect: boolean;
}

/**
 * A provider failure.
 *
 * `detail` is for logs only and is never returned to the browser: it can carry
 * account identifiers and provider wording that is not ours to expose.
 */
export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly retryable: boolean;

  constructor(provider: ProviderName, status: number, code: string, detail: string) {
    super(`${provider} ${code} (${status})`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.code = code;
    this.detail = detail;
    // Status 0 is the adapter's marker for a transport failure (timeout, DNS, reset),
    // which is the most retryable case there is: the request may or may not have
    // landed upstream, so the caller must reconcile rather than assume either way.
    this.retryable = status === 0 || status === 429 || status >= 500;
  }
}

/**
 * Optional behaviours a provider may not support.
 *
 * Call sites must degrade rather than pretend: a provider without
 * `deferredCancel` cannot be asked to stop billing while keeping access, so the
 * caller has to decide explicitly instead of silently revoking paid-for access.
 */
export interface ProviderCapabilities {
  planChange: boolean;
  deferredCancel: boolean;
  pause: boolean;
  /** True when the customer is sent to a hosted page instead of an in-app modal. */
  hostedCheckout: boolean;
}

/** Arguments for creating a checkout, shared by every provider. */
export interface CreateCheckoutInput {
  userId: string;
  email: string;
  name: string;
  planId: string;
  /** Correlates a retry with the operation that created it. */
  operationId: string;
  /** Where the provider returns the customer after payment. */
  successUrl: string;
  /** Where the customer can back out of payment. */
  cancelUrl: string;
}

/** Signature material for a webhook delivery, as the provider sends it. */
export interface WebhookHeaders {
  signature: string | null;
  /** Standard Webhooks delivery id; part of the signed payload. */
  id?: string | null;
  /** Standard Webhooks delivery timestamp, seconds; part of the signed payload. */
  timestamp?: string | null;
}

/** The surface the edge functions program against. */
export interface PaymentProvider {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;

  createCheckout(input: CreateCheckoutInput, price: PlanPrice): Promise<CheckoutResult>;

  fetchSubscription(id: string): Promise<BillingSubscription>;

  /**
   * Stops future charges while keeping access until `currentPeriodEnd`.
   * Throws {@link ProviderError} when the provider refuses.
   */
  cancelAtPeriodEnd(id: string): Promise<BillingSubscription>;

  /** Ends the subscription immediately, revoking access. Irreversible. */
  cancelNow(id: string): Promise<BillingSubscription>;

  /**
   * Undoes a scheduled end-of-period cancellation so billing continues.
   *
   * Named for what it does rather than `resume`, because "resume" collides with
   * unpausing a paused subscription, which is a different provider call. Paqt's
   * user-facing action is "keep my plan"; this is its inverse.
   */
  undoScheduledCancel(id: string): Promise<BillingSubscription>;

  /** Moves an existing subscription onto another product. */
  changePlan(id: string, toProductId: string, when: 'period_end' | 'immediate'): Promise<BillingSubscription>;

  /** Lists a customer's subscriptions, newest first. Never throws. */
  listSubscriptions(customerId: string | null, userId: string): Promise<BillingSubscription[]>;

  /**
   * Verifies a webhook signature and reduces the body to normalized events.
   * Must throw rather than return [] on an unverified body.
   *
   * Headers are passed as a bag rather than as a single signature string because
   * the schemes genuinely differ: Razorpay signs with one `x-razorpay-signature`
   * header, while Polar's Standard Webhooks binds the signature to a delivery id
   * and timestamp (`webhook-id`, `webhook-timestamp`, `webhook-signature`), and
   * verifying without the first two would make every delivery replayable. A
   * provider that only needs the signature reads `headers.signature`.
   */
  parseWebhook(raw: string, headers: WebhookHeaders, secret: string): Promise<NormalizedBillingEvent[]>;
}