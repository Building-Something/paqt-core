import type { ContractRisk } from '../types';

export interface ResumeCheckpoint {
  id: string;
  fileName: string;
  fileB64?: string;
  fileType?: string;
  pageCount: number;
  processedPages: number;
  risks: ContractRisk[];
  keyTerms: string[];
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'paqt.checkpoints.v1';
const MAX_CHECKPOINTS = 3;
const FILE_SIZE_LIMIT_BYTES = 2 * 1024 * 1024;

type CheckpointListener = () => void;

const listeners = new Set<CheckpointListener>();

function notify() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Ignore listener failures.
    }
  }
}

function safeParse(raw: string | null): ResumeCheckpoint[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ResumeCheckpoint[]) : [];
  } catch {
    return [];
  }
}

function read(): ResumeCheckpoint[] {
  try {
    return safeParse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

function tryWrite(entries: ResumeCheckpoint[]): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    notify();
    return true;
  } catch {
    return false;
  }
}

export function loadCheckpoints(): ResumeCheckpoint[] {
  return read();
}

export function getCheckpoint(id: string): ResumeCheckpoint | null {
  return read().find((entry) => entry.id === id) ?? null;
}

export function removeCheckpoint(id: string): ResumeCheckpoint[] {
  const next = read().filter((entry) => entry.id !== id);
  tryWrite(next);
  return next;
}

export function saveCheckpoint(checkpoint: ResumeCheckpoint): ResumeCheckpoint[] {
  const current = read();
  const index = current.findIndex((entry) => entry.id === checkpoint.id);
  let next = [...current];
  if (index >= 0) {
    next[index] = { ...next[index], ...checkpoint, updatedAt: Date.now() };
  } else {
    next.unshift({ ...checkpoint, createdAt: Date.now(), updatedAt: Date.now() });
  }
  next = next.slice(0, MAX_CHECKPOINTS);

  if (tryWrite(next)) {
    return next;
  }

  // Storage quota exceeded: drop embedded files and keep at least the findings.
  const stripped = next.map((entry) =>
    entry.fileB64 ? { ...entry, fileB64: undefined, fileType: undefined } : entry,
  );
  if (tryWrite(stripped)) {
    return stripped;
  }
  return next;
}

export function clearCheckpoints(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort.
  }
  notify();
}

export function subscribeCheckpoints(listener: CheckpointListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('Could not read the PDF.'));
    reader.readAsDataURL(file);
  });
}

export async function fileToDataUrl(file: File): Promise<string | null> {
  if (file.size > FILE_SIZE_LIMIT_BYTES) {
    return null;
  }
  try {
    return await readAsDataURL(file);
  } catch {
    return null;
  }
}

export async function dataUrlToFile(dataUrl: string, fileName: string): Promise<File> {
  const commaIndex = dataUrl.indexOf(',');
  const meta = commaIndex >= 0 ? dataUrl.slice(0, commaIndex) : '';
  const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  let mime = 'application/pdf';
  const match = /^data:([^;]+);/i.exec(meta);
  if (match) {
    mime = match[1];
  }
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new File([bytes], fileName, { type: mime });
}