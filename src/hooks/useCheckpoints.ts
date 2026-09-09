import { useCallback, useEffect, useState } from 'react';
import {
  loadCheckpoints,
  removeCheckpoint,
  subscribeCheckpoints,
  type ResumeCheckpoint,
} from '../services/checkpointService';

export function useCheckpoints() {
  const [checkpoints, setCheckpoints] = useState<ResumeCheckpoint[]>(() =>
    loadCheckpoints(),
  );

  useEffect(
    () => subscribeCheckpoints(() => setCheckpoints(loadCheckpoints())),
    [],
  );

  const discard = useCallback((id: string) => {
    removeCheckpoint(id);
  }, []);

  return { checkpoints, discard };
}