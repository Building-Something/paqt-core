import type { ReactNode } from 'react';
import { usePlan } from '../contexts/PlanContext';
import { Paywall, PlanGateLoader } from './Paywall';

export function RequirePlan({ children }: { children: ReactNode }) {
  const { loading, hasAccess } = usePlan();

  if (loading) {
    return <PlanGateLoader />;
  }

  if (!hasAccess) {
    return <Paywall />;
  }

  return <>{children}</>;
}