import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, Content as MdastContent } from 'mdast';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { FONT_SAFE_CODEPOINTS } from './fontSafeCodepoints';

/**
 * A minimal, schema-agnostic representation of an editable document.
 * It is structurally compatible with TipTap's `JSONContent` (doc /
 * paragraph / heading / list / blockquote / codeBlock / horizontalRule /
 * hardBreak) plus the marks bold / italic / strike / code.
 */
export interface ContractMark {
  type: 'bold' | 'italic' | 'strike' | 'code';
}

export interface ContractDocNode {
  type: string;
  text?: string;
  content?: ContractDocNode[];
  marks?: ContractMark[];
  attrs?: Record<string, unknown>;
}

export const EMPTY_DOCUMENT: ContractDocNode = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

/* ------------------------------------------------------------------ */
/* Markdown -> editor document                                         */
/* ------------------------------------------------------------------ */

function inlineMarks(node: MdastContent): ContractMark[] {
  const marks: { bold: boolean; italic: boolean; strike: boolean; code: boolean } = {
    bold: false,
    italic: false,
    strike: false,
    code: false,
  };

  let current: MdastContent | null = node;
  const chain: MdastContent[] = [];
  while (current) {
    chain.unshift(current);
    const childrenOf = (current as unknown as { children?: readonly unknown[] }).children;
    if (Array.isArray(childrenOf) && childrenOf.length === 1) {
      current = childrenOf[0] as MdastContent;
    } else {
      current = null;
    }
  }

  for (const item of chain) {
    if (item.type === 'strong') marks.bold = true;
    if (item.type === 'emphasis') marks.italic = true;
    if (item.type === 'delete') marks.strike = true;
    if (item.type === 'inlineCode') marks.code = true;
  }

  const result: ContractMark[] = [];
  if (marks.bold) result.push({ type: 'bold' });
  if (marks.italic) result.push({ type: 'italic' });
  if (marks.strike) result.push({ type: 'strike' });
  if (marks.code) result.push({ type: 'code' });
  return result;
}

function sanitizeContractText(value: string): string {
  let cleaned = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (
      code === 0x0009 ||
      code === 0x000a ||
      code === 0x000d ||
      FONT_SAFE_CODEPOINTS.has(code)
    ) {
      cleaned += char;
    }
  }
  return cleaned;
}

function mdastInline(node: MdastContent): string {
  if (!node || node.type === 'html' || node.type === 'image') {
    return '';
  }
  switch (node.type) {
    case 'text':
      return sanitizeContractText((node as { value: string }).value);
    case 'inlineCode':
      return sanitizeContractText((node as { value: string }).value);
    case 'break':
      return '\n';
    case 'link': {
      const link = node as { children?: MdastContent[] };
      return (link.children ?? []).map(mdastInline).join('');
    }
    default: {
      const anyNode = node as { children?: MdastContent[] };
      if (Array.isArray(anyNode.children)) {
        return anyNode.children.map(mdastInline).join('');
      }
      return '';
    }
  }
}

function mdastInlineNodes(node: MdastContent): ContractDocNode[] {
  const value = mdastInline(node);
  if (!value && node.type !== 'break' && node.type !== 'text') {
    return [];
  }

  const marks = inlineMarks(node);
  if (node.type === 'break' && marks.length === 0) {
    return [{ type: 'hardBreak' }];
  }
  const base: ContractDocNode = { type: 'text', text: value };
  if (marks.length > 0) {
    base.marks = marks;
  }
  return [base];
}

function mdastChildren(node: MdastContent): MdastContent[] {
  const anyNode = node as { children?: MdastContent[] };
  return Array.isArray(anyNode.children) ? anyNode.children : [];
}

function tableToParagraphs(node: MdastContent): ContractDocNode[] {
  const rows = mdastChildren(node).filter((child) => child.type === 'tableRow');
  const paragraphs: ContractDocNode[] = [];
  for (const row of rows) {
    const cells = mdastChildren(row).filter((child) => child.type === 'tableCell');
    const joined = cells.map((cell) => mdastInline(cell as MdastContent)).join('  ·  ');
    if (joined.trim()) {
      paragraphs.push({ type: 'paragraph', content: [{ type: 'text', text: joined.trim() }] });
    }
  }
  return paragraphs;
}

