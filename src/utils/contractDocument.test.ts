import { describe, expect, it } from 'vitest';
import {
  EMPTY_DOCUMENT,
  buildContractPdfDoc,
  docContainsSignatures,
  docFirstHeading,
  docPlainText,
  docSectionCount,
  docToMarkdown,
  markdownToDoc,
  sectionContextAround,
} from './contractDocument';

const LEGAL_SAMPLE = [
  '# FREELANCE DEVELOPER AGREEMENT',
  '',
  '> WHEREAS the parties wish to engage the Provider as set out below.',
  '',
  'This agreement is made between [Client Full Legal Name] and [Provider Full Legal Name].',
  '',
  '## 1. SERVICES',
  '',
  '1.1 Provider will deliver the landing page.',
  '',
  '- Hosting configuration',
  '- Responsive templates',
  '',
  '## 2. FEES & PAYMENT',
  '',
  'The **Client** shall pay **$5,000** on a net-30 basis.',
  '',
  '## 3. SIGNATURES',
  '',
  'IN WITNESS WHEREOF, the parties have executed this Agreement.',
  '',
].join('\n');

describe('markdownToDoc', () => {
  it('produces a doc node with the heading structure preserved', () => {
    const doc = markdownToDoc(LEGAL_SAMPLE);
    expect(doc.type).toBe('doc');
    expect(docSectionCount(doc)).toBe(4);
    expect(docFirstHeading(doc)).toBe('FREELANCE DEVELOPER AGREEMENT');
  });

  it('flattens tables into readable paragraphs', () => {
    const doc = markdownToDoc('## 1. FEES\n\n| Item | Amount |\n| --- | --- |\n| Deposit | 25% |\n');
    expect(docPlainText(doc)).toContain('Deposit');
    expect(docPlainText(doc)).toContain('25%');
  });

  it('turns empty markdown into an empty document', () => {
    const doc = markdownToDoc('');
    expect(doc.content).toEqual([{ type: 'paragraph' }]);
  });
});

describe('docToMarkdown', () => {
  it('round-trips headings, bold, and numbered lists', () => {
    const doc = markdownToDoc(LEGAL_SAMPLE);
    const markdown = docToMarkdown(doc);
    expect(markdown).toContain('# FREELANCE DEVELOPER AGREEMENT');
    expect(markdown).toContain('## 1. SERVICES');
    expect(markdown).toContain('**Client**');
    expect(markdown).toContain('**$5,000**');
    expect(markdown).toContain('1.1 Provider will deliver the landing page.');
  });

  it('round-trips marks like italic, strike, and code', () => {
    const md = 'Some *italic*, ~~struck~~, and `inline` text.';
    const doc = markdownToDoc(md);
    const back = docToMarkdown(doc);
    expect(back).toContain('*italic*');
    expect(back).toContain('~~struck~~');
    expect(back).toContain('`inline`');
  });

  it('serializes the empty document to empty markdown', () => {
    expect(docToMarkdown(EMPTY_DOCUMENT).trim()).toBe('');
  });
});

describe('signature detection', () => {
  it('detects a SIGNATURES heading', () => {
    const doc = markdownToDoc(LEGAL_SAMPLE);
    expect(docContainsSignatures(doc)).toBe(true);
  });

  it('does not report signatures for an ordinary document', () => {
    const doc = markdownToDoc('# HEADER\n\nBody content only.\n');
    expect(docContainsSignatures(doc)).toBe(false);
  });
});

describe('sectionContextAround', () => {
  it('returns the section containing a selection inside a numbered section', () => {
    const doc = markdownToDoc(LEGAL_SAMPLE);
    const start = docToMarkdown(doc).indexOf('1.1 Provider');
    const context = sectionContextAround(doc, start);
    expect(context).toContain('1. SERVICES');
    expect(context).toContain('1.1 Provider');
    expect(context).toContain('Hosting configuration');
    expect(context).not.toContain('FEES & PAYMENT');
  });

  it('returns preceding section context from a section without a heading', () => {
    const doc = markdownToDoc(
      '## 1. SERVICES\n\nPlain memory paragraph.\n\n## 2. FEES\n\nBody.\n',
    );
    const start = docToMarkdown(doc).indexOf('Plain memory paragraph');
    const context = sectionContextAround(doc, start);
    expect(context).toContain('1. SERVICES');
    expect(context).toContain('Plain memory paragraph');
    expect(context).not.toContain('FEES');
  });

  it('returns the preamble when no heading precedes the selection', () => {
    const doc = markdownToDoc(
      'Intro line about the deal.\n\n## 1. TERMS\n\nBody.\n',
    );
    const context = sectionContextAround(doc, 2);
    expect(context).not.toContain('TERMS');
    expect(context).toContain('Intro line');
  });

  it('truncates long sections to the given limit', () => {
    const doc = markdownToDoc(
      '## 1. LONG SECTION\n\n' + 'word '.repeat(600) + '\n',
    );
    const context = sectionContextAround(doc, 5, 100);
    expect(context.length).toBeLessThanOrEqual(101);
    expect(context.endsWith('…')).toBe(true);
  });
});

describe('buildContractPdfDoc', () => {
  it('builds a letter-size definition with Liberation Serif', () => {
    const doc = markdownToDoc(LEGAL_SAMPLE);
    const pdf = buildContractPdfDoc(doc, { fileName: 'freelance-developer-agreement' });
    expect(pdf.pageSize).toBe('LETTER');
    expect(pdf.pageMargins).toEqual([72, 78, 72, 96]);
    expect((pdf.styles as Record<string, { font?: string }>).body?.font).toBe('LiberationSerif');
  });

  it('emits the title, uppercase section headings, and a signature table', () => {
    const doc = markdownToDoc(LEGAL_SAMPLE);
    const pdf = buildContractPdfDoc(doc, { fileName: 'freelance-developer-agreement' });
    const serialized = JSON.stringify(pdf.content);
    expect(serialized).toContain('FREELANCE DEVELOPER AGREEMENT');
    expect(serialized).toContain('1. SERVICES');
    expect(serialized).toContain('FEES & PAYMENT');
    expect(serialized).toContain('CLIENT');
    expect(serialized).toContain('PROVIDER');
  });

  it('omits the signature table when the document has no signatures', () => {
    const doc = markdownToDoc('# HEADER\n\nPlain content.\n');
    const pdf = buildContractPdfDoc(doc, { fileName: 'plain' });
    expect(JSON.stringify(pdf.content)).not.toContain('CLIENT');
  });

  it('uses the file name when no title heading exists', () => {
    const doc = markdownToDoc('Just body text with no heading.');
    const pdf = buildContractPdfDoc(doc, { fileName: 'untitled-agreement' });
    expect(JSON.stringify(pdf.content)).toContain('UNTITLED-AGREEMENT');
  });

  it('provides header and footer renderers for page numbering', () => {
    const doc = markdownToDoc(LEGAL_SAMPLE);
    const pdf = buildContractPdfDoc(doc, { fileName: 'freelance-developer-agreement' });
    expect(typeof pdf.header).toBe('function');
    expect(typeof pdf.footer).toBe('function');
  });
});