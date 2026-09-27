/**
 * Test doubles for the billing integration.
 *
 * The edge functions talk to two things: Razorpay over HTTP and Postgres through
 * the service-role client. Both are replaced here so a test can drive a complete
 * checkout/webhook/reconciliation flow deterministically and assert on the exact
 * snapshot the database was asked to store.
 */
import { vi } from 'vitest';
import type { PlanRow } from '../_shared/billing.ts';

export interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

export interface FakeDb {
  plans: PlanRow[];
  rpcCalls: RpcCall[];
  /** Returned by `admin.rpc(name)`; a function is called with the args. */
  rpcResults: Record<string, unknown>;
  /** Errors keyed by RPC name, shaped like a supabase-js PostgREST error. */
  rpcErrors: Record<string, { message: string; code?: string }>;
  /** Returned by `admin.auth.getUser(token)`; null means the token is rejected. */
  authUser?: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null;
  /** Forces `auth.getUser` to fail, e.g. a revoked session. */
  authError?: { message: string } | null;
  /** Every token `auth.getUser` was called with, in order. */
  authTokens: string[];
}

export function createFakeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    plans: [],
    rpcCalls: [],
    rpcResults: {},
    rpcErrors: {},
    authUser: null,
    authTokens: [],
    ...overrides,
  };
}

/** The most recent `paqt_upsert_subscription` snapshot, or undefined. */
export function lastSnapshot(db: FakeDb): Record<string, any> | undefined {
  for (let i = db.rpcCalls.length - 1; i >= 0; i -= 1) {
    const call = db.rpcCalls[i];
    if (call.name === 'paqt_upsert_subscription') {
      return call.args.p_snapshot as Record<string, any>;
    }
  }
  return undefined;
}

export function rpcCallCount(db: FakeDb, name: string): number {
  return db.rpcCalls.filter((call) => call.name === name).length;
}

type Row = Record<string, any>;

/**
 * A minimal stand-in for the parts of the supabase-js query builder the billing
 * code uses: `from().select().eq().maybeSingle()`, `update().eq()` and
 * `upsert()`, plus `rpc()`. Builders are thenable so they can be awaited
 * directly or after an `eq()`.
 */
/** RPCs whose Postgres return type is a plain boolean. */
const BOOLEAN_RPCS = new Set(['paqt_claim_billing', 'paqt_claim_webhook_event']);
/** RPCs whose Postgres return type is a rowset, which the caller iterates. */
const ROWSET_RPCS = new Set(['paqt_sweep_abandoned_subscriptions', 'paqt_sweep_stale_claims']);

export function createFakeAdmin(db: FakeDb): any {
  function resolve(result: { data?: unknown; error?: { message: string } | null }) {
    return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
  }

  function builder(table: string, mode: 'select' | 'update' | 'upsert', payload?: Row) {
    const filters: Row = {};
    const api: Row = {
      select: () => builder(table, 'select'),
      // supabase-js allows `from(t).upsert(...)` directly, which the customer
      // linker relies on, so every builder carries the write verbs.
      update: (values: Row) => builder(table, 'update', values),
      upsert: (values: Row) => builder(table, 'upsert', values),
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return api;
      },
      maybeSingle: () => {
        if (table !== 'plans') {
          return resolve({ data: null });
        }
        const match = db.plans.find((plan) =>
          Object.entries(filters).every(([column, value]) => (plan as Row)[column] === value),
        );
        return resolve({ data: match ?? null });
      },
      // An awaited list query has to resolve to an array: the sweeps iterate the
      // rows, so `null` here would look like a database bug rather than no rows.
      then: (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(onFulfilled),
    };
    void mode;
    void payload;
    return api;
  }

  return {
    from: (table: string) => builder(table, 'select'),
    auth: {
      // Mirrors `supabase.auth.getUser(token)`, which the billing handlers use
      // to turn an access token into a trustworthy user id.
      getUser: (token: string) => {
        db.authTokens.push(token);
        if (db.authError) return resolve({ error: db.authError });
        if (!db.authUser) return resolve({ error: { message: 'invalid JWT' } });
        return resolve({ data: { user: db.authUser } });
      },
    },
    rpc: (name: string, args: Row = {}) => {
      db.rpcCalls.push({ name, args });
      const failure = db.rpcErrors[name];
      if (failure) {
        return resolve({ error: { message: failure.message, code: failure.code } });
      }
      const configured = db.rpcResults[name];
      if (configured !== undefined) {
        const value =
          typeof configured === 'function' ? (configured as (a: Row) => unknown)(args) : configured;
        return resolve({ data: value });
      }
      // `paqt_claim_*` return a bare boolean that the caller compares with `=== true`,
      // so an object here would read as "not claimed" and silently skip the work.
      if (BOOLEAN_RPCS.has(name)) {
        return resolve({ data: true });
      }
      if (ROWSET_RPCS.has(name)) {
        return resolve({ data: [] });
      }
      return resolve({ data: { ok: true, user_id: args.p_user ?? args.user_id ?? null } });
    },
  };
}

