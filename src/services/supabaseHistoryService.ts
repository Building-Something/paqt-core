import { supabase } from '../lib/supabase';
import type { ContractAnalysis, PdfPage } from '../types';
import type { ContractSignatures } from '../utils/contractDocument';
import type { HistoryEntry, HistoryKind } from './historyService';

/**
 * Cloud backend for account history. We deliberately keep each row compact:
 * only metadata + the finished analysis/draft JSON. For fresh PDF reviews the
 * ORIGINAL document is also kept in storage (under a size cap set by the app),
 * plus one small JPEG page preview for list thumbnails. Oldest PDFs/previews
 * are trimmed (`enforceStorageQuota`) so storage stays flat for a 300–500 user
 * base on the free tier.
 *
 * Every call is defensive: if Supabase isn't configured, RLS blocks us, or the
 * schema hasn't been applied yet, the app silently keeps working with the
 * local (browser) history.
 */

export const MAX_REMOTE_ENTRIES = 40;
export const MAX_STORED_PREVIEWS = 15;
export const MAX_STORED_PDFS = 10;

export const PREVIEW_BUCKET = 'documents';

interface DocumentRow {
  id: string;
  user_id: string;
  kind: HistoryKind;
  name: string;
  page_count: number | null;
  section_count: number | null;
  draft_brief: string | null;
  draft_markdown: string | null;
  draft_doc: string | null;
  draft_signatures: unknown;
  analysis: unknown;
  page_texts: unknown;
  preview_path: string | null;
  pdf_path: string | null;
  created_at: number;
  updated_at: number;
}

function rowToEntry(row: DocumentRow): HistoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pageCount: row.page_count ?? undefined,
    sectionCount: row.section_count ?? undefined,
    draftBrief: row.draft_brief ?? undefined,
    draftMarkdown: row.draft_markdown ?? undefined,
    draftDoc: row.draft_doc ?? undefined,
    draftSignatures: (row.draft_signatures as ContractSignatures | null) ?? undefined,
    analysis: (row.analysis as ContractAnalysis | null) ?? undefined,
    pageTexts: (row.page_texts as PdfPage[] | null) ?? undefined,
    previewPath: row.preview_path ?? undefined,
    pdfPath: row.pdf_path ?? undefined,
  };
}

function entryToRow(userId: string, entry: HistoryEntry): DocumentRow {
  return {
    id: entry.id,
    user_id: userId,
    kind: entry.kind,
    name: entry.name,
    page_count: entry.pageCount ?? null,
    section_count: entry.sectionCount ?? null,
    draft_brief: entry.draftBrief ?? null,
    draft_markdown: entry.draftMarkdown ?? null,
    draft_doc: entry.draftDoc ?? null,
    draft_signatures: entry.draftSignatures ?? null,
    analysis: entry.analysis ?? null,
    page_texts: entry.pageTexts ?? null,
    preview_path: entry.previewPath ?? null,
    pdf_path: entry.pdfPath ?? null,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
}

function isConfigured(userId?: string): userId is string {
  return Boolean(supabase && userId);
}

export async function fetchRemoteHistory(userId: string): Promise<HistoryEntry[]> {
  if (!isConfigured(userId)) {
    return [];
  }
  const { data, error } = await supabase!
    .from('documents')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) {
    return [];
  }
  return (data as DocumentRow[] ?? []).map(rowToEntry);
}

export async function upsertRemoteHistory(
  userId: string,
  entries: HistoryEntry[],
): Promise<boolean> {
  if (!isConfigured(userId) || entries.length === 0) {
    return false;
  }
  const trimmed = entries.slice(0, MAX_REMOTE_ENTRIES);
  const attempt = async (
    withoutExtensions: boolean,
  ): Promise<{ error: { message: string } | null }> => {
    const rows = trimmed.map((entry) => {
      const row = entryToRow(userId, entry);
      if (withoutExtensions) {
        const partial = row as Partial<DocumentRow>;
        delete partial.pdf_path;
        delete partial.page_texts;
      }
      return row;
    });
    return supabase!.from('documents').upsert(rows, { onConflict: 'id' });
  };
  let { error } = await attempt(false);
  if (
    error?.message &&
    (error.message.includes('pdf_path') ||
      error.message.includes('preview_path') ||
      error.message.includes('page_texts'))
  ) {
    ({ error } = await attempt(true));
  }
  if (error) {
    return false;
  }
  return true;
}

