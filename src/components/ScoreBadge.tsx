function scoreChip(score: number): string {
  if (score >= 70) {
    return 'bg-critical-100 text-critical-700 dark:bg-critical-500/15 dark:text-critical-500';
  }
  if (score >= 45) {
    return 'bg-high-100 text-high-700 dark:bg-high-500/15 dark:text-high-500';
  }
  if (score >= 25) {
    return 'bg-medium-100 text-medium-700 dark:bg-medium-500/15 dark:text-medium-500';
  }
  return 'bg-low-100 text-low-700 dark:bg-low-500/15 dark:text-low-500';
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