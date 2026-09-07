import { useEffect, useState } from 'react';

interface HealthState {
  status: 'checking' | 'ok' | 'missing' | 'offline';
}

export function useServerHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ status: 'checking' });

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        const payload = (await response.json()) as { configured?: boolean };
        if (cancelled) {
          return;
        }
        setState({
          status: payload.configured ? 'ok' : 'missing',
        });
      } catch {
        if (cancelled) {
          return;
        }
        setState({ status: 'offline' });
      }
    }

    void check();
    const interval = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return state;
}