function mdastToDocNode(node: MdastContent): ContractDocNode[] {
  switch (node.type) {
    case 'heading': {
      const heading = node as { depth: number };
      return [
        {
          type: 'heading',
          attrs: { level: Math.min(Math.max(heading.depth, 1), 6) },
          content: mdastChildren(node).flatMap(mdastInlineNodes),
        },
      ];
    }
    case 'paragraph':
      return [{ type: 'paragraph', content: mdastChildren(node).flatMap(mdastInlineNodes) }];
    case 'list': {
      const list = node as { ordered?: boolean | null; start?: number | null };
      const ordered = list.ordered === true;
      const content = mdastChildren(node).map((item) => ({
        type: 'listItem',
        content: mdastToDocNode(item),
      }));
      return [
        ordered
          ? {
              type: 'orderedList',
              attrs: list.start && list.start !== 1 ? { start: list.start } : undefined,
              content,
            }
          : { type: 'bulletList', content },
      ];
    }
    case 'listItem':
      return mdastChildren(node).flatMap(mdastToDocNode);
    case 'blockquote':
      return [
        {
          type: 'blockquote',
          content: mdastChildren(node).flatMap(mdastToDocNode),
        },
      ];
    case 'code': {
      const code = node as { value: string };
      return [{ type: 'codeBlock', content: [{ type: 'text', text: code.value.replace(/\n$/, '') }] }];
    }
    case 'thematicBreak':
      return [{ type: 'horizontalRule' }];
    case 'table':
      return tableToParagraphs(node);
    case 'html':
    case 'image':
    case 'definition':
    case 'footnoteDefinition':
    case 'footnoteReference':
    case 'yaml':
      return [];
    default:
      return mdastChildren(node).flatMap(mdastToDocNode);
  }
}

export function markdownToDoc(markdown: string): ContractDocNode {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  const content = mdastToDocNode(tree as unknown as MdastContent);
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}

/* ------------------------------------------------------------------ */
/* Editor document -> markdown                                         */
/* ------------------------------------------------------------------ */

function inlineToMarkdown(node: ContractDocNode): string {
  if (node.type === 'hardBreak') {
    return '  \n';
  }
  let text = node.text ?? '';
  const marks = node.marks ?? [];
  const markTypes = new Set(marks.map((mark) => mark.type));
  if (markTypes.has('code')) {
    text = `\`${text}\``;
  }
  if (markTypes.has('strike')) {
    text = `~~${text}~~`;
  }
  if (markTypes.has('italic')) {
    text = `*${text}*`;
  }
  if (markTypes.has('bold')) {
    text = `**${text}**`;
  }
  return text;
}

function childrenToMarkdown(node: ContractDocNode): string {
  return (node.content ?? []).map(childToMarkdown).join('');
}

function childToMarkdown(node: ContractDocNode): string {
  switch (node.type) {
    case 'doc':
      return childrenToMarkdown(node).replace(/\n{3,}/g, '\n\n');
    case 'paragraph':
      return `${(node.content ?? []).map(inlineToMarkdown).join('')}\n\n`;
    case 'heading': {
      const level = Number((node.attrs as { level?: number } | undefined)?.level ?? 1);
      return `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${(node.content ?? [])
        .map(inlineToMarkdown)
        .join('')}\n\n`;
    }
    case 'bulletList':
    case 'orderedList': {
      const ordered = node.type === 'orderedList';
      const start = Number((node.attrs as { start?: number } | undefined)?.start ?? 1);
      let counter = start;
      const lines: string[] = [];
      for (const item of node.content ?? []) {
        const marker = ordered ? `${counter}.` : '-';
        counter += 1;
        const [firstLine, ...rest] = itemBodyLines(item);
        lines.push(`${marker} ${firstLine}`);
        for (const extra of rest) {
          lines.push(`  ${extra}`);
        }
      }
      return `${lines.join('\n')}\n\n`;
    }
    case 'listItem':
      return childrenToMarkdown(node);
    case 'blockquote': {
      const inner = (node.content ?? []).map(childToMarkdown).join('');
      const lines = inner.replace(/\n+$/, '').split('\n');
      return `${lines.map((line) => `> ${line}`).join('\n')}\n\n`;
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map((child) => child.text ?? '').join('');
      return `\`\`\`\n${text.endsWith('\n') ? text.slice(0, -1) : text}\n\`\`\`\n\n`;
    }
    case 'horizontalRule':
      return `---\n\n`;
    case 'text':
    case 'hardBreak':
      return inlineToMarkdown(node);
    default:
      return childrenToMarkdown(node);
  }
}

