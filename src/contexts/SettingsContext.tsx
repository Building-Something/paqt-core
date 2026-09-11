import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  setReasoningEffort as applyReasoningEffort,
  type ReasoningEffort,
} from '../services/groqService';

const STORAGE_KEY = 'paqt.reasoningEffort';

function readStoredEffort(): ReasoningEffort {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'low' || stored === 'medium' || stored === 'high') {
      return stored;
    }
  } catch {
    return 'medium';
  }
  return 'medium';
}

interface SettingsContextValue {
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (effort: ReasoningEffort) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [reasoningEffort, setState] = useState<ReasoningEffort>(readStoredEffort);

  useEffect(() => {
    applyReasoningEffort(reasoningEffort);
  }, [reasoningEffort]);

  function setReasoningEffort(effort: ReasoningEffort) {
    try {
      localStorage.setItem(STORAGE_KEY, effort);
    } catch {
      setState(effort);
      return;
    }
    setState(effort);
  }

  return (
    <SettingsContext.Provider value={{ reasoningEffort, setReasoningEffort }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings must be used within SettingsProvider');
  }
  return ctx;
}