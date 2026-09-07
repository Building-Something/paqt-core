import { useNavigate } from 'react-router-dom';
import { ArrowRight, FileText, Trash2 } from 'lucide-react';
import { useHistory } from '../hooks/useHistory';
import { useAnalysis } from '../contexts/AnalysisContext';
import { formatRelativeTime, type HistoryEntry } from '../services/historyService';
import { UploadDropzone } from '../components/UploadDropzone';
import { EmptyState } from '../components/EmptyState';
import { Disclaimer } from '../components/Disclaimer';
import { ScoreBadge } from '../components/ScoreBadge';

export function AnalyzeHubPage() {
  const navigate = useNavigate();
  const { entries, remove } = useHistory();
  const { beginAnalysis, progress } = useAnalysis();

  const analyses = entries
    .filter((entry) => entry.kind === 'analysis')
    .slice(0, 12);

  const busy =
    progress.stage !== 'idle' &&
    progress.stage !== 'complete' &&
    progress.stage !== 'error';

  function handleFileSelected(file: File) {
    void beginAnalysis(file).then(() => navigate('/analysis'));
  }

  function handleOpen(entry: HistoryEntry) {
    navigate(`/analysis?id=${entry.id}`);
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <p className="text-sm font-medium text-muted-foreground">Analyze</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
        Run a contract review
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Upload a PDF and Paqt extracts the text in your browser, then flags the
        clauses that deserve your attention with the exact page and quote behind
        each finding.
      </p>

      <div className="mt-8">
        <UploadDropzone onFileSelected={handleFileSelected} busy={busy} />
      </div>

      <section className="mt-12">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">Past reviews</h2>
          <span className="text-xs text-muted-foreground">
            {analyses.length} saved in this browser
          </span>
        </div>

        <div className="mt-3">
          {analyses.length === 0 ? (
            <EmptyState
              title="No reviews yet"
              description="Completed analyses will be kept here so you can reopen findings without re-running the AI."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {analyses.map((entry) => {
                const risks = entry.analysis?.risks.length ?? 0;
                const score = entry.analysis?.overallRiskScore ?? null;
                return (
                  <li key={entry.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => handleOpen(entry)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          handleOpen(entry);
                        }
                      }}
                      aria-label={`Open ${entry.name}`}
                      className="group flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-sm transition-colors hover:bg-accent/60"
                    >
                      <div className="rounded-md bg-muted p-2 text-muted-foreground">
                        <FileText className="size-4" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {entry.name}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span>{formatRelativeTime(entry.updatedAt)}</span>
                          {entry.pageCount ? (
                            <span className="text-muted-foreground/70">
                              {entry.pageCount} page{entry.pageCount === 1 ? '' : 's'}
                            </span>
                          ) : null}
                          <span className="text-muted-foreground/70">
                            {risks} risk{risks === 1 ? '' : 's'}
                          </span>
                          {score !== null ? <ScoreBadge score={score} /> : null}
                        </p>
                      </div>
                      <ArrowRight
                        className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary"
                        aria-hidden="true"
                      />
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          remove(entry.id);
                        }}
                        aria-label={`Delete ${entry.name}`}
                        className="shrink-0 rounded-md p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <div className="mt-12 border-t border-border pt-6">
        <Disclaimer />
      </div>
    </div>
  );
}