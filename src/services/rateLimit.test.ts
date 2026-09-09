import { describe, expect, it } from 'vitest';
import type { PdfPage } from '../types';
import { buildInteractionWindows } from './groqService';
import { estimateRequestTokens, extractRetryAfterMs } from '../utils/rateLimit';

function makePages(count: number, charsPerPage: number): PdfPage[] {
  return Array.from({ length: count }, (_, index) => ({
    pageNumber: index + 1,
    text: 'x'.repeat(charsPerPage),
  }));
}

describe('extractRetryAfterMs', () => {
  it('uses the body retryAfterMs', () => {
    expect(extractRetryAfterMs(12_500, null)).toBe(12_500);
  });

  it('parses the retry-after header seconds', () => {
    expect(extractRetryAfterMs(undefined, '15')).toBe(15_000);
  });

  it('ignores a non-numeric header', () => {
    expect(extractRetryAfterMs(undefined, 'not-a-date')).toBeUndefined();
  });

  it('caps waits at the maximum delay', () => {
    expect(extractRetryAfterMs(3_600_000, null)).toBe(60_000);
    expect(extractRetryAfterMs(undefined, '7200')).toBe(60_000);
  });

  it('prefers the body value over the header', () => {
    expect(extractRetryAfterMs(1_000, '99')).toBe(1_000);
  });
});

describe('estimateRequestTokens', () => {
  it('allocates input and output tokens', () => {
    const estimate = estimateRequestTokens({
      messages: [
        { content: 'x'.repeat(800) },
        { content: 'y'.repeat(800) },
      ],
      max_tokens: 4096,
    });
    expect(estimate).toBe(400 + 4096 + 64);
  });

  it('applies a minimum output budget', () => {
    const estimate = estimateRequestTokens({
      messages: [{ content: 'a' }],
      max_tokens: 8,
    });
    expect(estimate).toBeGreaterThanOrEqual(256 + 64);
  });
});

describe('buildInteractionWindows', () => {
  it('returns empty for a document over the hard limit', () => {
    expect(buildInteractionWindows(makePages(1, 300_001))).toEqual([]);
  });

  it('keeps a small document in one window', () => {
    const windows = buildInteractionWindows(makePages(3, 1000));
    expect(windows).toHaveLength(1);
    expect(windows[0].pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
  });

  it('splits large documents into overlapping windows', () => {
    const windows = buildInteractionWindows(makePages(12, 6000));
    expect(windows.length).toBeGreaterThan(1);
    const first = windows[0].pages;
    const second = windows[1].pages;
    const overlap = first.filter((page) =>
      second.some((other) => other.pageNumber === page.pageNumber),
    );
    expect(overlap.length).toBeGreaterThan(0);
  });

  it('covers every page across windows in order', () => {
    const pages = makePages(30, 5000);
    const windows = buildInteractionWindows(pages);
    const covered = windows.flatMap((window) =>
      window.pages.map((page) => page.pageNumber),
    );
    expect(windows.length).toBeGreaterThan(1);
    expect(pages.every((page) => covered.includes(page.pageNumber))).toBe(true);
  });
});