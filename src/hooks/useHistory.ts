import { useCallback, useEffect, useState } from 'react';
import {
  clearHistory,
  deleteHistoryEntry,
  loadHistory,
  subscribeHistory,
  type HistoryEntry,
} from '../services/historyService';

export function useHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => loadHistory());

  useEffect(() => subscribeHistory(() => setEntries(loadHistory())), []);

  const remove = useCallback((id: string) => {
    deleteHistoryEntry(id);
  }, []);

  const clearAll = useCallback(() => {
    clearHistory();
  }, []);

  return { entries, remove, clearAll };
}