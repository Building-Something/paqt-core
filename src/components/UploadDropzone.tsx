import { useState, type DragEvent, type ChangeEvent, useRef } from 'react';
import { FileText, UploadCloud, X } from 'lucide-react';

interface UploadDropzoneProps {
  onFileSelected: (file: File) => void;
  busy?: boolean;
}

const ACCEPTED = '.pdf,application/pdf';

export function UploadDropzone({ onFileSelected, busy = false }: UploadDropzoneProps) {
  const [dragging, setDragging] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [rejectReason, setRejectReason] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function acceptFile(file: File | undefined | null) {
    if (!file) {
      return;
    }
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setRejectReason('Only PDF files can be analyzed.');
      setPendingFile(null);
      return;
    }
    if (file.size > 60 * 1024 * 1024) {
      setRejectReason('This PDF is larger than 60 MB. Try a smaller file.');
      setPendingFile(null);
      return;
    }
    setRejectReason(null);
    setPendingFile(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    acceptFile(file);
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    acceptFile(file);
    event.target.value = '';
  }

  function confirm() {
    if (pendingFile) {
      onFileSelected(pendingFile);
      setPendingFile(null);
    }
  }

  function cancel() {
    setPendingFile(null);
    setRejectReason(null);
  }

  return (
    <div className="w-full">
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload a PDF contract"
        onClick={() => {
          if (!busy && !pendingFile) {
            inputRef.current?.click();
          }
        }}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !busy && !pendingFile) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={[
          'relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors',
          `${busy ? 'pointer-events-none opacity-60' : ''}`,
          dragging
            ? 'border-primary-500 bg-primary-50'
            : 'border-ink-300 bg-white hover:border-primary-400 hover:bg-primary-50/40',
        ].join(' ')}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          className="sr-only"
          onChange={handleChange}
          aria-hidden="true"
          tabIndex={-1}
        />
        <div className="rounded-full bg-primary-100 p-3 text-primary-700">
          <UploadCloud className="size-7" aria-hidden="true" />
        </div>
        <p className="mt-4 text-base font-semibold text-ink-800">
          {busy ? 'Processing…' : 'Drop your contract here'}
        </p>
        <p className="mt-1 text-sm text-ink-500">
          or{' '}
          <span className="font-semibold text-primary-700 underline decoration-primary-300 underline-offset-2">
            browse
          </span>{' '}
          for a PDF
        </p>
        <p className="mt-3 text-xs text-ink-400">
          Contracts are extracted in your browser; analysis runs through Paqt’s
          server.
        </p>
      </div>

      {rejectReason ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-critical-100 px-3 py-2 text-sm text-critical-700">
          <X className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {rejectReason}
        </div>
      ) : null}

      {pendingFile ? (
        <div className="card mt-4 flex items-center gap-3 p-3">
          <div className="rounded-lg bg-ink-100 p-2 text-ink-500">
            <FileText className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink-800">{pendingFile.name}</p>
            <p className="text-xs text-ink-400">
              {(pendingFile.size / 1024 / 1024).toFixed(2)} MB
            </p>
          </div>
          <button type="button" onClick={confirm} className="btn-primary">
            Analyze
          </button>
          <button
            type="button"
            onClick={cancel}
            aria-label="Remove selected file"
            className="rounded-lg p-2 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}