function itemBodyLines(item: ContractDocNode): string[] {
  const lines: string[] = [];
  const textContent = item.content ?? [];
  for (const child of textContent) {
    if (child.type === 'paragraph') {
      lines.push(...(child.content ?? []).map(inlineToMarkdown).join('').split('\n'));
    } else if (child.type === 'bulletList' || child.type === 'orderedList') {
      const rendered = childToMarkdown(child).trim();
      lines.push(...rendered.split('\n'));
    } else if (child.type === 'text' || child.type === 'hardBreak') {
      lines.push(...inlineToMarkdown(child).split('\n'));
    }
  }
  return lines;
}

export function docToMarkdown(node: ContractDocNode): string {
  const markdown = childToMarkdown(node).replace(/\n{3,}/g, '\n\n').trim();
  return markdown ? `${markdown}\n` : '';
}

/* ------------------------------------------------------------------ */
/* Plain text + document metadata                                      */
/* ------------------------------------------------------------------ */

export function docPlainText(node: ContractDocNode): string {
  if (node.type === 'text') {
    return node.text ?? '';
  }
  if (node.type === 'hardBreak') {
    return '\n';
  }
  return (node.content ?? []).map(docPlainText).join('');
}

function collectNodes(node: ContractDocNode, type: string, out: ContractDocNode[]): void {
  if (node.type === type) {
    out.push(node);
  }
  for (const child of node.content ?? []) {
    collectNodes(child, type, out);
  }
}

export function docFirstHeading(node: ContractDocNode): string | null {
  const headings: ContractDocNode[] = [];
  collectNodes(node, 'heading', headings);
  const first = headings[0];
  if (!first) {
    return null;
  }
  const text = docPlainText(first).trim();
  return text.length > 0 ? text : null;
}

export function docSectionCount(node: ContractDocNode): number {
  const headings: ContractDocNode[] = [];
  collectNodes(node, 'heading', headings);
  let count = 0;
  for (const heading of headings) {
    const level = Number((heading.attrs as { level?: number } | undefined)?.level ?? 1);
    if (level <= 2) {
      count += 1;
    }
  }
  return count;
}

export function docContainsSignatures(node: ContractDocNode): boolean {
  const headings: ContractDocNode[] = [];
  collectNodes(node, 'heading', headings);
  return headings.some((heading) => /SIGNATURE|EXECUTION/i.test(docPlainText(heading)));
}

function nodeTextLength(node: ContractDocNode): number {
  if (node.type === 'text') {
    return (node.text ?? '').length;
  }
  if (node.type === 'hardBreak') {
    return 1;
  }
  return (node.content ?? []).reduce((sum, child) => sum + nodeTextLength(child), 0);
}

function blockHeadingLevel(node: ContractDocNode): number | null {
  if (node.type !== 'heading') {
    return null;
  }
  return Number((node.attrs as { level?: number } | undefined)?.level ?? 1);
}

