import { getDocument } from 'pdfjs-dist';
import { configureWorker } from './pdfService';

/**
 * Persists the compact bits of a completed PDF review into account storage:
 *  - ONE small JPEG page preview (~30–90 KB) for list thumbnails, and
 *  - the ORIGINAL document (application/pdf) so archived reviews keep their
 *    PDF viewer and chat is possible from history.
 *
 * The PDF is deliberately kept byte-for-byte (no lossy re-encode, which would
 * destroy the text layer chat depends on). Files larger than MAX_PDF_STORE_BYTES
 * are not stored — the review still keeps its analysis + thumbnail and opens in
 * read-only mode.
 */

export const MAX_PDF_STORE_BYTES = 25 * 1024 * 1024;

export async function persistAnalysisDocument(file: File, entryId: string): Promise<void> {
  const { getBoundUserId, getHistoryEntry, upsertHistoryEntry } = await import('./historyService');
  const userId = getBoundUserId();
  if (!userId) {
    return;
  }
  let entry = getHistoryEntry(entryId);
  if (!entry) {
    return;
  }
  const mod = await import('./supabaseHistoryService');

  const previewBlob = await renderPdfPreview(file);
  if (previewBlob) {
    const path = await mod.uploadPreview(userId, entryId, previewBlob);
    if (path) {
      entry = { ...entry, previewPath: path };
    }
  }

  if (file.size <= MAX_PDF_STORE_BYTES) {
    const pdfPath = await mod.uploadPdf(userId, entryId, file);
    if (pdfPath) {
      entry = { ...entry, pdfPath };
    }
  }

  if (entry.previewPath || entry.pdfPath) {
    upsertHistoryEntry(entry);
  }
  void mod.enforceStorageQuota(userId);
}
const PREVIEW_WIDTH = 420;
const QUALITY = 0.62;

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Could not encode preview.'));
      }
    }, type, quality);
  });
}

export async function renderPdfPreview(file: File): Promise<Blob | null> {
  try {
    configureWorker();
    const data = await file.arrayBuffer();
    const loadingTask = getDocument({ data });
    const pdf = await loadingTask.promise;
    try {
      const page = await pdf.getPage(1);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(PREVIEW_WIDTH / baseViewport.width, 2);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) {
        return null;
      }
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      return await canvasToBlob(canvas, 'image/jpeg', QUALITY);
    } finally {
      await loadingTask.destroy().catch(() => undefined);
    }
  } catch {
    return null;
  }
}