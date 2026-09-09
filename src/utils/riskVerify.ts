import type { ContractRisk, PdfPage } from '../types';

export function normalizeQuoteText(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?"'’”)\]}…]+$/g, '')
    .trim();
}

function tokenize(text: string): string[] {
  return normalizeQuoteText(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function longestCommonRun(tokens: string[], pageTokens: Set<string>): number {
  let best = 0;
  let run = 0;
  for (const token of tokens) {
    run = pageTokens.has(token) ? run + 1 : 0;
    if (run > best) {
      best = run;
    }
  }
  return best;
}

export function quoteMatchesPageText(
  quote: string,
  pageText: string,
  minTokens = 4,
  minOverlap = 0.75,
): boolean {
  const normalizedQuote = normalizeQuoteText(quote);
  const normalizedPage = normalizeQuoteText(pageText);
  if (!normalizedQuote || !normalizedPage) {
    return false;
  }
  if (normalizedPage.includes(normalizedQuote)) {
    return true;
  }
  const quoteTokens = tokenize(normalizedQuote);
  if (quoteTokens.length < minTokens) {
    return false;
  }
  const pageTokens = new Set(tokenize(normalizedPage));
  const matched = quoteTokens.filter((token) => pageTokens.has(token)).length;
  const overlap = matched / quoteTokens.length;
  if (overlap < minOverlap) {
    return false;
  }
  const minRun = Math.max(3, Math.ceil(quoteTokens.length * 0.6));
  return longestCommonRun(quoteTokens, pageTokens) >= minRun;
}

export interface QuoteLocation {
  pageNumber: number;
  exact: boolean;
}

export function locateQuoteInPages(
  pages: PdfPage[],
  quote: string,
  preferredPage?: number,
): QuoteLocation | null {
  const preferred = preferredPage != null ? preferredPage : undefined;
  const ordered = preferred != null
    ? [
        ...pages.filter((page) => page.pageNumber === preferred),
        ...pages.filter((page) => page.pageNumber !== preferred),
      ]
    : pages;

  for (const page of ordered) {
    if (quoteMatchesPageText(quote, page.text)) {
      return { pageNumber: page.pageNumber, exact: normalizeQuoteText(page.text).includes(normalizeQuoteText(quote)) };
    }
  }
  return null;
}

export function verifyRisksAgainstPages(
  pages: PdfPage[],
  risks: Partial<ContractRisk>[],
): ContractRisk[] {
  return risks.map((risk) => {
    const quote = (risk.text || '').trim();
    const located = quote
      ? locateQuoteInPages(pages, quote, risk.pageNumber)
      : null;
    return {
      ...(risk as ContractRisk),
      text: quote || 'Clause text unavailable.',
      verified: located !== null,
      pageNumber: located?.pageNumber ?? risk.pageNumber ?? 1,
    };
  });
}

export function keepVerifiedRisks(risks: ContractRisk[]): ContractRisk[] {
  return risks.filter((risk) => risk.verified === true);
}