export function sectionContextAround(
  doc: ContractDocNode,
  from: number,
  limit = 2400,
): string {
  const blocks = doc.content ?? [];
  const offsets: { node: ContractDocNode; start: number; end: number }[] = [];
  let cursor = 0;
  for (const block of blocks) {
    const length = nodeTextLength(block);
    offsets.push({ node: block, start: cursor, end: cursor + length });
    cursor += length;
  }
  if (offsets.length === 0) {
    return '';
  }

  const anchor = Math.min(Math.max(from, 0), cursor);
  const matched = offsets.findIndex(
    (entry) => anchor >= entry.start && anchor <= entry.end,
  );
  const target = matched === -1 ? offsets.length - 1 : matched;

  let startIndex = target;
  let anchorLevel = blockHeadingLevel(offsets[target].node);
  if (anchorLevel === null) {
    for (let i = target - 1; i >= 0; i -= 1) {
      const level = blockHeadingLevel(offsets[i].node);
      if (level !== null) {
        startIndex = i;
        anchorLevel = level;
        break;
      }
    }
    if (anchorLevel === null) {
      startIndex = 0;
      anchorLevel = 0;
    }
  }

  let endIndex = offsets.length - 1;
  for (let i = startIndex + 1; i < offsets.length; i += 1) {
    const level = blockHeadingLevel(offsets[i].node);
    if (level !== null && (anchorLevel === 0 || level <= anchorLevel)) {
      endIndex = i - 1;
      break;
    }
  }

  const selected = offsets
    .slice(startIndex, endIndex + 1)
    .filter((entry) => docPlainText(entry.node).trim().length > 0);
  const markdown = selected.map((entry) => childToMarkdown(entry.node)).join('');
  const cleaned = markdown.replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length <= limit) {
    return cleaned;
  }
  return `${cleaned.slice(0, limit).trimEnd()}…`;
}

/* ------------------------------------------------------------------ */
/* PDF document (pdfmake)                                              */
/* ------------------------------------------------------------------ */

export const DRAFT_DISCLAIMER_LINE =
  'This draft is a starting point, not legal advice. Have qualified counsel review it before signing.';

export interface ContractSignature {
  dataUrl: string;
  name?: string;
}

export interface ContractSignatures {
  client?: ContractSignature;
  provider?: ContractSignature;
}

export interface ContractPdfMeta {
  fileName?: string;
  signatures?: ContractSignatures;
}

interface PdfTextSegment {
  text: string;
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  decoration?: 'underline' | 'lineThrough';
  color?: string;
}

interface PdfBlock {
  text?: PdfTextSegment | PdfTextSegment[] | string;
  style?: string;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  margin?: [number, number, number, number];
  fontSize?: number;
  lineHeight?: number;
  bold?: boolean;
  italics?: boolean;
  characterSpacing?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  stack?: PdfBlock[];
  columns?: PdfBlock[];
  width?: string;
  image?: string;
  fit?: [number, number];
  canvas?: Array<Record<string, number | string>>;
  layout?: string;
  table?: { widths: Array<string | number>; body: Array<Array<unknown>> };
  keepWithNext?: boolean;
}

function inlineToSegments(node: ContractDocNode): PdfTextSegment[] {
  if (node.type === 'hardBreak') {
    return [];
  }
  const text = sanitizeContractText(node.text ?? '');
  const marks = node.marks ?? [];
  const types = new Set(marks.map((mark) => mark.type));
  const placeholder = /\[[A-Za-z][^\]\n]*\]/.test(text);
  const segment: PdfTextSegment = {
    text,
    ...(types.has('bold') ? { bold: true } : {}),
    ...(types.has('italic') ? { italics: true } : {}),
    ...(types.has('strike') ? { decoration: 'lineThrough' as const } : {}),
    ...(placeholder ? { color: '#8a5a00' } : {}),
  };
  const result: PdfTextSegment[] = [];
  if (types.has('code')) {
    result.push({ text: ' `', color: '#334155' }, segment, { text: '` ', color: '#334155' });
  } else {
    result.push(segment);
  }
  return result;
}

function collectInline(node: ContractDocNode, out: PdfTextSegment[]): void {
  if (node.type === 'text' || node.type === 'hardBreak') {
    out.push(...inlineToSegments(node));
    return;
  }
  for (const child of node.content ?? []) {
    collectInline(child, out);
  }
}

