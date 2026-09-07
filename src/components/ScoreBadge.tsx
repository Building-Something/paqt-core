function scoreChip(score: number): string {
  if (score >= 70) {
    return 'bg-critical-100 text-critical-700';
  }
  if (score >= 45) {
    return 'bg-high-100 text-high-700';
  }
  if (score >= 25) {
    return 'bg-medium-100 text-medium-700';
  }
  return 'bg-low-100 text-low-700';
}

export function ScoreBadge({ score }: { score: number }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${scoreChip(score)}`}
    >
      {score}/100
    </span>
  );
}