import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from './AuthContext';
import {
  fetchMyUsage,
  NO_USAGE,
  type UsageSnapshot,
} from '../services/entitlementService';

interface EntitlementContextValue {
  usage: UsageSnapshot;
  loading: boolean;
  refresh: () => Promise<void>;
}

const EntitlementContext = createContext<EntitlementContextValue | null>(null);

export function EntitlementProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [usage, setUsage] = useState<UsageSnapshot>(NO_USAGE);
  const [loading, setLoading] = useState(true);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    try {
      const next = await fetchMyUsage();
      setUsage(next);
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [user?.id, refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    const onFocus = () => void refresh();
    window.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const value = useMemo<EntitlementContextValue>(
    () => ({ usage, loading, refresh }),
    [usage, loading, refresh],
  );

  return <EntitlementContext.Provider value={value}>{children}</EntitlementContext.Provider>;
}

export function useEntitlement(): EntitlementContextValue {
  const context = useContext(EntitlementContext);
  if (!context) {
    throw new Error('useEntitlement must be used within an EntitlementProvider');
  }
  return context;
}