import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

if (typeof window.scrollTo === 'function') {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
}