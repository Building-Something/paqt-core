import type { ContractRisk } from '../types';
import { SEVERITY_META, formatPageLabel } from '../utils/risks';
import { FileText, Quote, Lightbulb, ChevronRight } from 'lucide-react';
import { SeverityBadge } from './SeverityBadge';

interface RiskCardProps {
  risk: ContractRisk;
  selected: boolean;
  onSelect: (risk: ContractRisk) => void;
}

export function RiskCard({ risk, selected, onSelect }: RiskCardProps) {
  const meta = SEVERITY_META[risk.riskLevel];

  return (
    <article
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(risk)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(risk);
        }
      }}
      className={[
        'relative cursor-pointer rounded-xl border bg-white p-4 text-left transition-all',
        selected
          ? `border-primary-500 ring-2 ring-primary-500/20 shadow-pop`
          : 'border-ink-200 shadow-card hover:border-ink-300 hover:shadow-pop',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <SeverityBadge level={risk.riskLevel} />
          <span className="truncate text-sm font-semibold text-ink-800">
            {risk.category}
          </span>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-ink-500">
          <FileText className="size-3.5" aria-hidden="true" />
          {formatPageLabel(risk.pageNumber)}
        </span>
      </div>

      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        {risk.description}
      </p>

      <blockquote
        className={`mt-3 rounded-lg border-l-2 bg-ink-50 p-3 text-xs italic leading-relaxed text-ink-600 ${meta.border}`}
      >
        <span className="flex items-center gap-1.5 not-italic font-medium text-ink-400">
          <Quote className="size-3" aria-hidden="true" />
          From the contract
        </span>
        “{risk.text}”
      </blockquote>

      <div className="mt-3 flex items-start gap-2 rounded-lg bg-primary-50/70 p-3 text-xs leading-relaxed text-ink-700">
        <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-primary-600" aria-hidden="true" />
        {risk.recommendation}
      </div>

      <span
        className={[
          'mt-3 inline-flex items-center gap-1 text-xs font-semibold',
          selected ? 'text-primary-700' : 'text-primary-600',
        ].join(' ')}
      >
        {selected ? 'Opened in document' : 'View in document'}
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </span>
    </article>
  );
}