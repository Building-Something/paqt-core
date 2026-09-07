import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import { pdfjs as reactPdfPdfjs } from 'react-pdf';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  ANALYSIS_CONTEXT_LIMIT,
  BATCH_CHAR_LIMIT,
  BATCH_MAX_TOKENS,
  PAGES_PER_BATCH,
  SINGLE_CALL_MAX_CHARS,
  SINGLE_CALL_MAX_PAGES,
} from '../constants/pipeline';

export {
  SINGLE_CALL_MAX_PAGES,
  SINGLE_CALL_MAX_CHARS,
  PAGES_PER_BATCH,
  BATCH_CHAR_LIMIT,
  BATCH_MAX_TOKENS,
  ANALYSIS_CONTEXT_LIMIT,
};

const WORKER_SRC = workerUrl;

let workerConfigured = false;

export function configureWorker() {
  if (workerConfigured) {
    return;
  }
  GlobalWorkerOptions.workerSrc = WORKER_SRC;
  if (reactPdfPdfjs && reactPdfPdfjs.GlobalWorkerOptions) {
    reactPdfPdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC;
  }
  workerConfigured = true;
}

export function buildPageMarkers(pageNumber: number, text: string): string {
  return `=== PAGE ${pageNumber} START ===\n${text}\n=== PAGE ${pageNumber} END ===`;
}

function normalizePageText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export async function extractContractText(pages: import('../types').PdfPage[]): Promise<string> {
  return pages.map((page) => buildPageMarkers(page.pageNumber, page.text)).join('\n\n');
}

export async function extractPdfText(file: File): Promise<import('../types').PdfPage[]> {
  configureWorker();

  const data = await file.arrayBuffer();

  let loadingTask;
  try {
    loadingTask = getDocument({ data });
    const pdf = await loadingTask.promise;

    const pages: import('../types').PdfPage[] = [];
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const items = content.items || [];
      const raw = items
        .map((item) => ('str' in item ? (item.str as string) : ''))
        .join(' ');
      pages.push({
        pageNumber: i,
        text: normalizePageText(raw),
      });
    }
    return pages;
  } finally {
    if (loadingTask && 'destroy' in loadingTask) {
      try {
        await loadingTask.destroy();
      } catch {
        // Best-effort cleanup; original error takes precedence.
      }
    }
  }
}