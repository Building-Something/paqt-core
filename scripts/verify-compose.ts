import {
  markdownToDoc,
  docToMarkdown,
  docPlainText,
  docFirstHeading,
  docSectionCount,
  docContainsSignatures,
  buildContractPdfDoc,
  EMPTY_DOCUMENT,
} from '../src/utils/contractDocument';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(label);
    // eslint-disable-next-line no-console
    console.error(`FAIL: ${label}`);
  }
}

const SAMPLE = [
  '# FREELANCE DEVELOPER AGREEMENT',
  '',
  'THIS AGREEMENT is made between [Client Full Legal Name] ("Client") and [Provider Full Legal Name] ("Provider") as of the Effective Date.',
  '',
  '## 1. SERVICES',
  '',
  '1.1 Provider will deliver the landing page in accordance with the attached statement of work.',
  '',
  '- Scope includes responsive templates',
  '- Final code is owned by the Client',
  '',
  '## 2. FEES & PAYMENT',
  '',
  'The **Client** shall pay **$5,000** on a net-30 basis.',
  '',
  '| Item | Amount |',
  '| --- | --- |',
  '| Deposit | 25% |',
  '| Balance | 75% |',
  '',
  '## 3. SIGNATURES',
  '',
  'IN WITNESS WHEREOF, the parties have executed this Agreement as of the Effective Date.',
  '',
].join('\n');

{
  const root = markdownToDoc(SAMPLE);
  check('markdownToDoc returns a doc', root.type === 'doc');
  check('markdownToDoc preserves title heading', docPlainText(root).includes('FREELANCE DEVELOPER AGREEMENT'));
  check('markdownToDoc walks h2 sections', docSectionCount(root) === 4);
  check('markdownToDoc keeps ordered paragraphs', /1\.1 Provider will deliver/.test(docPlainText(root)));
  check('markdownToDoc keeps bullet items', docPlainText(root).includes('Scope includes responsive templates'));
  check('markdownToDoc flattens tables into text', docPlainText(root).includes('Deposit'));
  check('markdownToDoc marks bold text', docToMarkdown(root).includes('**Client**'));
  check('docContainsSignatures detects SIGNATURES', docContainsSignatures(root) === true);
  check('docFirstHeading returns title', docFirstHeading(root) === 'FREELANCE DEVELOPER AGREEMENT');

  const firstTitle = docFirstHeading(root);
  check('round-trip keeps heading text', firstTitle !== null && docToMarkdown(root).includes(firstTitle));
}

{
  const empty = EMPTY_DOCUMENT;
  check('empty document produces no markdown', docToMarkdown(empty).trim() === '');
  check('empty document has no title', docFirstHeading(empty) === null);
}

{
  const simple = '# Title\n\n## 1. PARTIES\n\nParty A and Party B.\n';
  const doc = markdownToDoc(simple);
  check('markdownToDoc on simple doc', doc.type === 'doc');
  check('round-trip simple', docToMarkdown(doc).includes('# Title'));
  check('round-trip section', docToMarkdown(doc).includes('## 1. PARTIES'));
  void doc;
}

{
  const nested = 'Nested:\n\n- One\n  - Two\n- Three\n';
  const doc = markdownToDoc(nested);
  check('nested list parses', doc.content?.some((child) => child.type === 'bulletList') ?? false);
}

{
  const doc = markdownToDoc('# Agreement\n\nBody text. *Italic* and ~~struck~~ and `code`.\n');
  const md = docToMarkdown(doc);
  check('italic mark serialized', md.includes('*Italic*'));
  check('strike mark serialized', md.includes('~~struck~~'));
  check('code mark serialized', md.includes('`code`'));
}

{
  const doc = markdownToDoc(SAMPLE);
  const pdf = buildContractPdfDoc(doc, { fileName: 'freelance-developer-agreement' });
  check('pdf pageSize LETTER', pdf.pageSize === 'LETTER');
  check('pdf defines LiberationSerif styles', typeof pdf.styles === 'object' && pdf.styles !== null);
  check('pdf body style uses serif font', (pdf.styles as Record<string, { font?: string }>).body?.font === 'LiberationSerif');
  check('pdf has content blocks', Array.isArray(pdf.content) && pdf.content.length > 0);
  check('pdf avoids dynamic header/footer', pdf.header === undefined && pdf.footer === undefined);
  check(
    'pdf content includes the section heading',
    JSON.stringify(pdf.content).includes('1. SERVICES') && JSON.stringify(pdf.content).includes('2. FEES & PAYMENT'),
  );
  check('pdf includes signature table', JSON.stringify(pdf.content).includes('IN WITNESS WHEREOF'));
  check('pdf margin is 1 inch legal-style', Array.isArray(pdf.pageMargins) && pdf.pageMargins[0] === 72);
}

// eslint-disable-next-line no-console
console.log(`\nverify-compose: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  // eslint-disable-next-line no-console
  console.error(failures.join('\n'));
  process.exit(1);
}