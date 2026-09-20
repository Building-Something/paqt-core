import type { ContractAnalysis, PdfPage } from '../types';
import type { ContractSignatures } from '../utils/contractDocument';

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
  draftSignatures?: ContractSignatures;
  analysis?: ContractAnalysis;
  pageTexts?: PdfPage[];
  previewPath?: string;
  pdfPath?: string;
}

const GUEST_KEY = 'paqt.history.v1';
const MAX_ENTRIES = 40;

let currentUserId: string | null = null;

function storageKey(): string {
  return currentUserId ? `${GUEST_KEY}.${currentUserId}` : GUEST_KEY;
}

export function getBoundUserId(): string | null {
  return currentUserId;
}

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

function readRaw(key: string): HistoryEntry[] {
  try {
    return safeParse(window.localStorage.getItem(key));
  } catch {
    return [];
  }
}

function read(): HistoryEntry[] {
  return readRaw(storageKey());
}

function write(entries: HistoryEntry[]) {
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(entries));
  } catch {
    // Storage may be unavailable (private mode); history is best-effort.
  }
  notify();
  const userId = currentUserId;
  if (userId) {
    void import('./supabaseHistoryService').then((mod) =>
      mod.upsertRemoteHistory(userId, entries),
    );
  }
}

function overlayFields(base: HistoryEntry, overlay: HistoryEntry): HistoryEntry {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay as unknown as Record<string, unknown>)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged as unknown as HistoryEntry;
}

function mergedEntries(local: HistoryEntry[], remote: HistoryEntry[]): HistoryEntry[] {
  const map = new Map<string, HistoryEntry>();
  for (const entry of local) {
    map.set(entry.id, entry);
  }
  for (const entry of remote) {
    const base = map.get(entry.id);
    map.set(entry.id, overlayFields(base ?? entry, entry));
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Binds the local history cache to a signed-in user and merges the account's
 * cloud history. Any entries created while signed out (guest mode) are migrated
 * into the account on first sign-in, then cleared from the guest key.
 *
 * The account's previous local cache is preserved across sign-out/sign-in, so
 * reviews never disappear even if the cloud sync is temporarily unavailable.
 */
export async function bindHistoryToUser(userId: string, onReady?: () => void): Promise<void> {
  if (currentUserId === userId) {
    onReady?.();
    return;
  }
  const guestEntries = readRaw(GUEST_KEY);
  const cached = readRaw(`${GUEST_KEY}.${userId}`);
  currentUserId = userId;

  let remote: HistoryEntry[] = [];
  try {
    const mod = await import('./supabaseHistoryService');
    remote = await mod.fetchRemoteHistory(userId);
  } catch {
    remote = [];
  }

  const merged = mergedEntries([...guestEntries, ...cached], remote);
  write(merged);
  if (guestEntries.length > 0) {
    try {
      window.localStorage.removeItem(GUEST_KEY);
    } catch {
      // Best-effort cleanup.
    }
  }
  onReady?.();
}

export function unbindHistoryToUser(): void {
  if (!currentUserId) {
    return;
  }
  // Keep the account's local cache (scoped to this user id) so re-signing in on
  // this device restores past reviews even before the cloud sync has merged.
  currentUserId = null;
  notify();
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
  const userId = currentUserId;
  if (userId) {
    void import('./supabaseHistoryService').then((mod) => mod.removeRemoteHistory(userId, id));
  }
  return next;
}

export function clearHistory(): HistoryEntry[] {
  write([]);
  const userId = currentUserId;
  if (userId) {
    void import('./supabaseHistoryService').then((mod) => mod.clearRemoteHistory(userId));
  }
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