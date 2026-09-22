import { useNavigate } from 'react-router-dom';
import { ArrowRight, FileText, ShieldCheck, Trash2 } from 'lucide-react';
import { useHistory } from '../hooks/useHistory';
import { useAnalysis } from '../contexts/AnalysisContext';
import { useFeatureGate } from '../components/PlanUsage';
import { formatRelativeTime, type HistoryEntry } from '../services/historyService';
import { UploadDropzone } from '../components/UploadDropzone';
import { EmptyState } from '../components/EmptyState';
import { ScoreBadge } from '../components/ScoreBadge';
import { PreviewThumb } from '../components/PreviewThumb';
import { Badge } from '../components/ui/badge';
import { CheckpointList } from '../components/CheckpointList';

function ReviewRow({
  entry,
  onOpen,
  onDelete,
}: {
  entry: HistoryEntry;
  onOpen: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
}) {
  const risks = entry.analysis?.risks.length ?? 0;
  const score = entry.analysis?.overallRiskScore ?? null;

  return (
    <tr onClick={() => onOpen(entry)} className="group cursor-pointer transition-colors hover:bg-accent/40">
      <td className="px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {entry.previewPath ? (
            <PreviewThumb path={entry.previewPath} />
          ) : (
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileText className="size-4" aria-hidden="true" />
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{entry.name}</p>
            <p className="text-xs text-muted-foreground">
              {entry.pageCount ? `${entry.pageCount} page${entry.pageCount === 1 ? '' : 's'} · ` : ''}
              {risks} risk{risks === 1 ? '' : 's'}
            </p>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge variant="secondary">Review</Badge>
      </td>
      <td className="px-4 py-3 text-right">
        {score !== null ? (
          <ScoreBadge score={score} />
        ) : (
          <span className="text-sm text-muted-foreground/50">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
        {formatRelativeTime(entry.updatedAt)}
      </td>
      <td className="px-2 py-3 text-right">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(entry.id);
          }}
          aria-label={`Delete ${entry.name}`}
          className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </td>
    </tr>
  );
}

export function AnalyzeHubPage() {
  const navigate = useNavigate();
  const { entries, remove } = useHistory();
  const { beginAnalysis, progress } = useAnalysis();
  const canStartAnalysis = useFeatureGate();

  const analyses = entries
    .filter((entry) => entry.kind === 'analysis')
    .slice(0, 12);

  const busy =
    progress.stage !== 'idle' &&
    progress.stage !== 'complete' &&
    progress.stage !== 'error';

  function handleFileSelected(file: File) {
    if (!canStartAnalysis('analysis')) {
      return;
    }
    void beginAnalysis(file);
    navigate('/analysis');
  }

  function handleOpen(entry: HistoryEntry) {
    navigate(`/analysis?id=${entry.id}`);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:py-8">
      <p className="text-sm font-medium text-muted-foreground">Review documents</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
        Run a contract review
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Upload a PDF and Paqt extracts the text in your browser, then flags the
        clauses that deserve your attention with the exact page and quote behind
        each finding.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 font-medium text-foreground">
          <ShieldCheck className="size-3.5 text-primary" aria-hidden="true" />
          Your contract or PDF is safe
        </span>
        <span aria-hidden="true" className="text-muted-foreground/40">·</span>
        <span>
          Extracted locally in your browser, saved to your private account, never shared.
        </span>
      </div>

      <div className="mt-8">
        <UploadDropzone onFileSelected={handleFileSelected} busy={busy} />
      </div>

      <CheckpointList />

      <section className="mt-12">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">Past reviews</h2>
          <span className="text-xs text-muted-foreground">
            {analyses.length} saved to your account
          </span>
        </div>

        <div className="mt-3">
          {analyses.length === 0 ? (
            <EmptyState
              title="No reviews yet"
              description="Completed analyses are saved to your account with their page text (and the original PDF when within size), so you can reopen the viewer, findings, and chat without re-running the AI."
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Document
                    </th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Type
                    </th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Score
                    </th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Updated
                    </th>
                    <th className="w-12 px-2 py-2.5" aria-hidden="true" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {analyses.map((entry) => (
                    <ReviewRow key={entry.id} entry={entry} onOpen={handleOpen} onDelete={remove} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <div className="mt-8 flex items-start gap-2.5 rounded-xl border border-border bg-card px-4 py-3">
        <ArrowRight className="mt-0.5 size-4 shrink-0 rotate-180 text-muted-foreground/60" aria-hidden="true" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Completed reviews reopen instantly from browser history — no AI re-run needed. Leave a
          review mid-way and it resumes from the last analyzed page.
        </p>
      </div>
    </div>
  );
}