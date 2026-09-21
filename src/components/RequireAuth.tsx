import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Spinner } from './ui/feedback';

export function FullScreenLoader() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <img
          src="/assets/Logo-Variant-Transparent.png"
          alt="Paqt logo"
          className="size-10 object-contain animate-pulse"
        />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading your workspace…
        </div>
      </div>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, initializing } = useAuth();
  const location = useLocation();

  if (initializing) {
    return <FullScreenLoader />;
  }

  if (!session) {
    return (
      <Navigate
        to="/signin"
        state={{ from: location.pathname + location.search }}
        replace
      />
    );
  }

  return <>{children}</>;
}