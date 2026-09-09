import { describe, it, expect } from 'vitest';
import {
  normalizeQuoteText,
  quoteMatchesPageText,
  locateQuoteInPages,
  verifyRisksAgainstPages,
  keepVerifiedRisks,
} from './riskVerify';
import type { PdfPage } from '../types';

const PAGES: PdfPage[] = [
  {
    pageNumber: 1,
    text: 'The Company shall indemnify the Client against all third-party claims arising from the Services provided under this Agreement.',
  },
  {
    pageNumber: 2,
    text: 'Notwithstanding Section 1, the Client’s exclusive remedy shall be a refund of fees paid, and all other remedies are waived.',
  },
  {
    pageNumber: 3,
    text: 'Either party may terminate this Agreement immediately upon breach of confidentiality obligations by the other party. This warranty expires twelve months after delivery.',
  },
];

describe('normalizeQuoteText', () => {
  it('lowercases, collapses whitespace, and trims', () => {
    expect(normalizeQuoteText('  Net\n\n  30  days, ')).toBe('net 30 days');
  });
});

describe('quoteMatchesPageText', () => {
  it('matches an exact quote with different casing and spacing', () => {
    const page = 'Section 8. Party shall pay within Net-30 days of invoice.';
    expect(quoteMatchesPageText('PARTY shall\npay within Net-30', page)).toBe(true);
  });

  it('matches despite minor punctuation drift', () => {
    const page = 'the Client\u2019s exclusive remedy shall be a refund of fees paid';
    expect(quoteMatchesPageText("Client's exclusive remedy shall be a refund", page)).toBe(true);
  });

  it('matches a fuzzy quote when tokens form a contiguous run', () => {
    expect(quoteMatchesPageText('remedy shall be a refund of fees', PAGES[1].text)).toBe(true);
  });

  it('rejects a paraphrase with insufficient token overlap', () => {
    expect(
      quoteMatchesPageText('Client has no other way to get money back other than a fee credit', PAGES[1].text),
    ).toBe(false);
  });

  it('does not fuzzy-match short quotes that are not a substring', () => {
    expect(quoteMatchesPageText('remedy fees', PAGES[1].text)).toBe(false);
  });

  it('rejects empty input', () => {
    expect(quoteMatchesPageText('', PAGES[0].text)).toBe(false);
  });
});

describe('locateQuoteInPages', () => {
  it('prefers the claimed page', () => {
    const located = locateQuoteInPages(PAGES, 'exclusive remedy shall be a refund', 2);
    expect(located?.pageNumber).toBe(2);
  });

  it('falls back to other pages when the claimed page does not contain the quote', () => {
    const located = locateQuoteInPages(PAGES, 'terminate this Agreement immediately upon breach', 1);
    expect(located?.pageNumber).toBe(3);
  });

  it('returns null when the quote appears nowhere', () => {
    expect(locateQuoteInPages(PAGES, 'aardvark propulsion clause never written')).toBeNull();
  });
});

describe('verifyRisksAgainstPages', () => {
  it('marks a grounded quote as verified and re-pins the page', () => {
    const verified = verifyRisksAgainstPages(PAGES, [
      {
        text: 'exclusive remedy shall be a refund of fees paid',
        pageNumber: 3,
        relatedPages: [1, 2],
      },
    ]);
    expect(verified[0].verified).toBe(true);
    expect(verified[0].pageNumber).toBe(2);
    expect(verified[0].relatedPages).toEqual([1, 2]);
  });

  it('marks an unverifiable quote as not verified and keeps the claimed page', () => {
    const verified = verifyRisksAgainstPages(PAGES, [
      {
        text: 'a completely fabricated limitation of liability paragraph',
        pageNumber: 4,
      },
    ]);
    expect(verified[0].verified).toBe(false);
    expect(verified[0].pageNumber).toBe(4);
  });

  it('sets verified false when no quote is present', () => {
    const verified = verifyRisksAgainstPages(PAGES, [{ text: '' }]);
    expect(verified[0].verified).toBe(false);
  });
});

describe('keepVerifiedRisks', () => {
  it('keeps only verified risks', () => {
    const risks = [
      { ...verifyRisksAgainstPages(PAGES, [{ text: 'exclusive remedy shall be a refund', pageNumber: 2 }])[0] },
      { ...verifyRisksAgainstPages(PAGES, [{ text: 'fabricated paragraph with no source', pageNumber: 5 }])[0] },
    ];
    const kept = keepVerifiedRisks(risks);
    expect(kept.length).toBe(1);
    expect(kept[0].text).toContain('exclusive remedy');
  });
});