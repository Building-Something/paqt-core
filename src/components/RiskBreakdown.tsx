import type { ContractRisk, RiskLevel } from '../types';
import { SEVERITY_META } from '../utils/risks';

interface RiskBreakdownProps {
  risks: ContractRisk[];
}

const ORDER: RiskLevel[] = ['critical', 'high', 'medium', 'low'];

export function RiskBreakdown({ risks }: RiskBreakdownProps) {
  const counts = ORDER.reduce<Record<RiskLevel, number>>(
    (acc, level) => {
      acc[level] = risks.filter((risk) => risk.riskLevel === level).length;
      return acc;
    },
    { critical: 0, high: 0, medium: 0, low: 0 },
  );

  const total = Math.max(1, risks.length);

  return (
    <div className="flex flex-col gap-2">
      {ORDER.map((level) => {
        const count = counts[level];
        const meta = SEVERITY_META[level];
        if (count === 0) {
          return null;
        }
        return (
          <div key={level} className="flex items-center gap-3">
            <span className={`w-16 text-xs font-semibold ${meta.text}`}>
              {meta.label}
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
              <div
                className={`h-full rounded-full ${meta.chip}`}
                style={{ width: `${(count / total) * 100}%` }}
              />
            </div>
            <span className="w-6 text-right text-xs font-medium tabular-nums text-ink-500">
              {count}
            </span>
          </div>
        );
      })}
      {risks.length === 0 ? (
        <p className="text-xs text-ink-400">No risks identified.</p>
      ) : null}
    </div>
  );
}