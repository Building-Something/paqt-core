import { Loader2 } from 'lucide-react';
import type { AnalysisProgress } from '../types';

interface AnalysisProgressProps {
  progress: AnalysisProgress;
  fileName: string;
}

const ICONS_BY_STAGE = {
  idle: null,
  extracting: 'Extracting contract text…',
  preparing: 'Preparing pages…',
  analyzing: null,
  consolidating: 'Consolidating findings…',
  synthesizing: null,
  complete: null,
  error: null,
} as const;

export function AnalysisProgress({ progress, fileName }: AnalysisProgressProps) {
  if (progress.stage === 'idle' || progress.stage === 'complete' || progress.stage === 'error') {
    return null;
  }

  return (
    <div className="card px-5 py-6" role="status" aria-live="polite">
      <div className="flex items-start gap-4">
        <div className="rounded-full bg-primary-100 p-3 text-primary-700">
          <Loader2 className="size-6 animate-spin" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink-800">{progress.label}</p>
          <p className="mt-1 truncate text-xs text-ink-400">{fileName}</p>
          {progress.pageRange ? (
            <p className="mt-1 text-xs font-medium text-primary-700">
              Pages {progress.pageRange.replace('-', '–')}
            </p>
          ) : null}
          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
            <div className="h-full w-2/5 animate-pulse rounded-full bg-primary-500" />
          </div>
          <p className="mt-2 text-xs text-ink-500">
            {ICONS_BY_STAGE[progress.stage] ?? 'Working through the document…'}
          </p>
        </div>
      </div>
    </div>
  );
}