import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // Edge functions are written for Deno and import Supabase with a `npm:`
      // specifier. Under Vitest that specifier cannot be resolved, so it is
      // pointed at the very same package the app already depends on.
      {
        find: /^npm:@supabase\/supabase-js@2$/,
        replacement: '@supabase/supabase-js',
      },
    ],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // Kept at the repo root rather than under `src/`: it installs a shim for the
    // Deno edge functions, and the app image only ships `src`, so a file under
    // `src/` would break `tsc -b` in the frontend Docker build.
    setupFiles: ['./vitest.setup.ts'],
    // The billing edge functions carry the money logic and must be covered too.
    include: ['src/**/*.test.{ts,tsx}', 'supabase/functions/**/*.test.ts'],
  },
});