const SIGNATURE_HEADING = /SIGNATURE|EXECUTION/i;

function listMarker(level: number, number: number): string {
  if (level === 1) {
    return `${number}.`;
  }
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  if (level === 2) {
    return `(${letters[(number - 1) % 26]})`;
  }
  if (level === 3) {
    const digits = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv'];
    return `(${digits[(number - 1) % digits.length]})`;
  }
  return `${number}.`;
}

function blockHeading(level: number, segments: PdfTextSegment[]): PdfBlock {
  const text = level === 2 ? segments.map((segment) => ({ ...segment, text: segment.text.toUpperCase() })) : segments;
  return {
    text,
    style: level === 1 ? 'title' : level === 2 ? 'sectionHeading' : 'subHeading',
    ...(level === 1 ? { alignment: 'center' as const } : {}),
    keepWithNext: true,
  };
}

function blockParagraph(segments: PdfTextSegment[], alignment: 'left' | 'center' | 'right' | 'justify'): PdfBlock {
  return {
    text: segments,
    style: 'body',
    alignment,
  };
}

function blockList(item: ContractDocNode, level: number, ordered: boolean, start: number): PdfBlock {
  let counter = start;
  const rendered: Array<{ marker: string; segments: PdfTextSegment[]; nested: PdfBlock[] }> = [];
  for (const listItem of item.content ?? []) {
    const segments: PdfTextSegment[] = [
      { text: ordered ? `${listMarker(level, counter)} ` : '\u2013 ', bold: true },
    ];
    const nested: PdfBlock[] = [];
    for (const child of listItem.content ?? []) {
      if (child.type === 'paragraph') {
        const line: PdfTextSegment[] = [];
        collectInline(child, line);
        segments.push(...line);
      } else if (child.type === 'bulletList' || child.type === 'orderedList') {
        nested.push(blockList(child, level + 1, child.type === 'orderedList', 1));
      } else if (child.type === 'blockquote') {
        const quote: PdfTextSegment[] = [];
        collectInline(child, quote);
        nested.push(blockParagraph(quote, 'justify'));
      }
    }
    rendered.push({ marker: segments.length > 1 ? '' : '', segments, nested });
    counter += 1;
  }

  const margin = 18 + (level - 1) * 14;
  return {
    stack: rendered.flatMap((entry) => [
      { text: entry.segments, style: 'listItem', margin: [margin, 0, 0, 4] as [number, number, number, number] },
      ...entry.nested,
    ]),
  };
}

function signatureCell(sig?: ContractSignature): PdfBlock {
  const stack: PdfBlock[] = [];
  if (sig?.dataUrl) {
    stack.push({
      image: sig.dataUrl,
      fit: [130, 45] as [number, number],
      alignment: 'left',
      margin: [0, 2, 0, 4],
    } as PdfBlock);
  } else {
    stack.push({ text: '____________________________' });
  }
  stack.push(
    { text: [{ text: 'By: ', bold: true }], margin: [0, 6, 0, 0] },
    {
      text:
        sig?.name && sig.name.trim().length > 0
          ? [{ text: sig.name, bold: false }]
          : '____________________________',
      margin: [0, 2, 0, 0],
    },
    { text: [{ text: 'Name: ', bold: true }], margin: [0, 6, 0, 0] },
    { text: '____________________________' },
    { text: [{ text: 'Title: ', bold: true }], margin: [0, 6, 0, 0] },
    { text: '____________________________' },
  );
  return { stack };
}

function signatureTable(signatures?: ContractSignatures): PdfBlock {
  const label = (text: string): { text: PdfTextSegment[] } => ({
    text: [{ text, bold: true }],
  });
  return {
    margin: [0, 14, 0, 0],
    table: {
      widths: ['*', '*'],
      body: [
        [label('CLIENT'), label('PROVIDER')],
        [signatureCell(signatures?.client), signatureCell(signatures?.provider)],
      ],
    },
  };
}

