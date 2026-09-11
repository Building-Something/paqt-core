import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, Content as MdastContent } from 'mdast';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

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

function mdastInline(node: MdastContent): string {
  if (!node || node.type === 'html' || node.type === 'image') {
    return '';
  }
  switch (node.type) {
    case 'text':
      return (node as { value: string }).value;
    case 'inlineCode':
      return (node as { value: string }).value;
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

export interface ContractPdfMeta {
  fileName?: string;
  reviewNotice?: string;
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
  canvas?: Array<Record<string, number | string>>;
  layout?: string;
  table?: { widths: Array<string | number>; body: Array<Array<unknown>> };
  keepWithNext?: boolean;
}

function inlineToSegments(node: ContractDocNode): PdfTextSegment[] {
  if (node.type === 'hardBreak') {
    return [];
  }
  const text = node.text ?? '';
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

function signatureTable(): PdfBlock {
  const label = (text: string): { text: PdfTextSegment[] } => ({
    text: [{ text, bold: true }],
  });
  const blank = (): string => '____________________________';
  return {
    margin: [0, 14, 0, 0] as [number, number, number, number],
    table: {
      widths: ['*', '*'],
      body: [
        [label('CLIENT'), label('PROVIDER')],
        [blank(), blank()],
        [label('By:'), label('By:')],
        ['', ''],
        [label('Name:'), label('Name:')],
        ['', ''],
        [label('Title:'), label('Title:')],
        ['', ''],
        [label('Date:'), label('Date:')],
        ['', ''],
      ],
    },
  };
}

function docToPdfBlocks(node: ContractDocNode): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  let signaturePending = false;

  const visit = (child: ContractDocNode, listLevel = 0): void => {
    switch (child.type) {
      case 'paragraph': {
        const segments: PdfTextSegment[] = [];
        collectInline(child, segments);
        if (segments.length === 0) {
          blocks.push({ text: '\u00A0', style: 'body', fontSize: 4 });
          break;
        }
        const alignment = (child.attrs as { textAlign?: 'left' | 'center' | 'right' | 'justify' } | undefined)
          ?.textAlign;
        blocks.push(blockParagraph(segments, alignment ?? 'justify'));
        if (signaturePending) {
          blocks.push(signatureTable());
          signaturePending = false;
        }
        break;
      }
      case 'heading': {
        const level = Number((child.attrs as { level?: number } | undefined)?.level ?? 1);
        const segments: PdfTextSegment[] = [];
        collectInline(child, segments);
        if (signaturePending) {
          blocks.push(signatureTable());
          signaturePending = false;
        }
        const text = segments.map((segment) => segment.text).join('');
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
    blocks.push(signatureTable());
  }
  return blocks;
}

export function buildContractPdfDoc(node: ContractDocNode, meta: ContractPdfMeta): TDocumentDefinitions {
  const title = (docFirstHeading(node)?.trim() || meta.fileName || 'Agreement').trim();
  const contentBlocks = docToPdfBlocks(node);

  const styles: TDocumentDefinitions['styles'] = {
    title: {
      font: 'LiberationSerif',
      fontSize: 16,
      bold: true,
      alignment: 'center',
      characterSpacing: 0.4,
      margin: [0, 0, 0, 12],
    },
    sectionHeading: {
      font: 'LiberationSerif',
      fontSize: 11.5,
      bold: true,
      characterSpacing: 0.3,
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
    footerText: {
      font: 'LiberationSerif',
      fontSize: 8,
      color: '#6b7280',
    },
    headerText: {
      font: 'LiberationSerif',
      fontSize: 8,
      color: '#6b7280',
      bold: true,
      characterSpacing: 0.4,
    },
  };

  const titleCase = (value: string): string =>
    value.replace(/\b\p{L}/gu, (char) => char.toUpperCase());

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
    header: (currentPage) =>
      currentPage > 1
        ? {
            columns: [
              {
                text: title.toUpperCase(),
                style: 'headerText',
                alignment: 'left',
                width: '*',
              },
              {
                text: 'DRAFT',
                style: 'headerText',
                alignment: 'right',
                width: 'auto',
              },
            ],
            margin: [72, 20, 72, 0] as [number, number, number, number],
          }
        : null,
    footer: (currentPage, pageCount) => ({
      columns: [
        {
          text: meta.reviewNotice ?? 'Paqt draft \u2014 not legal advice',
          style: 'footerText',
          alignment: 'left',
          width: '*',
        },
        {
          text: `Page ${currentPage} of ${pageCount}`,
          style: 'footerText',
          alignment: 'right',
          width: 'auto',
        },
      ],
      margin: [72, 0, 72, 20] as [number, number, number, number],
    }),
    content: [
      {
        text: title.toUpperCase(),
        style: 'title',
      },
      {
        text: titleCase(meta.fileName || 'Draft Agreement'),
        style: 'subTitle',
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