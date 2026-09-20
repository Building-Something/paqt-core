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
import type { RiskLevel } from '../types';
import { EmptyState } from '../components/EmptyState';
import { ReasoningEffortMenu } from '../components/ReasoningEffortMenu';
import { ScoreBadge } from '../components/ScoreBadge';
import { CheckpointList } from '../components/CheckpointList';
import { PreviewThumb } from '../components/PreviewThumb';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: typeof Gauge;
  label: string;
  value: number | string;
  hint: string;
  tone: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/30">
      <div className={`flex size-9 items-center justify-center rounded-lg ${tone}`}>
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <p className="mt-3 truncate text-2xl font-semibold tabular-nums tracking-tight text-foreground">
        {value}
      </p>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground/60">{hint}</p>
    </div>
  );
}

const SEVERITY_LEVELS: Array<{ key: RiskLevel; label: string; bar: string }> = [
  { key: 'critical', label: 'Critical', bar: 'bg-critical-500' },
  { key: 'high', label: 'High', bar: 'bg-high-500' },
  { key: 'medium', label: 'Medium', bar: 'bg-medium-500' },
  { key: 'low', label: 'Low', bar: 'bg-low-500' },
];

function SeverityCard({ analyses }: { analyses: HistoryEntry[] }) {
  const counts: Record<RiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const entry of analyses) {
    for (const risk of entry.analysis?.risks ?? []) {
      counts[risk.riskLevel] += 1;
    }
  }
  const total = SEVERITY_LEVELS.reduce((sum, level) => sum + counts[level.key], 0);

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Risk distribution</h2>
        <span className="text-xs text-muted-foreground">
          {total} finding{total === 1 ? '' : 's'}
        </span>
      </div>

      <div className="mt-4 flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {SEVERITY_LEVELS.map((level) => {
          const pct = total > 0 ? (counts[level.key] / total) * 100 : 0;
          return pct > 0 ? (
            <div key={level.key} className={level.bar} style={{ width: `${pct}%` }} />
          ) : null;
        })}
      </div>

      <ul className="mt-4 flex flex-col gap-2.5">
        {SEVERITY_LEVELS.map((level) => (
          <li key={level.key} className="flex items-center gap-2.5">
            <span className={`size-2 rounded-full ${level.bar}`} aria-hidden="true" />
            <span className="text-xs font-medium text-muted-foreground">{level.label}</span>
            <span className="ml-auto text-sm font-semibold tabular-nums text-foreground">
              {counts[level.key]}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function QuickActions() {
  return (
    <section>
      <h2 className="text-sm font-semibold text-foreground">Start something</h2>
      <div className="mt-3 flex flex-col gap-3">
        <Card className="p-5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold tracking-[0.2em] text-primary">01</span>
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ScanSearch className="size-4" aria-hidden="true" />
            </div>
          </div>
          <p className="mt-3 text-sm font-semibold text-foreground">Review a contract</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Upload a PDF and Paqt flags the clauses worth your attention, with the exact page and
            quote behind each finding.
          </p>
          <Button asChild className="mt-4">
            <Link to="/analyze">
              Upload a PDF
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold tracking-[0.2em] text-primary">02</span>
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FilePenLine className="size-4" aria-hidden="true" />
            </div>
          </div>
          <p className="mt-3 text-sm font-semibold text-foreground">Compose an agreement</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Describe the deal in plain English. Paqt asks clarifying questions, drafts the
            agreement, and rewrites it from your feedback — then analyzes it for risks.
          </p>
          <Button asChild className="mt-4">
            <Link to="/generate">
              Start drafting
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        </Card>

        <div className="rounded-xl border border-primary/15 bg-primary/5 px-4 py-3">
          <p className="text-xs leading-relaxed text-primary/90">
            Your reviews sync to your account. History stores compact summaries and small page
            previews, never the raw PDF — so reopening results stays instant and storage stays
            lean across thousands of contracts.
          </p>
        </div>
      </div>
    </section>
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
    <tr onClick={() => onOpen(entry)} className="group cursor-pointer transition-colors hover:bg-accent/40">
      <td className="px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {!isDraft && entry.previewPath ? (
            <PreviewThumb path={entry.previewPath} />
          ) : (
            <div
              className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                isDraft ? 'bg-high-100 text-high-700 dark:bg-high-500/15 dark:text-high-500' : 'bg-primary/10 text-primary'
              }`}
            >
              {isDraft ? (
                <FilePenLine className="size-4" aria-hidden="true" />
              ) : (
                <FileText className="size-4" aria-hidden="true" />
              )}
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{entry.name}</p>
            <p className="text-xs text-muted-foreground">
              {isDraft
                ? entry.sectionCount
                  ? `${entry.sectionCount} sections`
                  : 'Agreement draft'
                : entry.pageCount
                  ? `${entry.pageCount} pages · ${risks} risk${risks === 1 ? '' : 's'}`
                  : `${risks} risk${risks === 1 ? '' : 's'}`}
            </p>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge variant={isDraft ? 'outline' : 'secondary'}>{isDraft ? 'Draft' : 'Review'}</Badge>
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

function ActivityTable({
  entries,
  onOpen,
  onDelete,
}: {
  entries: HistoryEntry[];
  onOpen: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <EmptyState
        title="Nothing here yet"
        description="Analyses you run and contracts you compose will appear here for quick reopening, synced to your account."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Item
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
          {entries.map((entry) => (
            <ActivityRow key={entry.id} entry={entry} onOpen={onOpen} onDelete={onDelete} />
          ))}
        </tbody>
      </table>
    </div>
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

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  function handleOpen(entry: HistoryEntry) {
    if (entry.kind === 'draft') {
      navigate(`/generate?draft=${entry.id}`);
      return;
    }
    navigate(`/analysis?id=${entry.id}`);
  }

  const recent = entries.slice(0, 8);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{today}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            Deal room
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Analyze incoming contracts for risks, or compose agreements from a
            plain-English brief — then send them through the same review
            pipeline.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ReasoningEffortMenu />
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
            <div className="rounded-md bg-primary/10 p-2 text-primary">
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

      <CheckpointList />

      <section className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-5">
        <StatCard
          icon={FileText}
          label="Contracts reviewed"
          value={analyses.length}
          hint="Completed reviews"
          tone="bg-primary/10 text-primary"
        />
        <StatCard
          icon={Activity}
          label="Risks flagged"
          value={riskTotal}
          hint="Across all reviews"
          tone="bg-medium-100 text-medium-700 dark:bg-medium-500/15 dark:text-medium-500"
        />
        <StatCard
          icon={ShieldAlert}
          label="Critical / high"
          value={highRisk}
          hint="Needs attention"
          tone="bg-critical-100 text-critical-700 dark:bg-critical-500/15 dark:text-critical-500"
        />
        <StatCard
          icon={FilePenLine}
          label="Drafts composed"
          value={drafts.length}
          hint="Agreements drafted"
          tone="bg-high-100 text-high-700 dark:bg-high-500/15 dark:text-high-500"
        />
        <StatCard
          icon={Gauge}
          label="Avg. risk score"
          value={avgScore ?? '—'}
          hint="Higher means riskier"
          tone="bg-low-100 text-low-600 dark:bg-low-500/15 dark:text-low-500"
        />
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
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
            <ActivityTable entries={recent} onOpen={handleOpen} onDelete={remove} />
          </div>
        </section>

        <div className="flex flex-col gap-6">
          <SeverityCard analyses={analyses} />
          <QuickActions />
        </div>
      </div>
    </div>
  );
}