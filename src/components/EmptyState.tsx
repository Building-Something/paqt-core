import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';

interface EmptyStateProps {
  title: string;
  description?: string;
  children?: ReactNode;
}

export function EmptyState({ title, description, children }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-ink-300 bg-white px-6 py-10 text-center">
      <div className="rounded-full bg-ink-100 p-3 text-ink-400">
        <Inbox className="size-6" aria-hidden="true" />
      </div>
      <p className="text-sm font-semibold text-ink-800">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-ink-500">{description}</p>
      ) : null}
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}