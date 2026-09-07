import { Download, FileSpreadsheet, FileText, FileDown } from 'lucide-react';
import { useAnalysis } from '../contexts/AnalysisContext';
import {
  downloadOriginalPdf,
  downloadTextFile,
  exportRisksToXlsx,
} from '../services/exportService';
import { sanitizedFileName } from '../utils/risks';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

export function ExportButton() {
  const { analysis, fileName, file, totalPages, isDraft, draftMarkdown } = useAnalysis();

  const hasRisks = Boolean(analysis && analysis.risks.length > 0);

  function handleXlsx() {
    exportRisksToXlsx(fileName, analysis);
  }

  function handlePdf() {
    downloadOriginalPdf(fileName, file);
  }

  function handleDraftDownload() {
    if (draftMarkdown) {
      downloadTextFile(
        sanitizedFileName(fileName, 'draft.md'),
        draftMarkdown,
        'text/markdown;charset=utf-8',
      );
    }
  }

  if (!analysis) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <Download className="size-4" aria-hidden="true" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem disabled={!hasRisks} onSelect={handleXlsx}>
          <FileSpreadsheet className="size-4 text-muted-foreground" aria-hidden="true" />
          <span>
            <span className="block text-sm font-medium">Risks spreadsheet</span>
            <span className="block text-xs text-muted-foreground">
              {hasRisks
                ? `${analysis.risks.length} risk${analysis.risks.length === 1 ? '' : 's'} · XLSX`
                : 'No risks to export'}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {isDraft ? (
          <DropdownMenuItem onSelect={handleDraftDownload}>
            <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
            <span>
              <span className="block text-sm font-medium">Draft (Markdown)</span>
              <span className="block text-xs text-muted-foreground">
                {totalPages} section{totalPages === 1 ? '' : 's'} · .md
              </span>
            </span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={handlePdf}>
            <FileDown className="size-4 text-muted-foreground" aria-hidden="true" />
            <span>
              <span className="block text-sm font-medium">Original document</span>
              <span className="block text-xs text-muted-foreground">
                {totalPages} page{totalPages === 1 ? '' : 's'} · PDF
              </span>
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}