import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0';
import { corsHeaders, corsResponse } from '../_shared/cors.ts';
import { createRazorpayCustomer, razorpayJson } from '../_shared/razorpay.ts';
import type { RazorpaySubscriptionEntity } from '../_shared/razorpay.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const razorpayKeyId = Deno.env.get('RAZORPAY_KEY_ID') || '';

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface SessionBody {
  planId?: unknown;
}

interface CustomerRow {
  customer_id: string;
}

const ACTIVE_STATUSES = ['active', 'pending'];

async function getAuthenticatedUser(req: Request) {
  const authorization = req.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : authorization;
  if (!token) {
    return null;
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return null;
  }
  return data.user;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return corsResponse(405, { error: { code: 'bad_request', message: 'Use POST.' } });
  }

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return corsResponse(401, {
        error: { code: 'auth_required', message: 'You need to sign in first.' },
      });
    }

    const body = (await req.json().catch(() => null)) as SessionBody | null;
    const planId = typeof body?.planId === 'string' ? body.planId : '';
    if (!planId) {
      return corsResponse(400, {
        error: { code: 'bad_request', message: 'Missing planId.' },
      });
    }

    const { data: plan } = await supabase
      .from('plans')
      .select('id, price_id, active')
      .eq('id', planId)
      .maybeSingle();
    if (!plan) {
      return corsResponse(404, {
        error: { code: 'plan_not_found', message: 'Unknown plan.' },
      });
    }
    if (!plan.active) {
      return corsResponse(409, {
        error: { code: 'plan_unavailable', message: 'This plan is not available right now.' },
      });
    }
    const priceId = typeof plan.price_id === 'string' ? plan.price_id : '';
    if (!priceId) {
      return corsResponse(500, {
        error: {
          code: 'plan_not_configured',
          message:
            'This plan has no Razorpay price set yet. Set plans.price_id for it and try again.',
        },
      });
    }

    // Never offer a second checkout while the user already has an active plan.
    const { data: activeSub } = await supabase
      .from('subscriptions')
      .select('razorpay_subscription_id, plan_id, status')
      .eq('user_id', user.id)
      .in('status', ACTIVE_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeSub) {
      return corsResponse(409, {
        error: {
          code: 'already_active',
          message:
            'You already have an active subscription. Use Settings → Plan to upgrade, downgrade or cancel.',
        },
      });
    }

    // Reuse a checkout that is still genuinely in flight for the same plan
    // instead of stacking short-links, but never reuse one that has gone
    // stale: an abandoned auth/QR attempt poisons the subscription and the
    // payment step 400s ("payment not allowed at this stage"). Anything older
    // than the window is cancelled and replaced with a fresh subscription.
    const INFLIGHT_WINDOW_MS = 10 * 60 * 1000;
    const { data: inflight } = await supabase
      .from('subscriptions')
      .select('id, razorpay_subscription_id, plan_id, short_url, status, created_at')
      .eq('user_id', user.id)
      .in('status', ['created', 'authenticated'])
      .order('created_at', { ascending: false })
      .limit(10);
    const deadline = Date.now() - INFLIGHT_WINDOW_MS;
    const matching = (inflight ?? []).find(
      (row: { plan_id: string; created_at: string }) =>
        row.plan_id === planId && new Date(row.created_at).getTime() >= deadline,
    );
    if (matching) {
      const sub = await razorpayJson<RazorpaySubscriptionEntity>(
        `/subscriptions/${matching.razorpay_subscription_id}`,
      );
      return corsResponse(200, {
        subscriptionId: sub.id,
        shortUrl: sub.short_url || matching.short_url,
        status: sub.status,
        planId,
        key: razorpayKeyId,
      });
    }
    for (const stale of inflight ?? []) {
      try {
        await razorpayJson(`/subscriptions/${stale.razorpay_subscription_id}/cancel`, {
          method: 'POST',
          body: '{}',
        });
      } catch {
        // Already cancelled or unreachable; the fresh one below is what matters.
      }
    }

    // Razorpay customer: one per Paqt user.
    let customerId: string | null = null;
    const { data: customerRow } = await supabase
      .from('payments_customers')
      .select('customer_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (customerRow) {
      customerId = (customerRow as CustomerRow).customer_id;
    } else {
      const email = user.email || `user-${user.id}@paqt.local`;
      const customer = await createRazorpayCustomer({
        email,
        name: typeof user.user_metadata?.full_name === 'string'
          ? user.user_metadata.full_name
          : undefined,
        userId: user.id,
      });
      customerId = customer.id;
      const { error: custError } = await supabase
        .from('payments_customers')
        .insert({ user_id: user.id, customer_id: customer.id });
      if (custError) {
        console.error('[checkout] payments_customers insert failed:', custError);
      }
    }

    // Auto-renewing monthly subscription that keeps charging each cycle until
    // the user cancels (autopay on by default). Razorpay does not accept
    // total_count: 0 on creation and rejects payments when the subscription
    // extends past its documented 10-year window, so we bound it to 120
    // monthly cycles (10 years); cancellation ends it early.
    const subscription = await razorpayJson<RazorpaySubscriptionEntity>(
      '/subscriptions',
      {
        method: 'POST',
        body: JSON.stringify({
          plan_id: priceId,
          customer_id: customerId,
          total_count: 120,
          customer_notify: true,
          notes: {
            user_id: user.id,
            plan_id: planId,
            email: user.email || '',
          },
        }),
      },
    );

    const { error: insertError } = await supabase.from('subscriptions').insert({
      user_id: user.id,
      razorpay_subscription_id: subscription.id,
      short_url: subscription.short_url ?? null,
      customer_id: customerId,
      plan_id: planId,
      status: subscription.status || 'created',
      autopay: true,
      total_count: Number(subscription.total_count) || 0,
    });
    if (insertError) {
      throw insertError;
    }

    return corsResponse(200, {
      subscriptionId: subscription.id,
      shortUrl: subscription.short_url,
      status: subscription.status,
      planId,
      key: razorpayKeyId,
    });
  } catch (error) {
    console.error('[checkout] failed:', error);
    const message = error instanceof Error ? error.message : 'Could not start checkout.';
    const code = (error as { code?: string }).code || 'checkout_failed';
    const status =
      typeof (error as { status?: unknown }).status === 'number'
        ? Number((error as { status?: unknown }).status)
        : 500;
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    return corsResponse(safeStatus, { error: { code, message } });
  }
});