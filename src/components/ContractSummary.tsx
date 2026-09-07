import type { ReactNode } from 'react';
import type { ContractAnalysis } from '../types';
import { FileSignature, Landmark, ListChecks, Scale, Star } from 'lucide-react';

interface ContractSummaryProps {
  analysis: ContractAnalysis;
}

function scoreColor(score: number): string {
  if (score >= 70) {
    return '#d92d20';
  }
  if (score >= 45) {
    return '#f79009';
  }
  if (score >= 25) {
    return '#fdb022';
  }
  return '#12b76a';
}

function scoreLabel(score: number): string {
  if (score >= 70) {
    return 'High attention';
  }
  if (score >= 45) {
    return 'Review before signing';
  }
  if (score >= 25) {
    return 'Some concerns';
  }
  return 'Routine review';
}

function ScoreRing({ score }: { score: number }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const filled = (score / 100) * circumference;
  const color = scoreColor(score);

  return (
    <div className="relative inline-flex items-center justify-center" aria-hidden="true">
      <svg width="104" height="104" viewBox="0 0 104 104">
        <circle
          cx="52"
          cy="52"
          r={radius}
          fill="none"
          stroke="#eaecf0"
          strokeWidth="8"
        />
        <circle
          cx="52"
          cy="52"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
          transform="rotate(-90 52 52)"
        />
      </svg>
      <div className="absolute text-center">
        <div className="text-2xl font-bold text-ink-900">{score}</div>
        <div className="text-[10px] font-medium uppercase tracking-wide text-ink-400">
          / 100
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0 rounded-lg bg-ink-100 p-1.5 text-ink-500">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          {title}
        </p>
        <div className="mt-0.5 text-sm text-ink-700">{children}</div>
      </div>
    </div>
  );
}

export function ContractSummary({ analysis }: ContractSummaryProps) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        <ScoreRing score={analysis.overallRiskScore} />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-800">
            {scoreLabel(analysis.overallRiskScore)}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            Decision-support signal based on {analysis.risks.length}{' '}
            identified risk{analysis.risks.length === 1 ? '' : 's'}. Not a legal
            probability.
          </p>
        </div>
      </div>

      <p className="text-sm leading-relaxed text-ink-700">{analysis.summary}</p>

      <div className="flex flex-col gap-4">
        <InfoRow icon={<FileSignature className="size-4" aria-hidden="true" />} title="Contract type">
          {analysis.contractType || 'Unclassified'}
        </InfoRow>

        <InfoRow icon={<Landmark className="size-4" aria-hidden="true" />} title="Parties">
          {analysis.parties.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {analysis.parties.map((party) => (
                <li
                  key={party}
                  className="rounded-md bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600"
                >
                  {party}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-ink-400">Not identified</span>
          )}
        </InfoRow>

        <InfoRow icon={<Scale className="size-4" aria-hidden="true" />} title="Key terms">
          {analysis.keyTerms.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {analysis.keyTerms.map((term) => (
                <li
                  key={term}
                  className="rounded-md bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-700"
                >
                  {term}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-ink-400">None surfaced</span>
          )}
        </InfoRow>
      </div>

      {analysis.recommendations.length > 0 ? (
        <div className="rounded-xl border border-primary-200 bg-primary-50/60 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-primary-800">
            <ListChecks className="size-4" aria-hidden="true" />
            What to do next
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {analysis.recommendations.map((recommendation) => (
              <li key={recommendation} className="flex items-start gap-2 text-sm text-ink-700">
                <Star className="mt-0.5 size-3.5 shrink-0 text-primary-500" aria-hidden="true" />
                <span>{recommendation}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}