// `tsconfig.app.json` lists `@testing-library/jest-dom` under `types`, which
// registers the matchers with Jest's globals but not with Vitest's `Assertion`
// interface, so `expect(...).toBeInTheDocument()` would not type-check. This
// import performs the module augmentation.
//
// The matchers themselves are loaded at runtime by `vitest.setup.ts`, which lives
// at the repo root because it also installs a Deno shim for the edge-function
// tests and the app image only ships `src`.
import '@testing-library/jest-dom/vitest';
