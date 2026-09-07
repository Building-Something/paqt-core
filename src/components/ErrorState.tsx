import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';

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
      className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-4"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-destructive" aria-hidden="true">
          <AlertTriangle className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{message}</p>
          {detail ? <p className="mt-1 text-sm text-muted-foreground">{detail}</p> : null}
          {onRetry ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onRetry}
              className="mt-3 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {retryLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}