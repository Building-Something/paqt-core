import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0';
import { corsHeaders, corsResponse } from '../_shared/cors.ts';
import { razorpayJson } from '../_shared/razorpay.ts';
import type { RazorpaySubscriptionEntity } from '../_shared/razorpay.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface ManageBody {
  action?: unknown;
  planId?: unknown;
}

type DbSubscription = {
  razorpay_subscription_id: string;
  short_url?: string | null;
  customer_id?: string | null;
  plan_id: string;
  pending_plan_id?: string | null;
  status: string;
  current_period_start?: number | null;
  current_period_end?: number | null;
  ends_at?: number | null;
};

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

async function currentSubscription(userId: string): Promise<DbSubscription | null> {
  const { data } = await supabase
    .from('subscriptions')
    .select(
      'razorpay_subscription_id, short_url, customer_id, plan_id, pending_plan_id, status, current_period_start, current_period_end, ends_at',
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as DbSubscription | null) ?? null;
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

    const body = (await req.json().catch(() => null)) as ManageBody | null;
    const action = typeof body?.action === 'string' ? body.action : '';
    if (!action || !['cancel', 'schedule_change'].includes(action)) {
      return corsResponse(400, {
        error: { code: 'bad_request', message: 'Unknown action.' },
      });
    }

    const sub = await currentSubscription(user.id);
    if (!sub) {
      return corsResponse(404, {
        error: { code: 'no_subscription', message: 'You have no subscription yet.' },
      });
    }

    const subscriptionId = sub.razorpay_subscription_id;

    if (action === 'cancel') {
      const immediate = !['active', 'pending'].includes(sub.status);
      const entity = await razorpayJson<RazorpaySubscriptionEntity>(
        `/subscriptions/${subscriptionId}/cancel`,
        { method: 'POST', body: JSON.stringify({ cancel_at_cycle_end: !immediate }) },
      );
      const { error } = await supabase
        .from('subscriptions')
        .update({
          status: entity.status,
          autopay: false,
          ends_at: entity.end_at ?? entity.ended_at ?? sub.ends_at ?? null,
          cancelled_at: entity.ended_at ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('razorpay_subscription_id', subscriptionId);
      if (error) {
        throw error;
      }
      return corsResponse(200, {
        ok: true,
        status: entity.status,
        autopay: false,
        endsAt: entity.end_at ?? entity.ended_at ?? null,
        immediate,
        message: immediate
          ? 'Your subscription was cancelled.'
          : 'Automatic renewal is off. You keep access until the end of your current billing period.',
      });
    }

    if (action === 'resume') {
      return corsResponse(400, {
        error: {
          code: 'bad_request',
          message: 'A cancelled subscription cannot re-enable auto-renew. Subscribe again instead.',
        },
      });
    }

    // schedule_change: upgrade or downgrade, effective after the current period.
    const planId = typeof body?.planId === 'string' ? body.planId : '';
    if (!planId) {
      return corsResponse(400, {
        error: { code: 'bad_request', message: 'Missing planId.' },
      });
    }
    if (planId === sub.plan_id) {
      return corsResponse(409, {
        error: { code: 'same_plan', message: 'You are already on this plan.' },
      });
    }
    if (sub.status !== 'active') {
      return corsResponse(409, {
        error: { code: 'invalid_state', message: 'Only an active subscription can change plans.' },
      });
    }
    const { data: plan } = await supabase
      .from('plans')
      .select('id, price_id, active')
      .eq('id', planId)
      .maybeSingle();
    const priceId = typeof plan?.price_id === 'string' ? plan.price_id : '';
    if (!plan || !plan.active || !priceId) {
      return corsResponse(409, {
        error: {
          code: 'plan_not_configured',
          message: 'That plan is not ready for checkout yet.',
        },
      });
    }

    const entity = await razorpayJson<RazorpaySubscriptionEntity>(
      `/subscriptions/${subscriptionId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          plan_id: priceId,
          schedule_change_at: 'cycle_end',
          customer_notify: true,
        }),
      },
    );

    const { error } = await supabase
      .from('subscriptions')
      .update({
        pending_plan_id: planId,
        updated_at: new Date().toISOString(),
      })
      .eq('razorpay_subscription_id', subscriptionId);
    if (error) {
      throw error;
    }

    return corsResponse(200, {
      ok: true,
      status: entity.status,
      pendingPlanId: planId,
      effectiveAtPeriodEnd: true,
      message: `You're switching to ${plan.name}. It takes effect when your current billing period ends.`,
    });
  } catch (error) {
    console.error('[manage] failed:', error);
    const message = error instanceof Error ? error.message : 'Could not update your subscription.';
    const code = (error as { code?: string }).code || 'manage_failed';
    const status =
      typeof (error as { status?: unknown }).status === 'number'
        ? Number((error as { status?: unknown }).status)
        : 500;
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    return corsResponse(safeStatus, { error: { code, message } });
  }
});