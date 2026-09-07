import type { PdfPage } from '../types';
import { BATCH_CHAR_LIMIT, PAGES_PER_BATCH } from '../constants/pipeline';

export function groupPagesIntoBatches(pages: PdfPage[]): PdfPage[][] {
  const batches: PdfPage[][] = [];
  let current: PdfPage[] = [];
  let currentChars = 0;

  for (const page of pages) {
    const pageChars = page.text.length;
    const wouldExceedCharLimit = currentChars + pageChars > BATCH_CHAR_LIMIT;
    const wouldExceedPageLimit = current.length >= PAGES_PER_BATCH;

    if ((wouldExceedCharLimit || wouldExceedPageLimit) && current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(page);
    currentChars += pageChars;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}