function docToPdfBlocks(node: ContractDocNode, signatures?: ContractSignatures): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  let signaturePending = false;
  let titleSkipped = false;
  let inSignatureSection = false;
  let signatureTableEmitted = false;

  const isDisclaimer = (segments: PdfTextSegment[]): boolean =>
    segments.map((segment) => segment.text).join('').replace(/\s+/g, ' ').trim() ===
    DRAFT_DISCLAIMER_LINE.replace(/\s+/g, ' ').trim();

  const isSignatureField = (plain: string): boolean => {
    if (!plain) {
      return false;
    }
    if (/^[\s_\-–—.,]+$/.test(plain)) {
      return true;
    }
    return (
      /^(CLIENT|PROVIDER|BUYER|SELLER|CUSTOMER|SERVICE PROVIDER|DEVELOPER|COMPANY|CONTRACTOR|CONSULTANT|VENDOR|SUPPLIER|EMPLOYER|EMPLOYEE|FREELANCER|DESIGNER|AGENCY|TENANT|LANDLORD|OWNER|LICENSOR|LICENSEE|PART(Y|IES)|DATED|DATE|EXECUTED)\b/i.test(
        plain,
      ) ||
      /^(By|Name|Title|Signature|Witness|Address|Email|Phone)\s*[:]?\b/i.test(plain)
    );
  };

  const dropSignatureBlock = (): boolean => inSignatureSection && signatureTableEmitted;

  const visit = (child: ContractDocNode, listLevel = 0): void => {
    switch (child.type) {
      case 'paragraph': {
        if (dropSignatureBlock()) {
          break;
        }
        const segments: PdfTextSegment[] = [];
        collectInline(child, segments);
        if (segments.length === 0) {
          blocks.push({ text: '\u00A0', style: 'body', fontSize: 4 });
          break;
        }
        if (isDisclaimer(segments)) {
          break;
        }
        if (inSignatureSection) {
          const plain = segments
            .map((segment) => segment.text)
            .join('')
            .replace(/\s+/g, ' ')
            .trim();
          if (isSignatureField(plain)) {
            break;
          }
        }
        const alignment = (child.attrs as { textAlign?: 'left' | 'center' | 'right' | 'justify' } | undefined)
          ?.textAlign;
        blocks.push(blockParagraph(segments, alignment ?? 'justify'));
        if (signaturePending) {
          blocks.push(signatureTable(signatures));
          signatureTableEmitted = true;
          signaturePending = false;
        }
        break;
      }
      case 'heading': {
        const level = Number((child.attrs as { level?: number } | undefined)?.level ?? 1);
        const segments: PdfTextSegment[] = [];
        collectInline(child, segments);
        const text = segments.map((segment) => segment.text).join('');
        if (level === 1 && !titleSkipped) {
          titleSkipped = true;
          break;
        }
        if (signaturePending) {
          blocks.push(signatureTable(signatures));
          signatureTableEmitted = true;
          signaturePending = false;
        }
        if (level <= 2) {
          inSignatureSection = SIGNATURE_HEADING.test(text);
        }
        if (level === 2 && SIGNATURE_HEADING.test(text)) {
          signaturePending = true;
        }
        blocks.push(blockHeading(level, segments));
        break;
      }
      case 'bulletList':
        blocks.push(blockList(child, listLevel + 1, false, 1));
        break;
      case 'orderedList': {
        const start = Number((child.attrs as { start?: number } | undefined)?.start ?? 1);
        blocks.push(blockList(child, listLevel + 1, true, start));
        break;
      }
      case 'listItem':
        for (const grandchild of child.content ?? []) {
          visit(grandchild, listLevel);
        }
        break;
      case 'blockquote': {
        if (dropSignatureBlock()) {
          break;
        }
        const segments: PdfTextSegment[] = [];
        collectInline(child, segments);
        if (segments.length > 0) {
          blocks.push({ text: segments, style: 'blockquote', alignment: 'justify' });
        }
        break;
      }
      case 'codeBlock': {
        const text = (child.content ?? []).map((line) => line.text ?? '').join('\n');
        blocks.push({ text, style: 'code', alignment: 'left' });
        break;
      }
      case 'horizontalRule':
        blocks.push({
          canvas: [{ type: 'line', x1: 0, y1: 0, x2: 536, y2: 0, lineWidth: 0.5 }],
          margin: [0, 10, 0, 10],
        });
        break;
      case 'text':
      case 'hardBreak':
      case 'doc':
      default:
        for (const grandchild of child.content ?? []) {
          visit(grandchild, listLevel);
        }
        break;
    }
  };

  for (const child of node.content ?? []) {
    visit(child, 0);
  }
  if (signaturePending) {
    blocks.push(signatureTable(signatures));
    signatureTableEmitted = true;
  }
  return blocks;
}

