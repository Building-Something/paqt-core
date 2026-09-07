import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  FilePenLine,
  FileText,
  Gauge,
  ScanSearch,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useHistory } from '../hooks/useHistory';
import { useAnalysis } from '../contexts/AnalysisContext';
import { formatRelativeTime, type HistoryEntry } from '../services/historyService';
import { EmptyState } from '../components/EmptyState';
import { Disclaimer } from '../components/Disclaimer';
import { ScoreBadge } from '../components/ScoreBadge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Gauge;
  label: string;
  value: number | string;
  hint: string;
}) {
  return (
    <Card className="flex items-start gap-3 p-4">
      <div className="rounded-md bg-muted p-2 text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-2xl font-semibold tabular-nums tracking-tight text-foreground">
          {value}
        </p>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground/70">{hint}</p>
      </div>
    </Card>
  );
}

function ActivityRow({
  entry,
  onOpen,
  onDelete,
}: {
  entry: HistoryEntry;
  onOpen: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
}) {
  const isDraft = entry.kind === 'draft';
  const risks = entry.analysis?.risks.length ?? 0;
  const score = entry.analysis?.overallRiskScore ?? null;

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(entry)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(entry);
          }
        }}
        aria-label={`Open ${entry.name}`}
        className="group flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-sm transition-colors hover:bg-accent/60"
      >
        <div className={`rounded-md p-2 ${isDraft ? 'bg-muted text-primary' : 'bg-muted text-muted-foreground'}`}>
          {isDraft ? (
            <FilePenLine className="size-4" aria-hidden="true" />
          ) : (
            <FileText className="size-4" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{entry.name}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{formatRelativeTime(entry.updatedAt)}</span>
            {!isDraft && risks > 0 ? (
              <span className="text-muted-foreground/70">
                {risks} risk{risks === 1 ? '' : 's'}
              </span>
            ) : null}
            {!isDraft && score !== null ? (
              <ScoreBadge score={score} />
            ) : isDraft && entry.sectionCount ? (
              <span className="text-muted-foreground/70">
                {entry.sectionCount} section{entry.sectionCount === 1 ? '' : 's'}
              </span>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(entry.id);
          }}
          aria-label={`Delete ${entry.name}`}
          className="shrink-0 rounded-md p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { entries, remove, clearAll } = useHistory();
  const { fileName, record, progress } = useAnalysis();

  const analyses = entries.filter((entry) => entry.kind === 'analysis');
  const drafts = entries.filter((entry) => entry.kind === 'draft');
  const riskTotal = analyses.reduce(
    (sum, entry) => sum + (entry.analysis?.risks.length ?? 0),
    0,
  );
  const highRisk = analyses.reduce(
    (sum, entry) =>
      sum +
      (entry.analysis?.risks.filter(
        (risk) => risk.riskLevel === 'critical' || risk.riskLevel === 'high',
      ).length ?? 0),
    0,
  );
  const scores = analyses
    .map((entry) => entry.analysis?.overallRiskScore ?? 0)
    .filter((score) => score > 0);
  const avgScore =
    scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  const busy =
    progress.stage !== 'idle' &&
    progress.stage !== 'complete' &&
    progress.stage !== 'error';

  function handleOpen(entry: HistoryEntry) {
    if (entry.kind === 'draft') {
      navigate(`/generate?draft=${entry.id}`);
      return;
    }
    navigate(`/analysis?id=${entry.id}`);
  }

  const recent = entries.slice(0, 8);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Contract workspace</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            Review, draft, decide.
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Analyze incoming contracts for risks, or compose agreements from a
            plain-English brief — then send them through the same review
            pipeline.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link to="/generate">
              <FilePenLine className="size-4" aria-hidden="true" />
              Compose
            </Link>
          </Button>
          <Button asChild>
            <Link to="/analyze">
              <ScanSearch className="size-4" aria-hidden="true" />
              Analyze
            </Link>
          </Button>
        </div>
      </div>

      {fileName || record ? (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="rounded-md bg-muted p-2 text-primary">
              <ScanSearch className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {record?.name ?? fileName}
              </p>
              <p className="text-xs text-muted-foreground">
                {busy ? 'Analysis in progress…' : 'Analysis session ready to review'}
              </p>
            </div>
          </div>
          <Button asChild className="ml-auto">
            <Link to="/analysis">
              Open workspace
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      ) : null}

      <section className="mt-8 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-5">
        <StatCard icon={FileText} label="Contracts analyzed" value={analyses.length} hint="Completed reviews" />
        <StatCard icon={Activity} label="Risks flagged" value={riskTotal} hint="Across all reviews" />
        <StatCard icon={ShieldAlert} label="Critical / high" value={highRisk} hint="Needs attention" />
        <StatCard icon={FilePenLine} label="Drafts composed" value={drafts.length} hint="Agreements drafted" />
        <StatCard
          icon={Gauge}
          label="Avg. risk score"
          value={avgScore ?? '—'}
          hint="Higher means riskier"
        />
      </section>

      <div className="mt-10 grid gap-6 lg:grid-cols-[1fr_1.6fr]">
        <section>
          <h2 className="text-sm font-semibold text-foreground">Start something</h2>
          <div className="mt-3 flex flex-col gap-3">
            <Card className="p-5">
              <div className="flex items-start gap-3">
                <div className="rounded-md bg-muted p-2 text-primary">
                  <ScanSearch className="size-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">Analyze a contract</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    Upload a PDF and Paqt flags the clauses worth your attention,
                    with the exact page and quote behind each finding.
                  </p>
                  <Button asChild className="mt-4">
                    <Link to="/analyze">
                      Upload a PDF
                      <ArrowRight className="size-4" aria-hidden="true" />
                    </Link>
                  </Button>
                </div>
              </div>
            </Card>

            <Card className="p-5">
              <div className="flex items-start gap-3">
                <div className="rounded-md bg-muted p-2 text-primary">
                  <FilePenLine className="size-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">Compose a contract</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    Describe the deal in plain English. Paqt asks clarifying
                    questions, drafts the agreement, and rewrites it from your
                    feedback — then analyzes it for risks.
                  </p>
                  <Button asChild className="mt-4">
                    <Link to="/generate">
                      Start drafting
                      <ArrowRight className="size-4" aria-hidden="true" />
                    </Link>
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">Recent activity</h2>
            {entries.length > 0 ? (
              <button
                type="button"
                onClick={clearAll}
                className="text-xs font-medium text-muted-foreground transition-colors hover:text-destructive"
              >
                Clear history
              </button>
            ) : null}
          </div>

          <div className="mt-3">
            {recent.length === 0 ? (
              <EmptyState
                title="Nothing here yet"
                description="Analyses you run and contracts you compose will appear here for quick reopening, stored only in your browser."
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {recent.map((entry) => (
                  <ActivityRow
                    key={entry.id}
                    entry={entry}
                    onOpen={handleOpen}
                    onDelete={remove}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      <div className="mt-12 border-t border-border pt-6">
        <Disclaimer />
      </div>
    </div>
  );
}