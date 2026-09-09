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

  const { from, to, total, risks } = progress;
  const isSinglePage = from !== undefined && to !== undefined && from === to;
  const percent =
    total && to ? Math.max(4, Math.min(100, Math.round((to / total) * 100))) : 40;

  return (
    <div className="card px-5 py-6" role="status" aria-live="polite">
      <div className="flex items-start gap-4">
        <div className="rounded-full bg-muted p-3 text-primary">
          <Loader2 className="size-6 animate-spin" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{progress.label}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{fileName}</p>
          {from !== undefined && to !== undefined && total ? (
            <p className="mt-1 text-xs font-medium text-primary">
              {isSinglePage
                ? `Page ${from} of ${total}`
                : `Pages ${from}–${to} of ${total}`}
            </p>
          ) : progress.pageRange ? (
            <p className="mt-1 text-xs font-medium text-primary">
              Pages {progress.pageRange.replace('-', '–')}
            </p>
          ) : null}
          {risks && risks.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {risks.length} finding{risks.length === 1 ? '' : 's'} identified so far
            </p>
          ) : null}
          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full animate-pulse rounded-full bg-primary transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {ICONS_BY_STAGE[progress.stage] ?? 'Working through the document…'}
          </p>
        </div>
      </div>
    </div>
  );
}