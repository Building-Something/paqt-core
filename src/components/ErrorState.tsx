import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorStateProps {
  message: string;
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({ message, detail, onRetry, retryLabel = 'Retry' }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-critical-500/40 bg-critical-100/50 px-4 py-4"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-critical-600" aria-hidden="true">
          <AlertTriangle className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-critical-700">{message}</p>
          {detail ? <p className="mt-1 text-sm text-ink-600">{detail}</p> : null}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-critical-600/40 bg-white px-3 py-1.5 text-sm font-medium text-critical-700 transition-colors hover:bg-critical-100/60"
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {retryLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}