export interface RazorpayScript {
  /** Served from `GET /v1/subscriptions?count=&skip=`. */
  subscriptions?: unknown[];
  /** Keyed by subscription id. */
  byId?: Record<string, unknown>;
  /**
   * Keyed by subscription id, the state returned by a write. Defaults to
   * `byId`, but a cancellation has to answer as *confirmed* for the handler to
   * believe it, so tests can script the before/after pair.
   */
  patched?: Record<string, unknown>;
  /** Keyed by customer id, for `GET /v1/customers/{id}`. */
  customers?: Record<string, unknown>;
  /** Returned by `POST /v1/customers`. */
  createdCustomer?: unknown;
  /** Returned by `POST /v1/subscriptions`, i.e. a new checkout. */
  createdSubscription?: unknown;
  /** Ids that should answer 404, e.g. deleted upstream. */
  missing?: string[];
}

/** Every HTTP call the code under test made to Razorpay. */
export interface RazorpayHarness {
  calls: { method: string; url: string; body: unknown }[];
  /** Notes written back via `PATCH /v1/customers/{id}`. */
  patchedNotes: { id: string; notes: unknown }[];
}

/**
 * Installs a `fetch` that speaks just enough Razorpay for the billing code:
 * subscription list, single-subscription fetch, cancel and resume.
 */
export function installRazorpay(script: RazorpayScript): RazorpayHarness {
  const harness: RazorpayHarness = { calls: [], patchedNotes: [] };
  const byId = script.byId ?? {};

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const mock = vi.fn(async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    harness.calls.push({ method, url, body });

    const customer = /\/v1\/customers\/([^/?]+)$/.exec(url);
    if (customer && method === 'PATCH') {
      harness.patchedNotes.push({ id: customer[1], notes: body?.notes });
      const found = script.customers?.[customer[1]];
      return json(200, { ...(found ?? { id: customer[1] }), ...body });
    }
    if (method === 'GET' && customer) {
      const found = script.customers?.[customer[1]];
      if (!found) {
        return json(404, { error: { code: 'BAD_REQUEST_ERROR', description: 'not found' } });
      }
      return json(200, found);
    }
    if (method === 'POST' && /\/v1\/customers$/.test(url)) {
      const created = script.createdCustomer;
      if (!created) {
        return json(404, { error: { code: 'BAD_REQUEST_ERROR', description: 'unmocked POST customers' } });
      }
      return json(200, created);
    }

    if (method === 'POST' && /\/v1\/subscriptions$/.test(url)) {
      const created = script.createdSubscription;
      if (!created) {
        return json(404, { error: { code: 'BAD_REQUEST_ERROR', description: 'unmocked POST subscriptions' } });
      }
      return json(200, created);
    }

    const single = /\/v1\/subscriptions\/([^/?]+)$/.exec(url);
    if (single) {
      const id = single[1];
      if (script.missing?.includes(id)) {
        return json(404, { error: { code: 'BAD_REQUEST_ERROR', description: 'not found' } });
      }
      const sub = method === 'PATCH' ? (script.patched?.[id] ?? byId[id]) : byId[id];
      if (!sub) {
        return json(404, { error: { code: 'BAD_REQUEST_ERROR', description: 'not found' } });
      }
      return json(200, sub);
    }

    if (method === 'POST' && /\/v1\/subscriptions\/[^/]+\/cancel$/.test(url)) {
      return json(200, byId[/\/v1\/subscriptions\/([^/]+)\/cancel$/.exec(url)![1]] ?? {});
    }
    if (method === 'POST' && /\/v1\/subscriptions\/[^/]+\/resume$/.test(url)) {
      return json(200, byId[/\/v1\/subscriptions\/([^/]+)\/resume$/.exec(url)![1]] ?? {});
    }
    // Any other lifecycle verb on a subscription (cancel_scheduled_changes,
    // schedule_change, ...) echoes the subscription back, as Razorpay does.
    if (method === 'POST' && /\/v1\/subscriptions\/[^/]+\/[a-z_]+$/.test(url)) {
      return json(200, byId[/\/v1\/subscriptions\/([^/]+)\//.exec(url)![1]] ?? {});
    }

    if (/\/v1\/subscriptions\?/.test(url)) {
      // A single page is enough: the client stops when a short page arrives.
      return json(200, { items: script.subscriptions ?? [] });
    }

    return json(404, { error: { code: 'BAD_REQUEST_ERROR', description: `unmocked ${method} ${url}` } });
  });

  vi.stubGlobal('fetch', mock);
  return harness;
}

/** Installs a fetch that always fails, to exercise provider-outage handling. */
export function installFailingRazorpay(status = 500, code = 'SERVER_ERROR'): RazorpayHarness {
  const harness: RazorpayHarness = { calls: [], patchedNotes: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init: RequestInit = {}) => {
      harness.calls.push({
        method: (init.method ?? 'GET').toUpperCase(),
        url: String(input),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ error: { code, description: 'boom' } }), { status });
    }),
  );
  return harness;
}
