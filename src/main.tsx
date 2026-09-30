import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
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
  console.error('[paqt][runtime]', detail);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const detail =
    reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
  recordRuntimeError('rejection', detail);
  console.error('[paqt][runtime]', detail);
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);