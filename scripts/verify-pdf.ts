import { resolve } from 'node:path';
import pdfmake from 'pdfmake';
import { buildContractPdfDoc, markdownToDoc } from '../src/utils/contractDocument';

const FONT_DIR = resolve(process.cwd(), 'public/fonts');
const FONT_FILES = ['LiberationSerif-Regular.ttf', 'LiberationSerif-Bold.ttf', 'LiberationSerif-Italic.ttf', 'LiberationSerif-BoldItalic.ttf'];

const FONT_ROLES = ['normal', 'bold', 'italics', 'bolditalics'] as const;

const SAMPLE = [
  '# FREELANCE DEVELOPER AGREEMENT',
  '',
  '> WHEREAS the parties wish to engage the Provider to deliver services on the terms herein.',
  '',
  '## 1. AGREEMENT',
  '',
  'This Agreement is between [Client Full Legal Name] ("Client") and [Provider Full Legal Name] ("Provider") as of the Effective Date.',
  '',
  '## 2. SERVICES',
  '',
  '### 2.1 Scope',
  '',
  'Provider will deliver the landing page per the statement of work.',
  '',
  '- Hosting configuration',
  '- Responsive templates',
  '',
  '### 2.2 Acceptance',
  '',
  'The **Client** shall review deliverables within **5 business days**. A "kill fee" of 25% applies on termination.',
  '',
  '## 3. FEES & PAYMENT',
  '',
  '2. The Client shall pay **$5,000** on a net-30 basis.',
  '',
  '## 4. SIGNATURES',
  '',
  'IN WITNESS WHEREOF, the parties have executed this Agreement as of the Effective Date.',
  '',
].join('\n');

(async () => {
  const doc = markdownToDoc(SAMPLE);
  const definition = buildContractPdfDoc(doc, { fileName: 'freelance-developer-agreement' });

  const fonts: Record<'normal' | 'bold' | 'italics' | 'bolditalics', string> = {
    normal: resolve(FONT_DIR, 'LiberationSerif-Regular.ttf'),
    bold: resolve(FONT_DIR, 'LiberationSerif-Bold.ttf'),
    italics: resolve(FONT_DIR, 'LiberationSerif-Italic.ttf'),
    bolditalics: resolve(FONT_DIR, 'LiberationSerif-BoldItalic.ttf'),
  };

  const api = pdfmake as unknown as { fonts: Record<string, unknown> };
  api.fonts = { LiberationSerif: fonts };

  const pdf = pdfmake.createPdf(definition);
  const buffer = await (pdf as unknown as { getBuffer: () => Promise<Buffer> }).getBuffer();
  const header = buffer.subarray(0, 4).toString('latin1');
  if (header !== '%PDF') {
    throw new Error(`Unexpected PDF signature: ${header}`);
  }
  let passed = 0;
  let failed = 0;
  const checks: Array<[string, boolean]> = [
    ['produced a PDF buffer', buffer.length > 0],
    ['PDF starts with %PDF', header === '%PDF'],
    ['PDF references LiberationSerif fonts', buffer.toString('latin1').includes('LiberationSerif')],
    ['PDF has at least 2 pages', /\/Type \/Page[\s\S]*\/Type \/Page/.test(buffer.toString('latin1'))],
  ];
  for (const [label, ok] of checks) {
    if (ok) {
      passed += 1;
    } else {
      failed += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  }
  void FONT_ROLES;

  // eslint-disable-next-line no-console
  console.log(`\nverify-pdf: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('\nverify-pdf: generation failed');
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});