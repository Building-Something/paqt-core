import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import './index.css';
import App from './App';
import { configureWorker } from './services/pdfService';

configureWorker();

const RUNTIME_ERRORS_KEY = 'paqt.lastErrors';

function recordRuntimeError(type: string, detail: string): void {
  try {
    const entry = { type, detail, time: Date.now(), href: window.location.href };
    const existing = JSON.parse(window.sessionStorage.getItem(RUNTIME_ERRORS_KEY) ?? '[]') as unknown[];
    const next = [...existing, entry].slice(-5);
    window.sessionStorage.setItem(RUNTIME_ERRORS_KEY, JSON.stringify(next));
  } catch {
    // Best-effort diagnostics.
  }
}

window.addEventListener('error', (event) => {
  const error = event.error;
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : event.message;
  recordRuntimeError('error', detail);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const detail =
    reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
  recordRuntimeError('rejection', detail);
});

/**
 * Radix's modal layers lock the whole page with `body { pointer-events: none }`
 * and restore it on unmount. If a layer goes away without restoring it (a route
 * change mid-close-animation, a remount, StrictMode's double-invoke), every
 * click in the app silently stops working until the page is reloaded — the UI
 * still looks perfectly normal.
 *
 * Nothing should be locked while no layer is mounted, so drop a stale lock on
 * the first pointer event. This runs in the capture phase because a
 * `pointer-events: none` body can't be the event target itself — the event still
 * reaches the window, which is the only reason the recovery is possible at all.
 */
const OPEN_LAYER_SELECTOR = '[data-radix-menu-content],[data-radix-popper-content-wrapper],[role="dialog"]';

window.addEventListener(
  'pointerdown',
  () => {
    if (document.body.style.pointerEvents !== 'none') {
      return;
    }
    if (document.querySelector(OPEN_LAYER_SELECTOR)) {
      return;
    }
    document.body.style.pointerEvents = '';
  },
  true,
);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
    <Analytics />
  </StrictMode>,
);