import { useRef, useState, type ChangeEvent } from 'react';
import { FileText, RotateCcw, Trash2, UploadCloud } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useCheckpoints } from '../hooks/useCheckpoints';
import { useAnalysis } from '../contexts/AnalysisContext';
import { formatRelativeTime } from '../services/historyService';
import { Button } from './ui/button';

export function CheckpointList() {
  const navigate = useNavigate();
  const { checkpoints, discard } = useCheckpoints();
  const { resumeAnalysis, progress } = useAnalysis();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);

  if (checkpoints.length === 0) {
    return null;
  }

  const busy =
    progress.stage !== 'idle' &&
    progress.stage !== 'complete' &&
    progress.stage !== 'error';

  function handleResume(checkpointId: string) {
    void resumeAnalysis(checkpointId);
    navigate('/analysis');
  }

  function handleUploaded(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file && uploadId) {
      void resumeAnalysis(uploadId, file);
      navigate('/analysis');
    }
  }

  function handleBrowse(checkpointId: string) {
    setUploadId(checkpointId);
    inputRef.current?.click();
  }

  return (
    <section className="mt-10" aria-label="In progress">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">In progress</h2>
        <span className="text-xs text-muted-foreground">
          Paused reviews resume from the last analyzed page
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,application/pdf"
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={handleUploaded}
      />
      <div className="mt-3">
        <ul className="flex flex-col gap-2">
          {checkpoints.map((checkpoint) => (
            <li
              key={checkpoint.id}
              className="group flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-sm"
            >
              <div className="rounded-md bg-muted p-2 text-primary">
                <FileText className="size-4" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {checkpoint.fileName}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-primary">
                    Paused at page {checkpoint.processedPages} of {checkpoint.pageCount}
                  </span>
                  <span>
                    {checkpoint.risks.length} finding
                    {checkpoint.risks.length === 1 ? '' : 's'} so far
                  </span>
                  <span>{formatRelativeTime(checkpoint.updatedAt)}</span>
                </p>
              </div>
              {checkpoint.fileB64 ? (
                <Button
                  size="sm"
                  onClick={() => handleResume(checkpoint.id)}
                  disabled={busy}
                >
                  <RotateCcw className="size-4" aria-hidden="true" />
                  Resume
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleBrowse(checkpoint.id)}
                  disabled={busy}
                >
                  <UploadCloud className="size-4" aria-hidden="true" />
                  Upload PDF to resume
                </Button>
              )}
              <button
                type="button"
                onClick={() => discard(checkpoint.id)}
                aria-label={`Discard in-progress review of ${checkpoint.fileName}`}
                className="shrink-0 rounded-md p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}