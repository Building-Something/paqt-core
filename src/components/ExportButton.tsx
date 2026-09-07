import { useEffect, useState } from 'react';
import { Download, FileSpreadsheet, FileText, FileDown } from 'lucide-react';
import { useAnalysis } from '../contexts/AnalysisContext';
import {
  downloadOriginalPdf,
  downloadTextFile,
  exportRisksToXlsx,
} from '../services/exportService';
import { sanitizedFileName } from '../utils/risks';

export function ExportButton() {
  const { analysis, fileName, file, totalPages, isDraft, draftMarkdown } = useAnalysis();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  const hasRisks = Boolean(analysis && analysis.risks.length > 0);

  function handleXlsx() {
    exportRisksToXlsx(fileName, analysis);
    setOpen(false);
  }

  function handlePdf() {
    downloadOriginalPdf(fileName, file);
    setOpen(false);
  }

  function handleDraftDownload() {
    if (!draftMarkdown) {
      return;
    }
    downloadTextFile(
      sanitizedFileName(fileName, 'draft.md'),
      draftMarkdown,
      'text/markdown;charset=utf-8',
    );
    setOpen(false);
  }

  if (!analysis) {
    return null;
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="btn-secondary"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Download className="size-4" aria-hidden="true" />
        Export
      </button>

      {open ? (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            role="menu"
            className="absolute right-0 z-20 mt-2 w-64 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-pop"
          >
            <button
              type="button"
              role="menuitem"
              onClick={handleXlsx}
              disabled={!hasRisks}
              className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileSpreadsheet className="mt-0.5 size-4 text-low-600" aria-hidden="true" />
              <span>
                <span className="block text-sm font-medium text-ink-800">
                  Risks spreadsheet
                </span>
                <span className="block text-xs text-ink-500">
                  {hasRisks
                    ? `${analysis.risks.length} risk${analysis.risks.length === 1 ? '' : 's'} · XLSX`
                    : 'No risks to export'}
                </span>
              </span>
            </button>
            <div className="h-px bg-ink-100" />
            {isDraft ? (
              <button
                type="button"
                role="menuitem"
                onClick={handleDraftDownload}
                className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-50"
              >
                <FileText className="mt-0.5 size-4 text-medium-600" aria-hidden="true" />
                <span>
                  <span className="block text-sm font-medium text-ink-800">
                    Draft (Markdown)
                  </span>
                  <span className="block text-xs text-ink-500">
                    {totalPages} section{totalPages === 1 ? '' : 's'} · .md
                  </span>
                </span>
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={handlePdf}
                className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-50"
              >
                <FileDown className="mt-0.5 size-4 text-primary-600" aria-hidden="true" />
                <span>
                  <span className="block text-sm font-medium text-ink-800">
                    Original document
                  </span>
                  <span className="block text-xs text-ink-500">
                    {totalPages} page{totalPages === 1 ? '' : 's'} · PDF
                  </span>
                </span>
              </button>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}