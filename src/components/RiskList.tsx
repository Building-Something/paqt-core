import { useMemo, useState } from 'react';
import type { ContractRisk, RiskLevel } from '../types';
import { EmptyState } from './EmptyState';
import { RiskCard } from './RiskCard';

interface RiskListProps {
  risks: ContractRisk[];
  selectedRiskId: string | null;
  onSelectRisk: (risk: ContractRisk) => void;
}

const FILTERS: { value: RiskLevel | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

export function RiskList({ risks, selectedRiskId, onSelectRisk }: RiskListProps) {
  const [filter, setFilter] = useState<RiskLevel | 'all'>('all');

  const filtered = useMemo(
    () => (filter === 'all' ? risks : risks.filter((risk) => risk.riskLevel === filter)),
    [risks, filter],
  );

  const counts = useMemo(
    () =>
      risks.reduce<Record<RiskLevel | 'all', number>>(
        (acc, risk) => {
          acc[risk.riskLevel] += 1;
          acc.all += 1;
          return acc;
        },
        { critical: 0, high: 0, medium: 0, low: 0, all: 0 },
      ),
    [risks],
  );

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex flex-wrap gap-1"
        role="group"
        aria-label="Filter risks by severity"
      >
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter(option.value)}
            aria-pressed={filter === option.value}
            className={[
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              filter === option.value
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            ].join(' ')}
          >
            {option.label}
            <span className="ml-1 tabular-nums opacity-70">{counts[option.value]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={risks.length === 0 ? 'No risks identified' : 'Nothing in this filter'}
          description="Paqt only reports findings it can tie back to the extracted text."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {filtered.map((risk) => (
            <li key={risk.id}>
              <RiskCard
                risk={risk}
                selected={selectedRiskId === risk.id}
                onSelect={onSelectRisk}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}