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
    <div className="card flex items-start gap-3 p-4">
      <div className="rounded-lg bg-primary-50 p-2 text-primary-700">
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-2xl font-bold tabular-nums text-ink-900">{value}</p>
        <p className="text-xs font-medium text-ink-500">{label}</p>
        <p className="mt-0.5 text-[11px] text-ink-400">{hint}</p>
      </div>
    </div>
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
        className="group flex cursor-pointer items-center gap-3 rounded-xl border border-ink-200 bg-white px-4 py-3 transition-colors hover:border-primary-300 hover:bg-primary-50/40"
      >
        <div
          className={`rounded-lg p-2 ${
            isDraft ? 'bg-primary-100 text-primary-700' : 'bg-ink-100 text-ink-500'
          }`}
        >
          {isDraft ? (
            <FilePenLine className="size-4" aria-hidden="true" />
          ) : (
            <FileText className="size-4" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink-900">{entry.name}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
            <span>{formatRelativeTime(entry.updatedAt)}</span>
            {!isDraft && risks > 0 ? (
              <span className="text-ink-400">
                {risks} risk{risks === 1 ? '' : 's'}
              </span>
            ) : null}
            {!isDraft && score !== null ? (
              <ScoreBadge score={score} />
            ) : isDraft && entry.sectionCount ? (
              <span className="text-ink-400">
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
          className="shrink-0 rounded-lg p-2 text-ink-400 transition-colors hover:bg-critical-100 hover:text-critical-700"
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
          <p className="text-sm font-medium text-primary-700">
            Contract workspace
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink-900">
            Review, draft, decide.
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-600">
            Analyze incoming contracts for risks, or compose agreements from a
            plain-English brief — then send them through the same review
            pipeline.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/generate" className="btn-secondary">
            <FilePenLine className="size-4" aria-hidden="true" />
            Compose
          </Link>
          <Link to="/analyze" className="btn-primary">
            <ScanSearch className="size-4" aria-hidden="true" />
            Analyze
          </Link>
        </div>
      </div>

      {fileName || record ? (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-primary-200 bg-primary-50/70 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="rounded-lg bg-primary-100 p-2 text-primary-700">
              <ScanSearch className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink-900">
                {record?.name ?? fileName}
              </p>
              <p className="text-xs text-ink-500">
                {busy ? 'Analysis in progress…' : 'Analysis session ready to review'}
              </p>
            </div>
          </div>
          <Link to="/analysis" className="btn-primary ml-auto">
            Open workspace
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
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
          <h2 className="text-base font-semibold text-ink-900">Start something</h2>
          <div className="mt-4 flex flex-col gap-4">
            <div className="card flex flex-col gap-4 p-5">
              <div className="rounded-xl border border-ink-100 bg-ink-50/60 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                  <ScanSearch className="size-4 text-primary-700" aria-hidden="true" />
                  Analyze a contract
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
                  Upload a PDF and Paqt flags the clauses worth your attention,
                  with the exact page and quote behind each finding.
                </p>
                <Link to="/analyze" className="btn-primary mt-4">
                  Upload a PDF
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </div>
            </div>

            <div className="card flex flex-col gap-4 p-5">
              <div className="rounded-xl border border-primary-200 bg-primary-50/60 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                  <FilePenLine className="size-4 text-primary-700" aria-hidden="true" />
                  Compose a contract
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
                  Describe the deal in plain English. Paqt asks clarifying
                  questions, drafts the agreement, and rewrites it from your
                  feedback — then analyzes it for risks.
                </p>
                <Link to="/generate" className="btn-primary mt-4">
                  Start drafting
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-ink-900">Recent activity</h2>
            {entries.length > 0 ? (
              <button
                type="button"
                onClick={clearAll}
                className="text-xs font-medium text-ink-400 transition-colors hover:text-critical-700"
              >
                Clear history
              </button>
            ) : null}
          </div>

          <div className="mt-4">
            {recent.length === 0 ? (
              <EmptyState
                title="Nothing here yet"
                description="Analyses you run and contracts you compose will appear here for quick reopening, stored only in your browser."
              />
            ) : (
              <ul className="flex flex-col gap-3">
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

      <div className="mt-12 border-t border-ink-200 pt-6">
        <Disclaimer />
      </div>
    </div>
  );
}