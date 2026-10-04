/**
 * Deno runtime shim for running the Supabase edge functions under Vitest.
 *
 * The functions read their configuration from `Deno.env` at module scope. Under
 * Node that global does not exist, so importing the module would throw before a
 * single assertion ran. This installs just enough of the Deno surface for the
 * billing code to load, backed by a mutable record that tests can drive.
 */

export interface EdgeEnv {
  [key: string]: string | undefined;
}

/** Mutable so a test can change credentials and re-import the module. */
export const edgeEnv: EdgeEnv = {
  SUPABASE_URL: 'https://project.test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
  RAZORPAY_KEY_ID: 'rzp_test_key_id',
  RAZORPAY_KEY_SECRET: 'rzp_test_key_secret',
  RAZORPAY_WEBHOOK_SECRET: 'webhook_test_secret',
  POLAR_ACCESS_TOKEN: 'polar_test_oat',
  // Must be `whsec_` followed by VALID base64: the adapter base64-decodes the
  // suffix to get the HMAC key, and `atob` throws on anything outside the alphabet
  // (notably `_`), which would make every signature verification fail.
  POLAR_WEBHOOK_SECRET: 'whsec_dGVzdC1zaWduaW5nLWtleS1tYXRlcmlhbA==',
  POLAR_ENVIRONMENT: 'sandbox',
  APP_URL: 'https://app.test',
};

/**
 * Snapshots the current environment so a test that changes it can restore it,
 * which matters because the functions capture `Deno.env` values once at import.
 */
export function withEdgeEnv(overrides: EdgeEnv): () => void {
  const previous: EdgeEnv = { ...edgeEnv };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete edgeEnv[key];
    } else {
      edgeEnv[key] = value;
    }
  }
  return () => {
    for (const key of Object.keys(edgeEnv)) {
      if (!(key in previous)) {
        delete edgeEnv[key];
      }
    }
    Object.assign(edgeEnv, previous);
  };
}

export type EdgeHandler = (req: Request) => Response | Promise<Response>;

/** Handlers registered via `Deno.serve`, in registration order. */
export const serveHandlers: EdgeHandler[] = [];

export function installDenoEnv(): void {
  const deno = {
    env: {
      get: (key: string): string | undefined => edgeEnv[key],
    },
    // Captured rather than served, so a test can invoke the exact handler the
    // edge runtime would, instead of a re-implementation of it.
    serve: (handler: EdgeHandler) => {
      serveHandlers.push(handler);
      return { finished: Promise.resolve() };
    },
  };
  Object.defineProperty(globalThis, 'Deno', {
    value: deno,
    configurable: true,
    writable: true,
  });
  serveHandlers.length = 0;
}
