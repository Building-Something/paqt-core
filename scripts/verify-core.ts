import { parseJsonObject } from '../src/utils/json';
import { groupPagesIntoBatches } from '../src/utils/batching';
import { buildDraftPages, splitDraftIntoSections } from '../src/utils/draft';
import {
  computeRiskScore,
  normalizeRisks,
  deduplicateRisks,
  sortRisks,
} from '../src/utils/risks';
import {
  normalizeQuoteText,
  quoteMatchesPageText,
  locateQuoteInPages,
  verifyRisksAgainstPages,
  keepVerifiedRisks,
} from '../src/utils/riskVerify';
import { estimateRequestTokens, extractRetryAfterMs } from '../src/utils/rateLimit';
import { TokenPacer } from '../src/services/tokenPacer';
import type { ContractRisk, PdfPage } from '../src/types';

let failures = 0;
function assert(label, cond) {
  if (cond) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}`);
  }
}

// 1. JSON parsing
const json = { contractType: 'NDA', risks: [{ text: 'x', riskLevel: 'high', pageNumber: 2 }] };
assert('parse raw JSON', parseJsonObject(JSON.stringify(json)).contractType === 'NDA');
assert('parse fenced JSON', parseJsonObject('```json\n' + JSON.stringify(json) + '\n```').contractType === 'NDA');
assert('parse JSON in prose', parseJsonObject('Here: ' + JSON.stringify(json)).contractType === 'NDA');
let threwInvalid = false;
try { parseJsonObject('no object here'); } catch { threwInvalid = true; }
assert('reject non-object', threwInvalid);

// 2. Batching
const pages = [];
for (let i = 1; i <= 20; i += 1) {
  pages.push({ pageNumber: i, text: 'a'.repeat(2000) });
}
const batches = groupPagesIntoBatches(pages);
assert('batch count respects 8-page cap', batches.length === 3);
assert('batch 1 has 8 pages', batches[0].length === 8);
assert('batch 2 has 8 pages', batches[1].length === 8);
const pageNumbers = batches.flat().map((p) => p.pageNumber);
assert('all pages preserved in order', JSON.stringify(pageNumbers) === JSON.stringify([...Array(20)].map((_, i) => i + 1)));

// char-limit batches: 12 pages of 3000 chars = 36k -> each >20k so split
const bigCharPages = [];
for (let i = 1; i <= 12; i += 1) {
  bigCharPages.push({ pageNumber: i, text: 'b'.repeat(3000) });
}
const charBatches = groupPagesIntoBatches(bigCharPages);
assert('char limit splits correctly', charBatches.length === 2 && charBatches[0].length === 6 && charBatches[1].length === 6);

// 3. Risk normalization / dedupe / sort / score
const raw = [
  { text: 'You must pay penalty fees', riskLevel: 'high', category: 'Payment', description: '', recommendation: '', pageNumber: 3, searchText: 'penalty' },
  { text: 'You must pay penalty fees', riskLevel: 'high', category: 'Payment', description: '', recommendation: '', pageNumber: 3, searchText: 'penalty' },
  { text: 'Either party may terminate', riskLevel: 'critical', category: 'Termination', description: '', recommendation: '', pageNumber: 1, searchText: 'terminate' },
  { text: 'Liability shall be limited', riskLevel: 'low', category: 'Liability', description: '', recommendation: '', pageNumber: 1, searchText: 'liability' },
];
const normalized = normalizeRisks(raw);
assert('dedupe removes exact duplicate', normalized.length === 3);
assert('stable ids assigned', normalized[0].id === 'risk-1' && normalized[1].id === 'risk-2');
assert('sorted by page then severity', normalized[0].pageNumber === 1 && normalized[0].riskLevel === 'critical');
assert('sorted page1 low before page3', normalized[1].pageNumber === 1 && normalized[1].riskLevel === 'low');
assert('defaults applied', normalized[0].description === 'No description provided.');
assert('score within clamp', computeRiskScore(normalized) >= 5 && computeRiskScore(normalized) <= 98);
assert('empty risks score 10', computeRiskScore([]) === 10);
assert('deduplicate idempotent', deduplicateRisks(normalized).length === normalized.length);
assert('sort does not mutate', sortRisks([{ ...normalized[0] }]).length === 1);

const badLevel = normalizeRisks([{ text: 'x', riskLevel: 'catastrophe', category: '', pageNumber: 0 }]);
assert('normalizes bad level to low', badLevel[0].riskLevel === 'low');
assert('clamps page to >=1', badLevel[0].pageNumber === 1);

// 4. Draft splitting
const draft = [
  '# Parties',
  '',
  'This agreement is between [Client Full Legal Name] and [Provider Full Legal Name].',
  '',
  '## Services',
  '',
  '- Build a landing page',
  '- Responsive design',
  '',
  '## Fees',
  '',
  '| Milestone | Amount |',
  '| --------- | ------ |',
  '| Deposit   | $1,250 |',
  '| Final     | $3,750 |',
  '',
  'Final line to verify preamble capture.',
].join('\n');
const draftSections = splitDraftIntoSections(draft);
assert('draft splits by headings', draftSections.length === 3);
assert('draft sections carry sequential page numbers', draftSections[0].pageNumber === 1 && draftSections[2].pageNumber === 3);
assert('draft heading extracted', draftSections[1].heading === 'Services');
assert('CRLF tolerated', splitDraftIntoSections(draft.replace(/\n/g, '\r\n')).length === 3);
const introOnly = splitDraftIntoSections('No headings here at all.\n\nJust paragraphs.\n\nAnd nothing more.');
assert('heading-less draft chunks by paragraphs', introOnly.length >= 1 && introOnly[0].heading.startsWith('Part '));
const draftPages = buildDraftPages(draftSections);
assert('draft pages include heading in text', draftPages[0].text.startsWith('Parties'));
assert('draft page numbers sequential', draftPages.map((p) => p.pageNumber).join(',') === '1,2,3');

// 5. Cross-clause quote verification
const verPages = [
  { pageNumber: 1, text: 'The Company shall indemnify the Client against all third-party claims arising from the Services provided under this Agreement.' },
  { pageNumber: 2, text: 'Notwithstanding Section 1, the Client\u2019s exclusive remedy shall be a refund of fees paid, and all other remedies are waived.' },
];
assert('normalize quote text', normalizeQuoteText('  Net  \n 30 days  ') === 'net 30 days');
assert('exact quote matches despite whitespace drift', quoteMatchesPageText('Client\u2019s exclusive remedy shall be a refund', verPages[1].text));
assert('wrong page corrected via all-page fallback', locateQuoteInPages(verPages, 'exclusive remedy shall be a refund', 1)?.pageNumber === 2);
const fabricated = verifyRisksAgainstPages(verPages, [{ text: 'fabricated invented clause nowhere in text', pageNumber: 2 }]);
assert('unverifiable quote rejected', keepVerifiedRisks(fabricated).length === 0);
const crossClause = verifyRisksAgainstPages(verPages, [{ text: 'exclusive remedy shall be a refund', pageNumber: 1, relatedPages: [2] }]);
assert('cross-clause quote verified and re-pinned', keepVerifiedRisks(crossClause).length === 1 && crossClause[0].pageNumber === 2 && crossClause[0].relatedPages?.join(',') === '2');

// 6. Rate-limit handling
const pacing = new TokenPacer({ tokensPerMinute: 7000, nowMs: () => 0 });
assert('pacer starts with full budget', pacing.reserve(7000) === 0);
assert('pacer waits once exhausted', pacing.reserve(1) > 0);
assert('page request estimate fits budget', estimateRequestTokens({ messages: [{ content: 'x'.repeat(12000) }], max_tokens: 2560 }) < 7000);
assert('single-call estimate exceeds budget', estimateRequestTokens({ messages: [{ content: 'x'.repeat(25000) }], max_tokens: 4096 }) > 7000);
assert('retry-after body respected', extractRetryAfterMs(20_000, null) === 20_000);
assert('retry-after capped at 60s', extractRetryAfterMs(3_600_000, null) === 60_000);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);