import type { Admin } from './razorpay.ts';

/** Thrown by handlers to produce a JSON error response without a try/catch at
 *  every call site. `message` is always safe to show a user. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * Extra machine-readable fields sent alongside the message, so the client can
   * react to a specific case (a grace period that would be given up) instead of
   * showing generic advice the customer cannot act on.
   */
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * CORS for the billing endpoints.
 *
 * `Vary: Origin` matters because the response may be served from a cache keyed
 * without the origin; without it a browser can be handed another origin's
 * response.
 */
export function corsHeaders(request?: Request): Record<string, string> {
  const origin = request?.headers.get('origin') ?? '';
  const allowed = allowedOrigin(origin);
  return {
    ...(allowed ? { 'Access-Control-Allow-Origin': allowed } : {}),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const ALLOWED_ORIGIN_SUFFIXES = ['.supabase.co', '.onrender.com', '.vercel.app', '.netlify.app', '.pages.dev'];

/**
 * Local development runs on whatever port the dev server picked, so the port is
 * not pinned. Requests still need a valid user token, which a page on another
 * localhost port cannot read, so this cannot be used to act as a signed-in user.
 */
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Returns the origin to echo back, or null to send no CORS header at all.
 *
 * Local origins are always allowed, because development runs on a different port
 * every time and pinning that would just break the next `npm run dev`. They cannot
 * be used to act as a signed-in user: a page on some other localhost port has no
 * access to this app's Supabase session token.
 *
 * `APP_ORIGIN_ALLOW_LIST` (comma separated) is exact-match for everything else, so
 * a deployment on a custom domain can pin itself; `APP_URL` is honoured as a single
 * exact origin for the common case of not maintaining a list.
 */
function allowedOrigin(origin: string): string | null {
  if (!origin) {
    return null;
  }
  if (LOCAL_ORIGIN.test(origin)) {
    return origin;
  }
  const envList =
    (typeof Deno !== 'undefined' && (Deno.env.get('APP_ORIGIN_ALLOW_LIST') ?? Deno.env.get('APP_URL'))) ??
    (typeof process !== 'undefined' && ((process.env as any)?.APP_ORIGIN_ALLOW_LIST ?? (process.env as any)?.APP_URL)) ??
    '';
  const list = envList
    .trim()
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (list.length > 0) {
    return list.includes(origin) ? origin : null;
  }
  return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => origin.endsWith(suffix)) ? origin : null;
}

/**
 * Whether a browser origin may be reflected back, per the same allow-list CORS uses.
 *
 * Exported because "is this origin ours?" has to be answered before an origin is
 * used to build a URL we then hand to a third party. CORS cannot enforce that on
 * its own: it only decides whether to *return* the origin in a response header, and
 * a non-browser caller can omit or forge the header entirely. Checking the same
 * list explicitly is what makes an origin safe to embed in a redirect target.
 */
export function isAllowedOrigin(origin: string): boolean {
  return allowedOrigin(origin) !== null;
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  request?: Request,
  details: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message, ...details } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

export function jsonOk(body: Record<string, unknown> = {}, request?: Request): Response {
  return new Response(JSON.stringify({ received: true, ...body }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

export function jsonBody(body: Record<string, unknown>, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

export function preflight(req: Request): Response {
  return new Response('ok', { headers: corsHeaders(req) });
}

export function methodNotAllowed(req: Request): Response {
  return jsonError(405, 'bad_request', 'Use POST.', req);
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'bad_request', 'Request body must be JSON.');
  }
}

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Verifies the caller's Supabase access token.
 *
 * The gateway already rejects unauthenticated calls (verify_jwt), but the token
 * is re-verified against auth so a revoked session cannot drive billing, and so
 * the handler gets a trustworthy user id rather than trusting the payload.
 */
export async function requireUser(admin: Admin, req: Request): Promise<AuthedUser> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    throw new HttpError(401, 'unauthorized', 'Sign in first.');
  }
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) {
    throw new HttpError(401, 'unauthorized', 'Your session has expired. Sign in again.');
  }
  const metadata = (data.user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (typeof metadata.full_name === 'string' && metadata.full_name) ||
    (typeof metadata.name === 'string' && metadata.name) ||
    '';
  return { id: data.user.id, email: data.user.email ?? '', name };
}

export function toResponse(err: unknown, req: Request): Response {
  if (err instanceof HttpError) {
    return jsonError(err.status, err.code, err.message, req, err.details);
  }
  console.error('[billing] unhandled error:', (err as Error)?.stack ?? err);
  return jsonError(500, 'internal_error', 'Something went wrong. Try again in a moment.', req);
}
