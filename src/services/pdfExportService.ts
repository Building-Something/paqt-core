import {
  buildContractPdfDoc,
  type ContractDocNode,
  type ContractPdfMeta,
} from '../utils/contractDocument';

type PdfMakeApi = typeof import('pdfmake');

type FontFile = {
  key: string;
  role: 'normal' | 'bold' | 'italics' | 'bolditalics';
};

const FONT_FILES: FontFile[] = [
  { key: 'LiberationSerif-Regular.ttf', role: 'normal' },
  { key: 'LiberationSerif-Bold.ttf', role: 'bold' },
  { key: 'LiberationSerif-Italic.ttf', role: 'italics' },
  { key: 'LiberationSerif-BoldItalic.ttf', role: 'bolditalics' },
];

function sanitizeFileName(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return `${base || 'contract'}.pdf`;
}

async function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

let fontsReady: Promise<void> | null = null;

function resolveApi(mod: unknown): PdfMakeApi {
  const candidate = mod as { default?: PdfMakeApi };
  return candidate.default ?? (mod as PdfMakeApi);
}

async function ensureFonts(api: PdfMakeApi): Promise<void> {
  if (!fontsReady) {
    fontsReady = (async () => {
      const vfs: Record<string, string> = {};
      const fontMap: Record<'normal' | 'bold' | 'italics' | 'bolditalics', string> = {
        normal: '',
        bold: '',
        italics: '',
        bolditalics: '',
      };
      for (const file of FONT_FILES) {
        const response = await fetch(`/fonts/${file.key}`);
        if (!response.ok) {
          throw new Error(`Failed to fetch contract font: ${file.key}`);
        }
        const base64 = await arrayBufferToBase64(await response.arrayBuffer());
        vfs[file.key] = base64;
        fontMap[file.role] = file.key;
      }
      api.addVirtualFileSystem(vfs);
      api.setFonts({ LiberationSerif: fontMap });
    })().catch((error) => {
      fontsReady = null;
      throw error;
    });
  }
  return fontsReady;
}

export async function exportContractPdf(doc: ContractDocNode, meta: ContractPdfMeta): Promise<void> {
  const mod = await import('pdfmake');
  const api = resolveApi(mod);
  await ensureFonts(api);
  const definition = buildContractPdfDoc(doc, meta);
  const pdf = api.createPdf(definition);
  await pdf.download(sanitizeFileName(meta.fileName ?? 'contract'));
}