import { Component, type ErrorInfo, type ReactNode } from 'react';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
  info: ErrorInfo | null;
}

const LAST_ERROR_KEY = 'paqt.lastError';

export function persistLastError(error: Error, info: ErrorInfo | null): void {
  try {
    const payload = {
      message: error.message,
      stack: error.stack ?? null,
      componentStack: info?.componentStack ?? null,
      time: Date.now(),
      href: window.location.href,
    };
    sessionStorage.setItem(LAST_ERROR_KEY, JSON.stringify(payload));
  } catch {
    // Session storage may be unavailable; the boundary UI still shows the error.
  }
}

export function readLastError(): Record<string, unknown> | null {
  try {
    const raw = sessionStorage.getItem(LAST_ERROR_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    persistLastError(error, info);
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleCopy = async (): Promise<void> => {
    const { error, info } = this.state;
    const text = [
      `Message: ${error?.message ?? 'unknown'}`,
      error?.stack ?? '',
      info?.componentStack ?? '',
    ].join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard may be unavailable; the text is also shown on screen.
    }
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    const stackLines = (error.stack ?? '').split('\n').slice(0, 8);
    return (
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col items-start justify-center gap-4 px-6 py-12">
        <div className="w-full rounded-xl border border-destructive/30 bg-destructive/5 p-6">
          <p className="text-sm font-semibold text-destructive">Something went wrong</p>
          <p className="mt-1 text-sm text-foreground">{error.message || 'An unexpected error occurred.'}</p>
          {stackLines.length > 0 ? (
            <pre className="mt-4 overflow-x-auto rounded-lg bg-background p-3 text-xs leading-relaxed text-muted-foreground">
              {stackLines.join('\n')}
            </pre>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Reload Paqt
            </button>
            <button
              type="button"
              onClick={this.handleCopy}
              className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Copy error
            </button>
          </div>
        </div>
      </div>
    );
  }
}