export async function removeRemoteHistory(userId: string, id: string): Promise<void> {
  if (!isConfigured(userId)) {
    return;
  }
  const { data: row } = await supabase!
    .from('documents')
    .select('preview_path, pdf_path')
    .eq('id', id)
    .maybeSingle();
  const paths = [
    (row as Pick<DocumentRow, 'preview_path' | 'pdf_path'> | null)?.preview_path,
    (row as Pick<DocumentRow, 'preview_path' | 'pdf_path'> | null)?.pdf_path,
  ].filter((path): path is string => Boolean(path));
  // Delete the DB row FIRST — a storage hiccup must never stop the record's
  // removal. Storage objects are cleaned up best-effort afterwards.
  const { error } = await supabase!.from('documents').delete().eq('id', id).eq('user_id', userId);
  if (error) {
    return;
  }
  if (paths.length > 0) {
    try {
      await supabase!.storage.from(PREVIEW_BUCKET).remove(paths);
    } catch {
      /* storage objects are cleaned up best-effort */
    }
  }
}

export async function clearRemoteHistory(userId: string): Promise<void> {
  if (!isConfigured(userId)) {
    return;
  }
  const { data: objects } = await supabase!
    .storage.from(PREVIEW_BUCKET)
    .list(`${userId}/`, { limit: 500 });
  const names = (objects ?? []).map((object) => `${userId}/${object.name}`);
  if (names.length > 0) {
    await supabase!.storage.from(PREVIEW_BUCKET).remove(names);
  }
  const { error } = await supabase!.from('documents').delete().eq('user_id', userId);
  if (error) {
    throw new Error(error.message);
  }
}

export async function uploadPreview(
  userId: string,
  documentId: string,
  blob: Blob,
): Promise<string | null> {
  if (!isConfigured(userId)) {
    return null;
  }
  const path = `${userId}/${documentId}/preview.jpg`;
  const { error } = await supabase!
    .storage.from(PREVIEW_BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', upsert: true, cacheControl: '31536000' });
  if (error) {
    return null;
  }
  return path;
}

export async function uploadPdf(
  userId: string,
  documentId: string,
  blob: Blob,
): Promise<string | null> {
  if (!isConfigured(userId)) {
    return null;
  }
  const path = `${userId}/${documentId}/document.pdf`;
  const { error } = await supabase!
    .storage.from(PREVIEW_BUCKET)
    .upload(path, blob, {
      contentType: 'application/pdf',
      upsert: true,
      cacheControl: '31536000',
    });
  if (error) {
    return null;
  }
  return path;
}

export async function deletePreview(path: string): Promise<void> {
  if (!supabase || !path) {
    return;
  }
  await supabase.storage.from(PREVIEW_BUCKET).remove([path]);
}

const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

async function getSignedUrl(path: string): Promise<string | null> {
  if (!supabase || !path) {
    return null;
  }
  const cached = signedUrlCache.get(path);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.url;
  }
  const { data, error } = await supabase.storage
    .from(PREVIEW_BUCKET)
    .createSignedUrl(path, 60 * 60 * 6);
  if (error || !data) {
    return null;
  }
  signedUrlCache.set(path, { url: data.signedUrl, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
  return data.signedUrl;
}

export async function getPreviewSignedUrl(path: string): Promise<string | null> {
  return getSignedUrl(path);
}

export async function getPdfSignedUrl(path: string): Promise<string | null> {
  return getSignedUrl(path);
}

export async function downloadStoredPdf(path: string, name: string): Promise<File | null> {
  const url = await getSignedUrl(path);
  if (!url) {
    return null;
  }
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    return new File([blob], name, { type: 'application/pdf' });
  } catch {
    return null;
  }
}

export async function enforceStorageQuota(userId: string): Promise<void> {
  if (!isConfigured(userId)) {
    return;
  }
  const { data, error } = await supabase!
    .from('documents')
    .select('id, preview_path, pdf_path, updated_at')
    .or(`preview_path.not.is.null,pdf_path.not.is.null`)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(MAX_STORED_PDFS + MAX_STORED_PREVIEWS + 20);
  if (error) {
    return;
  }
  const rows =
    (data as Array<{ id: string; preview_path: string | null; pdf_path: string | null }>) ?? [];
  const trimmed: string[] = [];

  const pdfRows = rows.filter((row) => row.pdf_path);
  const expiredPdfs = pdfRows.slice(MAX_STORED_PDFS);
  for (const row of expiredPdfs) {
    if (row.pdf_path) {
      await deletePreview(row.pdf_path);
    }
    trimmed.push(row.id);
    row.pdf_path = null;
  }

  const previewRows = rows.filter((row) => row.preview_path);
  const expiredPreviews = previewRows.slice(MAX_STORED_PREVIEWS);
  for (const row of expiredPreviews) {
    if (row.preview_path) {
      await deletePreview(row.preview_path);
    }
    trimmed.push(row.id);
    row.preview_path = null;
  }

  if (trimmed.length === 0) {
    return;
  }
  for (const row of rows) {
    if (!trimmed.includes(row.id)) {
      continue;
    }
    await supabase!
      .from('documents')
      .update({
        preview_path: row.preview_path,
        pdf_path: row.pdf_path,
      } satisfies Partial<DocumentRow>)
      .eq('id', row.id);
  }
}