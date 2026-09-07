import type { RiskLevel } from '../types';
import { SEVERITY_META } from '../utils/risks';

interface SeverityBadgeProps {
  level: RiskLevel;
  showLabel?: boolean;
  className?: string;
}

export function SeverityBadge({ level, showLabel = true, className = '' }: SeverityBadgeProps) {
  const meta = SEVERITY_META[level];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${meta.bg} ${meta.text} ${className}`}
    >
      <span className="inline-flex" aria-hidden="true">
        <span
          className={`size-2 rounded-full ${meta.text.replace('text-', 'bg-')}`}
        />
      </span>
      {showLabel ? meta.label : null}
    </span>
  );
}