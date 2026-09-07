import type { PdfPage } from '../types';

export interface DraftSection {
  pageNumber: number;
  heading: string;
  text: string;
}

const HEADING_REGEX = /^#{1,6}\s+(.+)$/;
const SECTION_CHAR_LIMIT = 2500;

function chunkPlainText(markdown: string): DraftSection[] {
  const paragraphs = markdown
    .replace(/^\uFEFF/, '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const sections: { heading: string; text: string }[] = [];
  for (const paragraph of paragraphs) {
    const current = sections[sections.length - 1];
    const currentLength = current ? current.text.length : 0;
    if (current && currentLength + paragraph.length <= SECTION_CHAR_LIMIT) {
      current.text = [current.text, paragraph].filter(Boolean).join('\n\n');
      continue;
    }
    if (paragraph.length <= SECTION_CHAR_LIMIT) {
      sections.push({ heading: `Part ${sections.length + 1}`, text: paragraph });
      continue;
    }
    // Very long paragraph without paragraph breaks: hard-slice it.
    for (let offset = 0; offset < paragraph.length; offset += SECTION_CHAR_LIMIT) {
      sections.push({
        heading: `Part ${sections.length + 1}`,
        text: paragraph.slice(offset, offset + SECTION_CHAR_LIMIT).trim(),
      });
    }
  }
  return sections.map((section, index) => ({
    pageNumber: index + 1,
    heading: section.heading,
    text: section.text,
  }));
}

export function splitDraftIntoSections(markdown: string): DraftSection[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  let hasHeadings = false;
  for (const line of lines) {
    if (HEADING_REGEX.test(line)) {
      hasHeadings = true;
      break;
    }
  }
  if (!hasHeadings) {
    return chunkPlainText(markdown);
  }

  const sections: { heading: string; body: string[] }[] = [];
  const intro: string[] = [];
  let current: { heading: string; body: string[] } | null = null;

  for (const line of lines) {
    const match = line.match(HEADING_REGEX);
    if (match) {
      if (current) {
        sections.push(current);
      }
      current = { heading: match[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      intro.push(line);
    }
  }
  if (current) {
    sections.push(current);
  }

  const ordered: { heading: string; body: string[] }[] = [];
  if (intro.some((line) => line.trim().length > 0)) {
    ordered.push({ heading: 'Preamble', body: intro });
  }
  ordered.push(...sections);

  if (ordered.length === 0) {
    return [
      {
        pageNumber: 1,
        heading: 'Contract',
        text: markdown.trim(),
      },
    ];
  }

  return ordered
    .map((section, index) => ({
      pageNumber: index + 1,
      heading: section.heading,
      text: section.body.join('\n').trim(),
    }))
    .filter((section) => section.text.length > 0 || section.heading === 'Preamble');
}

export function buildDraftPages(sections: DraftSection[]): PdfPage[] {
  return sections.map((section) => ({
    pageNumber: section.pageNumber,
    text:
      section.text.trim().length > 0
        ? `${section.heading}\n${section.text}`.trim()
        : section.heading,
  }));
}