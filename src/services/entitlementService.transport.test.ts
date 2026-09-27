import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
const session = { access_token: 'jwt-token' };

vi.mock('../lib/supabase', () => ({
  supabaseOrThrow: () => ({ auth: { getSession } }),
}));

import {
  beginCheckout,
  manageSubscription,
  cancelSubscription,
  resumeSubscription,
  resetCheckoutIdempotencyKey,
} from './entitlementService';

const OK_SUBSCRIPTION = {
  has_subscription: true,
  status: 'active',
  plan_id: 'individual',
  plan_name: 'Individual',
  period_start: 1_767_571_200_000,
  period_end: 1_770_163_200_000,
  subscription_id: 'sub_1',
  cancel_at_period_end: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** The error shape the edge functions use, so codes survive the round trip. */
function errorResponse(status: number, code: string, message: string, extra = {}): Response {
  return jsonResponse({ error: { code, message, ...extra } }, status);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue({ data: { session } });
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(OK_SUBSCRIPTION));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** The one thing that actually decides whether the request is well formed. */
function sentRequest(): { url: string; init: RequestInit } {
  return { url: fetchMock.mock.calls[0][0] as string, init: fetchMock.mock.calls[0][1] as RequestInit };
}

function header(name: string): string | undefined {
  const headers = sentRequest().init.headers as Record<string, string>;
  return headers[name];
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as { code?: string }).code ?? '<no code>';
  }
  return '<did not throw>';
}

describe('authorisation', () => {
  it('sends the session token to the edge function', async () => {
    await manageSubscription();

    expect(header('Authorization')).toBe('Bearer jwt-token');
  });

  it('reports an expired session instead of calling the edge function', async () => {
    // An empty bearer produced an opaque server-side rejection that read like a
    // billing outage; the customer would retry payment instead of signing in.
    getSession.mockResolvedValue({ data: { session: null } });

    expect(await errorCode(manageSubscription())).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('requests', () => {
  it('posts the action to the subscription-manage function', async () => {
    await cancelSubscription();

    expect(sentRequest().url).toContain('subscription-manage');
    expect(sentRequest().init.method).toBe('POST');
    expect(JSON.parse(sentRequest().init.body as string)).toEqual({ action: 'cancel' });
  });

  it('asks for a status read through manageSubscription', async () => {
    await manageSubscription();

    expect(JSON.parse(sentRequest().init.body as string)).toEqual({ action: 'status' });
  });

  it('asks to resume through resumeSubscription', async () => {
    await resumeSubscription();

    expect(JSON.parse(sentRequest().init.body as string)).toEqual({ action: 'resume' });
  });

  it('sends the plan the customer chose to create-checkout-session', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ key_id: 'rzp_test', subscription_id: 'sub_1' }));

    await beginCheckout('pro', { paymentMethod: 'new' });

    expect(sentRequest().url).toContain('create-checkout-session');
    expect(JSON.parse(sentRequest().init.body as string)).toMatchObject({
      plan_id: 'pro',
      payment_method: 'new',
    });
  });

  it('reuses one idempotency key until the attempt is reset', async () => {
    // Razorpay refuses a replayed key with different details, so a retry of the
    // *same* attempt must reuse it; a new attempt must get a new one.
    fetchMock.mockResolvedValue(jsonResponse({ key_id: 'rzp_test', subscription_id: 'sub_1' }));

    await beginCheckout('pro');
    const first = JSON.parse(sentRequest().init.body as string).idempotency_key;
    await beginCheckout('pro', { confirmReplacingPaidPeriod: true });
    const retried = JSON.parse(fetchMock.mock.calls[1][1].body as string).idempotency_key;

    expect(first).toBeTruthy();
    expect(retried).toBe(first);

    resetCheckoutIdempotencyKey();
    await beginCheckout('pro');
    const next = JSON.parse(fetchMock.mock.calls[2][1].body as string).idempotency_key;

    expect(next).not.toBe(first);
  });
});

describe('timeouts and transport failures', () => {
  it('bounds a hanging billing call with a timeout', async () => {
    // Without a bound the checkout spinner never resolves and the customer has
    // no idea whether they were charged.
    await manageSubscription();

    const signal = sentRequest().init.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('turns a network failure into billing_unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await errorCode(manageSubscription())).toBe('billing_unreachable');
  });

  it('turns a timed-out request into billing_unreachable', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    fetchMock.mockRejectedValue(timeout);

    expect(await errorCode(cancelSubscription())).toBe('billing_unreachable');
  });
});

describe('error responses', () => {
  it('preserves the error code the edge function sent', async () => {
    fetchMock.mockResolvedValue(errorResponse(409, 'no_subscription', 'You have no active subscription.'));

    expect(await errorCode(cancelSubscription())).toBe('no_subscription');
  });

  it('carries the grace period through so the UI can tell the customer when access ends', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(409, 'grace_period_replacement_required', 'Your plan changes at the end of the period.', {
        grace_period_end: 1_770_163_200_000,
        new_plan_name: 'Pro',
        current_plan_name: 'Individual',
      }),
    );

    const err = (await cancelSubscription().catch((e) => e)) as Record<string, unknown>;
    expect(err.code).toBe('grace_period_replacement_required');
    expect(err.gracePeriodEnd).toBe(1_770_163_200_000);
    expect(err.newPlanName).toBe('Pro');
    expect(err.currentPlanName).toBe('Individual');
  });

  it('falls back to billing_failed when the response has no code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));

    expect(await errorCode(manageSubscription())).toBe('billing_failed');
  });

  it('survives a non-JSON error body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    } as unknown as Response);

    expect(await errorCode(manageSubscription())).toBe('billing_failed');
  });
});
