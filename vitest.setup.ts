import { afterEach, vi } from 'vitest';
import { installDenoEnv } from './supabase/functions/test/edgeEnv';

// The Supabase edge functions run on Deno and read their configuration from
// `Deno.env` at module scope, so the shim has to exist before any test imports
// them. It is environment-agnostic.
installDenoEnv();

// Billing tests opt into the `node` environment, where there is no DOM. Only the
// browser-oriented setup may touch `window`.
const hasDom = typeof window !== 'undefined';

if (hasDom) {
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');

  afterEach(() => {
    cleanup();
  });

  if (typeof window.scrollTo === 'function') {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  }
}
