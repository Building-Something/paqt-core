import type { ContractRisk } from '../types';
import { formatPageLabel, SEVERITY_META } from '../utils/risks';

interface RiskMarkerProps {
  risk: ContractRisk;
  number: number;
  selected: boolean;
  onSelect: (risk: ContractRisk) => void;
}

export function RiskMarker({ risk, number, selected, onSelect }: RiskMarkerProps) {
  const meta = SEVERITY_META[risk.riskLevel];

  return (
    <div className="group relative" data-testid={`risk-marker-${risk.id}`}>
      <button
        type="button"
        onClick={() => onSelect(risk)}
        aria-label={`Open risk ${number} on page ${risk.pageNumber}: ${risk.category}`}
        aria-pressed={selected}
        className={[
          'relative flex size-6 items-center justify-center rounded-full text-xs font-bold text-white shadow-md transition-transform hover:scale-110',
          meta.chip,
          selected ? 'ring-2 ring-ink-800 ring-offset-1' : '',
        ].join(' ')}
      >
        {selected ? (
          <span className="absolute inset-0 animate-ping-slow rounded-full opacity-40" aria-hidden="true" />
        ) : null}
        <span className="relative">{number}</span>
      </button>

      <div
        className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 hidden w-60 -translate-x-1/2 rounded-lg border border-ink-200 bg-white p-3 text-left shadow-pop group-hover:block"
        role="tooltip"
      >
        <div className="flex items-center justify-between gap-2">
          <span className={`text-xs font-semibold ${meta.text}`}>{meta.label}</span>
          <span className="text-xs text-ink-400">{formatPageLabel(risk.pageNumber)}</span>
        </div>
        <p className="mt-1 text-xs font-semibold text-ink-800">{risk.category}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-600">{risk.description}</p>
        <p className="mt-2 truncate text-xs italic text-ink-400">“{risk.text}”</p>
        <p className="mt-2 text-xs font-medium text-primary-700">Click for details</p>
      </div>
    </div>
  );
}