import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';
import {
  fetchMySubscription,
  fetchPlans,
  hasActivePlan,
  type PaqtPlan,
  type PaqtSubscription,
} from '../services/billingService';

interface PlanContextValue {
  subscription: PaqtSubscription | null;
  plans: PaqtPlan[];
  loading: boolean;
  hasAccess: boolean;
  refresh: () => Promise<void>;
}

const PlanContext = createContext<PlanContextValue | null>(null);

export function PlanProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const [subscription, setSubscription] = useState<PaqtSubscription | null>(null);
  const [plans, setPlans] = useState<PaqtPlan[]>([]);
  const [loading, setLoading] = useState(true);

  // The database is the only source of truth for billing: every refresh is a
  // fresh read (no localStorage/context cache), so any login anywhere reflects
  // the true plan state immediately.
  const refresh = useCallback(async () => {
    if (!supabase || !userId) {
      setSubscription(null);
      setPlans([]);
      setLoading(false);
      return;
    }
    try {
      const [plansNext, subNext] = await Promise.all([
        fetchPlans(supabase),
        fetchMySubscription(supabase, userId),
      ]);
      setPlans(plansNext);
      setSubscription(subNext);
    } catch (error) {
      console.warn('[plan] refresh failed:', error);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Re-read when the tab regains focus/visibility so a completed Razorpay
  // checkout or a renewed cycle appears without a manual reload.
  useEffect(() => {
    if (!supabase || !userId) {
      return;
    }
    const handler = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    window.addEventListener('focus', handler);
    document.addEventListener('visibilitychange', handler);
    return () => {
      window.removeEventListener('focus', handler);
      document.removeEventListener('visibilitychange', handler);
    };
  }, [refresh, userId]);

  const hasAccess = hasActivePlan(subscription);

  const value = useMemo(
    () => ({ subscription, plans, loading, hasAccess, refresh }),
    [subscription, plans, loading, hasAccess, refresh],
  );

  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export function usePlan(): PlanContextValue {
  const context = useContext(PlanContext);
  if (!context) {
    throw new Error('usePlan must be used within a PlanProvider');
  }
  return context;
}