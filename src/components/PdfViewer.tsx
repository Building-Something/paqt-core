import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Document, Page } from 'react-pdf';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RotateCcw,
  ScanSearch,
} from 'lucide-react';
import type { ContractRisk } from '../types';
import { downloadOriginalPdf } from '../services/exportService';
import { RiskMarker } from './RiskMarker';
import { ErrorState } from './ErrorState';

interface PdfViewerProps {
  file: File;
  fileName: string;
  currentPage: number;
  totalPages: number;
  pagesText: string[];
  risks: ContractRisk[];
  selectedRisk: ContractRisk | null;
  onPageChange: (page: number) => void;
  onSelectRisk: (risk: ContractRisk) => void;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const STEP = 0.2;
const DEFAULT_SCALE = 1.2;

function roundScale(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampScale(value: number): number {
  return roundScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, value)));
}

function IconButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex items-center justify-center rounded-lg p-2 text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function PdfViewer({
  file,
  fileName,
  currentPage,
  totalPages,
  pagesText,
  risks,
  selectedRisk,
  onPageChange,
  onSelectRisk,
}: PdfViewerProps) {
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  const pageMarkers = useMemo(
    () =>
      risks
        .filter((risk) => risk.pageNumber === currentPage)
        .sort((a, b) => a.riskLevel.localeCompare(b.riskLevel)),
    [risks, currentPage],
  );

  const currentPageText = pagesText[currentPage - 1] ?? '';
  const pageIsScanned =
    totalPages > 0 && currentPageText.trim().length === 0;

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await containerRef.current?.requestFullscreen();
    }
  }

  function goToPage(page: number) {
    if (page < 1 || page > totalPages) {
      return;
    }
    onPageChange(page);
  }

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-ink-200/70"
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-ink-200 bg-white px-3 py-2">
        <p className="mr-2 min-w-0 flex-1 truncate text-sm font-medium text-ink-800">
          {fileName}
        </p>

        <div className="flex items-center gap-0.5">
          <IconButton
            label="Previous page"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </IconButton>
          <span className="inline-flex items-center gap-1 rounded-lg border border-ink-200 px-2 py-1 text-xs font-medium tabular-nums text-ink-700">
            <input
              type="number"
              aria-label="Page number"
              min={1}
              max={totalPages}
              value={currentPage}
              onChange={(event) => goToPage(Number(event.target.value))}
              className="w-10 bg-transparent text-center focus:outline-none"
            />
            <span className="text-ink-400">/ {totalPages}</span>
          </span>
          <IconButton
            label="Next page"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= totalPages}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </IconButton>
        </div>

        <div className="mx-1 h-5 w-px bg-ink-200" aria-hidden="true" />

        <div className="flex items-center gap-0.5">
          <IconButton
            label="Zoom out"
            onClick={() => setScale(clampScale(scale - STEP))}
            disabled={scale <= MIN_SCALE}
          >
            <Minus className="size-4" aria-hidden="true" />
          </IconButton>
          <button
            type="button"
            onClick={() => setScale(clampScale(1))}
            title="Reset zoom to 100%"
            aria-label="Reset zoom to 100%"
            className="inline-flex min-w-12 items-center justify-center rounded-lg px-2 py-1 text-xs font-medium tabular-nums text-ink-700 transition-colors hover:bg-ink-100"
          >
            {Math.round(scale * 100)}%
          </button>
          <IconButton
            label="Zoom in"
            onClick={() => setScale(clampScale(scale + STEP))}
            disabled={scale >= MAX_SCALE}
          >
            <Plus className="size-4" aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Reset zoom to 100%"
            onClick={() => setScale(clampScale(1))}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
          </IconButton>
        </div>

        <div className="mx-1 h-5 w-px bg-ink-200" aria-hidden="true" />

        <IconButton
          label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={toggleFullscreen}
        >
          {isFullscreen ? (
            <Minimize2 className="size-4" aria-hidden="true" />
          ) : (
            <Maximize2 className="size-4" aria-hidden="true" />
          )}
        </IconButton>
        <IconButton
          label="Download original PDF"
          onClick={() => downloadOriginalPdf(fileName, file)}
        >
          <Download className="size-4" aria-hidden="true" />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="relative mx-auto w-fit min-h-[400px]">
          <Document
            file={file}
            onLoadError={() =>
              setDocumentError('Paqt could not render this PDF. The file may be corrupt.')
            }
            loading={
              <div className="flex h-64 w-full items-center justify-center gap-2 text-sm text-ink-500">
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                Loading document…
              </div>
            }
            error={
              documentError ? (
                <ErrorState message={documentError} />
              ) : (
                <ErrorState
                  message="Paqt could not render this PDF."
                  onRetry={() => setDocumentError(null)}
                />
              )
            }
          >
            <div className="relative shadow-card">
              <Page
                pageNumber={currentPage}
                scale={scale}
                renderTextLayer={false}
                renderAnnotationLayer={false}
                loading={
                  <div className="flex h-96 items-center justify-center bg-white text-sm text-ink-500">
                    <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                  </div>
                }
                onLoadError={() =>
                  setDocumentError('This page could not be rendered.')
                }
              />

              {pageMarkers.length > 0 ? (
                <div className="absolute right-2 top-2 flex max-w-[85%] flex-wrap items-start justify-end gap-2">
                  {pageMarkers.map((risk, index) => (
                    <RiskMarker
                      key={risk.id}
                      risk={risk}
                      number={index + 1}
                      selected={selectedRisk?.id === risk.id}
                      onSelect={onSelectRisk}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </Document>

          {pageIsScanned ? (
            <div className="pointer-events-none absolute inset-x-2 bottom-3 mx-auto max-w-md rounded-lg border border-medium-500/40 bg-white/95 px-4 py-3 shadow-pop">
              <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-700">
                <ScanSearch className="mt-0.5 size-4 shrink-0 text-medium-700" aria-hidden="true" />
                This PDF may be scanned or image-based. Paqt could not reliably
                extract text from one or more pages.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}