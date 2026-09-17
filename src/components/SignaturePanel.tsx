import { useRef, useState } from 'react';
import { Check, FileSignature, Trash2, Upload } from 'lucide-react';
import type { ContractSignature, ContractSignatures } from '../utils/contractDocument';

interface SignaturePanelProps {
  value: ContractSignatures;
  onChange: (next: ContractSignatures) => void;
  disabled?: boolean;
}

const MAX_WIDTH = 1200;
const MAX_HEIGHT = 600;

function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image file.'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('The selected file is not a readable image.'));
      image.onload = () => {
        const scale = Math.min(1, MAX_WIDTH / image.width, MAX_HEIGHT / image.height);
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('Canvas is not available.'));
          return;
        }
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL('image/png'));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function SignatureSlot({
  party,
  sig,
  disabled,
  onChange,
}: {
  party: 'client' | 'provider';
  sig?: ContractSignature;
  disabled?: boolean;
  onChange: (next: ContractSignature | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File | undefined) {
    setError(null);
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      setError('Choose a PNG or JPEG image of your signature.');
      return;
    }
    try {
      const dataUrl = await readImageFile(file);
      onChange({ dataUrl, name: sig?.name ?? '' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read that image.');
    }
  }

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-foreground">
        {party === 'client' ? 'Client' : 'Provider'}
      </p>
      {sig?.dataUrl ? (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-2">
            <span className="inline-flex h-11 min-w-20 items-center justify-center rounded border border-dashed border-muted-foreground/30 bg-white px-2">
              <img src={sig.dataUrl} alt={`${party} signature`} className="max-h-10 max-w-36 object-contain" />
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={disabled}
                title="Replace signature"
                aria-label="Replace signature"
                className="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Upload className="size-3.5" aria-hidden="true" />
                Replace
              </button>
              <button
                type="button"
                onClick={() => onChange(null)}
                disabled={disabled}
                title="Remove signature"
                aria-label="Remove signature"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
          <label className="mt-3 block">
            <span className="text-xs font-medium text-foreground">Signed by (optional)</span>
            <input
              type="text"
              value={sig.name ?? ''}
              disabled={disabled}
              onChange={(event) => onChange({ ...sig, name: event.target.value })}
              placeholder="e.g. [Client Full Legal Name]"
              className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-60"
            />
          </label>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-dashed border-muted-foreground/40 px-3 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Upload className="size-4" aria-hidden="true" />
          Upload signature
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function SignaturePanel({
  value,
  onChange,
  disabled = false,
}: SignaturePanelProps) {
  const savedNote = (value.client || value.provider) && !disabled;

  return (
    <div className="p-5">
      <div className="flex items-start gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FileSignature className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold leading-5 text-foreground">Add signatures</h2>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            Upload an image of each signature and it will appear in the signature
            area of the exported PDF.
          </p>
        </div>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <SignatureSlot
          party="client"
          sig={value.client}
          disabled={disabled}
          onChange={(next) =>
            onChange({ ...value, client: next ?? undefined })
          }
        />
        <SignatureSlot
          party="provider"
          sig={value.provider}
          disabled={disabled}
          onChange={(next) =>
            onChange({ ...value, provider: next ?? undefined })
          }
        />
      </div>
      {savedNote ? (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="size-3.5 text-emerald-600" aria-hidden="true" />
          Signatures are saved with this draft and included on export.
        </p>
      ) : null}
    </div>
  );
}