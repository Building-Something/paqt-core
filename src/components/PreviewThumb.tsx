import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { getPreviewSignedUrl } from '../services/supabaseHistoryService';
import { cn } from '@/lib/utils';

export function PreviewThumb({ path, className }: { path?: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!path) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    getPreviewSignedUrl(path)
      .then((resolved) => {
        if (!alive) {
          return;
        }
        setUrl(resolved);
        setLoading(false);
        setFailed(!resolved);
      })
      .catch(() => {
        if (alive) {
          setLoading(false);
          setFailed(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [path]);

  if (loading) {
    return (
      <div
        className={cn('shimmer size-8 shrink-0 overflow-hidden rounded-lg bg-muted', className)}
        aria-hidden="true"
      />
    );
  }

  if (failed || !url) {
    return (
      <div
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary',
          className,
        )}
      >
        <FileText className="size-4" aria-hidden="true" />
      </div>
    );
  }

  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn('size-8 shrink-0 rounded-lg border border-border object-cover', className)}
    />
  );
}