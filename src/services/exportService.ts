import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import type { ContractAnalysis } from '../types';
import { SEVERITY_META, sanitizedFileName } from '../utils/risks';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

export function exportRisksToXlsx(
  fileName: string,
  analysis: ContractAnalysis | null,
): void {
  if (!analysis || analysis.risks.length === 0) {
    return;
  }

  const rows: (string | number)[][] = [
    ['Risk', 'Severity', 'Quoted Text', 'Page', 'Reason', 'Recommendation'],
  ];

  const sorted = [...analysis.risks].sort((a, b) => {
    const levelDiff =
      SEVERITY_ORDER.indexOf(a.riskLevel as (typeof SEVERITY_ORDER)[number]) -
      SEVERITY_ORDER.indexOf(b.riskLevel as (typeof SEVERITY_ORDER)[number]);
    if (levelDiff !== 0) {
      return levelDiff;
    }
    return a.pageNumber - b.pageNumber;
  });

  for (const risk of sorted) {
    rows.push([
      risk.category,
      SEVERITY_META[risk.riskLevel].label,
      risk.text,
      risk.pageNumber,
      risk.description,
      risk.recommendation,
    ]);
  }

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Risks');

  const output = XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'array',
  });

  const blob = new Blob([output], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  saveAs(blob, `${sanitizedFileName(fileName, 'risks.xlsx')}`);
}

export function downloadOriginalPdf(fileName: string, file: File | null): void {
  if (!file) {
    return;
  }
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name || fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadTextFile(fileName: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}