export function stripDraftDisclaimer(node: ContractDocNode): ContractDocNode {
  const disclaimer = DRAFT_DISCLAIMER_LINE.replace(/\s+/g, ' ').trim();
  const cleanBlock = (block: ContractDocNode): ContractDocNode | null => {
    if (block.type === 'paragraph') {
      const text = docPlainText(block).replace(/\s+/g, ' ').trim();
      if (text === disclaimer) {
        return null;
      }
    }
    if (block.content) {
      const cleaned = block.content
        .map(cleanBlock)
        .filter((child): child is ContractDocNode => child !== null);
      return cleaned.length === block.content.length
        ? block
        : { ...block, content: cleaned };
    }
    return block;
  };
  return cleanBlock(node) ?? EMPTY_DOCUMENT;
}

export function buildContractPdfDoc(node: ContractDocNode, meta: ContractPdfMeta): TDocumentDefinitions {
  const title = sanitizeContractText((docFirstHeading(node)?.trim() || meta.fileName || 'Agreement').trim());
  const contentBlocks = docToPdfBlocks(node, meta.signatures);

  const styles: TDocumentDefinitions['styles'] = {
    title: {
      font: 'LiberationSerif',
      fontSize: 16,
      bold: true,
      alignment: 'center',
      margin: [0, 0, 0, 12],
    },
    sectionHeading: {
      font: 'LiberationSerif',
      fontSize: 11.5,
      bold: true,
      margin: [0, 14, 0, 7],
    },
    subHeading: {
      font: 'LiberationSerif',
      fontSize: 11,
      bold: true,
      margin: [0, 10, 0, 5],
    },
    body: {
      font: 'LiberationSerif',
      fontSize: 10.5,
      lineHeight: 1.45,
      alignment: 'justify',
      margin: [0, 0, 0, 7],
    },
    listItem: {
      font: 'LiberationSerif',
      fontSize: 10.5,
      lineHeight: 1.45,
      alignment: 'justify',
      margin: [0, 0, 0, 4],
    },
    blockquote: {
      font: 'LiberationSerif',
      fontSize: 10.5,
      lineHeight: 1.45,
      italics: true,
      alignment: 'justify',
      margin: [26, 2, 0, 8],
      color: '#374151',
    },
    code: {
      font: 'LiberationSerif',
      fontSize: 8.5,
      color: '#334155',
      background: '#f8fafc',
      margin: [0, 4, 0, 8],
      lineHeight: 1.3,
    },
  };

  return {
    pageSize: 'LETTER',
    pageMargins: [72, 78, 72, 96],
    info: {
      title: title,
      author: 'Paqt',
      subject: 'Contract draft generated by Paqt',
      keywords: 'contract, agreement, draft',
      creator: 'Paqt',
    },
    content: [
      {
        text: title.toUpperCase(),
        style: 'title',
      },
      {
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: 536, y2: 0, lineWidth: 0.5 }],
        margin: [0, 0, 0, 14] as [number, number, number, number],
      },
      ...(contentBlocks as unknown as TDocumentDefinitions['content'][]),
    ],
    defaultStyle: {
      font: 'LiberationSerif',
    },
    styles,
  };
}