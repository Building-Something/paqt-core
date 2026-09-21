import { Loader2 } from 'lucide-react';
import type { AnalysisProgress, ProgressStage } from '../types';
import { cn } from '@/lib/utils';
import { Spinner, SuccessCheck } from './ui/feedback';

interface AnalysisProgressProps {
  progress: AnalysisProgress;
  fileName: string;
}

const STEPS: Array<{ stage: ProgressStage[]; label: string; hint: string }> = [
  { stage: ['preparing'], label: 'Preparing', hint: 'Loading pages…' },
  { stage: ['extracting'], label: 'Extracting', hint: 'Reading text with pdf.js…' },
  { stage: ['analyzing'], label: 'Analyzing', hint: 'Sending pages to the model…' },
  { stage: ['consolidating'], label: 'Consolidating', hint: 'Merging findings…' },
  { stage: ['synthesizing'], label: 'Synthesizing', hint: 'Writing the decision brief…' },
];

function activeStepIndex(stage: ProgressStage): number {
  return Math.max(
    0,
    STEPS.findIndex((step) => step.stage.includes(stage)),
  );
}

function StepDot({ index, activeIndex }: { index: number; activeIndex: number }) {
  if (index < activeIndex) {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center text-low-600 dark:text-low-500">
        <SuccessCheck className="size-5" />
      </span>
    );
  }
  if (index === activeIndex) {
    return <Spinner className="size-4 shrink-0 text-primary" />;
  }
  return (
    <span
      className="size-1.5 shrink-0 rounded-full bg-muted-foreground/30"
      aria-hidden="true"
    />
  );
}

export function AnalysisProgress({ progress, fileName }: AnalysisProgressProps) {
  if (progress.stage === 'idle' || progress.stage === 'complete' || progress.stage === 'error') {
    return null;
  }

  const { from, to, total, risks } = progress;
  const isSinglePage = from !== undefined && to !== undefined && from === to;
  const percent =
    total && to ? Math.max(4, Math.min(100, Math.round((to / total) * 100))) : 40;
  const activeIndex = activeStepIndex(progress.stage);

  return (
    <div className="card animate-fade-in-up px-5 py-6" role="status" aria-live="polite">
      <div className="flex items-start gap-4">
        <div className="rounded-full bg-muted p-3 text-primary">
          <Loader2 className="size-6 animate-spin" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{progress.label}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{fileName}</p>
          {from !== undefined && to !== undefined && total ? (
            <p className="mt-1 text-xs font-medium text-primary">
              {isSinglePage ? `Page ${from} of ${total}` : `Pages ${from}–${to} of ${total}`}
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

          <ol className="mt-4 flex flex-col gap-2">
            {STEPS.map((step, index) => (
              <li
                key={step.label}
                className={cn(
                  'flex items-center gap-2.5 text-sm transition-colors',
                  index === activeIndex
                    ? 'font-medium text-foreground'
                    : index < activeIndex
                      ? 'text-muted-foreground'
                      : 'text-muted-foreground/50',
                )}
              >
                <span className="flex w-5 items-center justify-center">
                  <StepDot index={index} activeIndex={activeIndex} />
                </span>
                <span>{step.label}</span>
                {index === activeIndex ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {STEPS[index].hint}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>

          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="progress-stripes h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {percent}% of pages reviewed
          </p>
        </div>
      </div>
    </div>
  );
}