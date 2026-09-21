import { Loader2, type LucideProps } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Spinner({ className, ...props }: { className?: string } & LucideProps) {
  return <Loader2 className={cn('animate-spin', className)} aria-hidden="true" {...props} />;
}

export function SuccessCheck({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center justify-center', className)} aria-hidden="true">
      <svg viewBox="0 0 52 52" className="size-full">
        <circle
          className="circle-stroke"
          cx="26"
          cy="26"
          r="23"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        />
        <path
          className="check-stroke"
          fill="none"
          stroke="currentColor"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15 27l7.5 7.5L37 19"
        />
      </svg>
    </span>
  );
}