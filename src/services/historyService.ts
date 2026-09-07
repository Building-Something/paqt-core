import type { ContractAnalysis } from '../types';

export type HistoryKind = 'analysis' | 'draft';

export interface HistoryEntry {
  id: string;
  kind: HistoryKind;
  name: string;
  createdAt: number;
  updatedAt: number;
  pageCount?: number;
  sectionCount?: number;
  draftBrief?: string;
  draftMarkdown?: string;
  draftDoc?: string;
  analysis?: ContractAnalysis;
}

const STORAGE_KEY = 'paqt.history.v1';
const MAX_ENTRIES = 40;

type HistoryListener = () => void;

const listeners = new Set<HistoryListener>();

function notify() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Ignore listener failures.
    }
  }
}

function safeParse(raw: string | null): HistoryEntry[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function read(): HistoryEntry[] {
  try {
    return safeParse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

function write(entries: HistoryEntry[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    notify();
  } catch {
    // Storage may be unavailable (private mode); history is best-effort.
  }
}

export function createHistoryId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return `${prefix}-${random}`;
}

export function loadHistory(): HistoryEntry[] {
  return read();
}

export function getHistoryEntry(id: string): HistoryEntry | null {
  return read().find((entry) => entry.id === id) ?? null;
}

export function upsertHistoryEntry(entry: HistoryEntry, max = MAX_ENTRIES): HistoryEntry[] {
  const current = read();
  const index = current.findIndex((existing) => existing.id === entry.id);
  const next = [...current];
  if (index >= 0) {
    next[index] = { ...current[index], ...entry, updatedAt: Date.now() };
  } else {
    next.unshift({ ...entry, createdAt: entry.createdAt ?? Date.now() });
  }
  const trimmed = next.slice(0, max);
  write(trimmed);
  return trimmed;
}

export function deleteHistoryEntry(id: string): HistoryEntry[] {
  const next = read().filter((entry) => entry.id !== id);
  write(next);
  return next;
}

export function clearHistory(): HistoryEntry[] {
  write([]);
  return [];
}

export function subscribeHistory(listener: HistoryListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 45) {
    return 'just now';
  }
  if (seconds < 90) {
    return '1m ago';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: new Date(timestamp).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}