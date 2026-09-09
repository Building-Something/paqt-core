import type { ContractRisk } from '../types';
import { SEVERITY_META, formatPageLabel } from '../utils/risks';
import {
  FileText,
  GitCompareArrows,
  Quote,
  Lightbulb,
  ChevronRight,
} from 'lucide-react';
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
        'relative cursor-pointer rounded-lg border bg-card p-4 text-left shadow-sm transition-all',
        selected
          ? 'border-primary/60 ring-1 ring-primary/30'
          : 'border-border hover:border-border hover:bg-accent/40',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <SeverityBadge level={risk.riskLevel} />
          <span className="truncate text-sm font-medium text-foreground">
            {risk.category}
          </span>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
          <FileText className="size-3.5" aria-hidden="true" />
          {formatPageLabel(risk.pageNumber)}
        </span>
      </div>

      {risk.relatedPages && risk.relatedPages.length > 1 ? (
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-primary">
          <GitCompareArrows className="size-3.5" aria-hidden="true" />
          Cross-clause: involves{' '}
          {risk.relatedPages.map(formatPageLabel).join(', ')}
        </p>
      ) : null}

      <p className="mt-2 text-sm leading-relaxed text-foreground/80">
        {risk.description}
      </p>

      <blockquote
        className={`mt-3 rounded-md border-l-2 bg-muted/50 p-3 text-xs italic leading-relaxed text-muted-foreground ${meta.border}`}
      >
        <span className="flex items-center gap-1.5 not-italic font-medium text-muted-foreground/80">
          <Quote className="size-3" aria-hidden="true" />
          From the contract
        </span>
        “{risk.text}”
      </blockquote>

      <div className="mt-3 flex items-start gap-2 rounded-md bg-muted/50 p-3 text-xs leading-relaxed text-foreground/90">
        <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
        {risk.recommendation}
      </div>

      <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">
        {selected ? 'Opened in document' : 'View in document'}
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </span>
    </article>
  );
}