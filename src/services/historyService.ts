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
const TOMBSTONE_KEY = 'paqt.history.deleted';
const MAX_ENTRIES = 40;
const MAX_TOMBSTONES = 500;

/**
 * Heavy fields that are only needed when opening a record, never when rendering
 * the history lists. They are persisted separately (per-entry payload keys) so
 * the index write — which happens on every autosave while drafting — stays
 * lightweight and never blocks the main thread.
 */
const PAYLOAD_PREFIX = 'paqt.payload.v1.';
const HEAVY_FIELDS = ['draftDoc', 'draftMarkdown', 'draftSignatures', 'pageTexts'] as const;
type HeavyField = (typeof HEAVY_FIELDS)[number];

const payloadIndex = new Set<string>();
const payloadCache = new Map<string, string>();
let payloadIndexLoaded = false;

function payloadKey(id: string): string {
  return `${PAYLOAD_PREFIX}${id}`;
}

function ensurePayloadIndex(): void {
  if (payloadIndexLoaded) {
    return;
  }
  payloadIndexLoaded = true;
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(PAYLOAD_PREFIX)) {
        payloadIndex.add(key.slice(PAYLOAD_PREFIX.length));
      }
    }
  } catch {
    // Best-effort; payloads just won't be pre-linked this session.
  }
}

function extractHeavy(entry: HistoryEntry): Partial<HistoryEntry> {
  const heavy: Partial<HistoryEntry> = {};
  for (const field of HEAVY_FIELDS) {
    const value = entry[field];
    if (value !== undefined) {
      (heavy as Record<HeavyField, unknown>)[field] = value;
    }
  }
  return heavy;
}

function stripHeavy(entry: HistoryEntry): HistoryEntry {
  const copy: Record<string, unknown> = { ...entry };
  for (const field of HEAVY_FIELDS) {
    delete copy[field];
  }
  return copy as unknown as HistoryEntry;
}

/** Writes the heavy fields of any entry carrying them into its payload key,
 *  skipping entries whose payload was already persisted unchanged. */
function persistPayloadedEntries(entries: HistoryEntry[]): void {
  ensurePayloadIndex();
  for (const entry of entries) {
    const heavy = extractHeavy(entry);
    if (Object.keys(heavy).length === 0) {
      continue;
    }
    let json = '';
    try {
      json = JSON.stringify(heavy);
    } catch {
      continue;
    }
    if (payloadCache.get(entry.id) === json) {
      continue;
    }
    try {
      window.localStorage.setItem(payloadKey(entry.id), json);
      payloadCache.set(entry.id, json);
      payloadIndex.add(entry.id);
    } catch {
      // Storage unavailable — the payload simply won't be cached locally.
    }
  }
}

function readPayload(id: string): Partial<HistoryEntry> | null {
  ensurePayloadIndex();
  try {
    const raw = window.localStorage.getItem(payloadKey(id));
    if (!raw) {
      return null;
    }
    payloadCache.set(id, raw);
    return JSON.parse(raw) as Partial<HistoryEntry>;
  } catch {
    return null;
  }
}

function deletePayload(id: string): void {
  if (payloadIndex.delete(id)) {
    try {
      window.localStorage.removeItem(payloadKey(id));
    } catch {
      // Best-effort.
    }
  }
  payloadCache.delete(id);
}

function clearAllPayloads(): void {
  ensurePayloadIndex();
  for (const id of payloadIndex) {
    try {
      window.localStorage.removeItem(payloadKey(id));
    } catch {
      // Best-effort.
    }
  }
  payloadIndex.clear();
  payloadCache.clear();
}

let currentUserId: string | null = null;

let realtimeUnsubscribe: (() => void) | null = null;

let focusHandler: (() => void) | null = null;

/**
 * Ids this session has created/edited but whose write to the cloud has not been
 * acknowledged yet. Deliberately NOT persisted: a reload re-syncs purely from
 * the cloud, so a stale pending set from an old session can never resurrect a
 * row that was deleted on another device.
 */
const pendingIds = new Set<string>();

function readTombstones(): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TOMBSTONE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function writeTombstones(ids: Set<string>) {
  try {
    const bounded = [...ids].slice(0, MAX_TOMBSTONES);
    window.localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(bounded));
  } catch {
    // Storage may be unavailable (private mode); tombstones are best-effort.
  }
}

async function remergeRemoteForActiveUser(): Promise<void> {
  const userId = currentUserId;
  if (!userId) {
    return;
  }
  let remote: HistoryEntry[] = [];
  try {
    const mod = await import('./supabaseHistoryService');
    remote = await mod.fetchRemoteHistory(userId);
  } catch {
    // Cloud unreachable — keep the local cache untouched (offline mode).
    return;
  }
  const current = read();
  const merged = reconcileWithRemote(current, remote, pendingIds);
  const changed =
    merged.length !== current.length ||
    merged.some((entry, index) => entry.updatedAt !== current[index]?.updatedAt);
  if (changed) {
    write(merged);
  }
  void retryRemoteDeletes(userId, remote);
}

/** Re-attempts deletion of rows that are still present on the server but were
 *  deleted on this device earlier (e.g. the delete ran while offline). */
async function retryRemoteDeletes(userId: string, remote: HistoryEntry[]): Promise<void> {
  const tombstones = readTombstones();
  if (tombstones.size === 0) {
    return;
  }
  const mod = await import('./supabaseHistoryService');
  for (const entry of remote) {
    if (tombstones.has(entry.id)) {
      await mod.removeRemoteHistory(userId, entry.id);
    }
  }
}

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
  const tombstones = readTombstones();
  return readRaw(storageKey()).filter((entry) => !tombstones.has(entry.id));
}

function write(entries: HistoryEntry[]) {
  const tombstones = readTombstones();
  const filtered = entries.filter((entry) => !tombstones.has(entry.id));
  // Heavy fields move to per-entry payload keys; the index stays lightweight so
  // writes (e.g. draft autosaves) never freeze the main thread.
  persistPayloadedEntries(filtered);
  const stored = filtered.map(stripHeavy);
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(stored));
  } catch {
    // Storage may be unavailable (private mode); history is best-effort.
  }
  notify();
  const userId = currentUserId;
  if (!userId) {
    return;
  }
  // Only locally-created/updated entries are pushed to the cloud. The rest of the
  // cache is mirror data and must NEVER be re-uploaded, otherwise a stale device
  // would resurrect rows that were deleted on another device.
  const toUpload = filtered.filter((entry) => pendingIds.has(entry.id));
  if (toUpload.length === 0) {
    return;
  }
  void import('./supabaseHistoryService').then((mod) =>
    mod.upsertRemoteHistory(userId, toUpload).then((ok) => {
      if (ok) {
        for (const entry of toUpload) {
          pendingIds.delete(entry.id);
        }
      }
    }),
  );
}

/**
 * Reconciles a local cache with the cloud.
 *
 * The cloud is the source of truth: entries present remotely win, and local
 * entries that no longer exist remotely are treated as deleted elsewhere and
 * dropped. The only local entries that survive are ones this device created or
 * edited but has not successfully uploaded yet (the "pending" set), so offline
 * work is never lost and deletions always propagate across devices.
 */
export function reconcileWithRemote(
  local: HistoryEntry[],
  remote: HistoryEntry[],
  pendingIds: Set<string>,
): HistoryEntry[] {
  const map = new Map<string, HistoryEntry>();
  for (const entry of local) {
    if (pendingIds.has(entry.id)) {
      // This device has unsynced changes (or created the entry) for an id that
      // may or may not exist remotely yet — keep the local version to re-upload.
      map.set(entry.id, entry);
    }
    // Otherwise: if the entry exists remotely the remote copy wins (added
    // below); if it exists only locally it was deleted elsewhere and is dropped.
  }
  for (const entry of remote) {
    if (!map.has(entry.id)) {
      map.set(entry.id, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Binds the local history cache to a signed-in user and syncs with the account's
 * cloud history. Entries created while signed out (guest mode) are marked
 * pending and pushed to the cloud; the cloud then becomes the source of truth,
 * so other devices pick up creates and deletions.
 */
export async function bindHistoryToUser(userId: string, onReady?: () => void): Promise<void> {
  if (currentUserId === userId) {
    onReady?.();
    return;
  }
  const guestEntries = readRaw(GUEST_KEY);
  const cached = readRaw(`${GUEST_KEY}.${userId}`);
  currentUserId = userId;

  // ONLY guest-created entries are genuinely unsynced and must be re-uploaded.
  // The per-account cache is a mirror of the cloud — marking it pending would
  // re-upload entries that were deleted on another device, resurrecting them.
  for (const entry of guestEntries) {
    pendingIds.add(entry.id);
  }

  let remote: HistoryEntry[] = [];
  let fetched = false;
  try {
    const mod = await import('./supabaseHistoryService');
    remote = await mod.fetchRemoteHistory(userId);
    fetched = true;
  } catch {
    remote = [];
  }

  const local = [...guestEntries, ...cached];
  const merged = fetched
    ? reconcileWithRemote(local, remote, pendingIds)
    : [...local].sort((a, b) => b.updatedAt - a.updatedAt);
  const current = read();
  if (
    merged.length !== current.length ||
    merged.some((e, i) => e.updatedAt !== current[i]?.updatedAt)
  ) {
    write(merged);
  }
  if (guestEntries.length > 0 && fetched) {
    try {
      window.localStorage.removeItem(GUEST_KEY);
    } catch {
      // Best-effort cleanup.
    }
  }

  onReady?.();

  realtimeUnsubscribe?.();
  realtimeUnsubscribe = (
    await import('./realtimeHistoryService')
  ).subscribeHistoryRealtime(userId, () => {
    void remergeRemoteForActiveUser();
  });

  // Belt-and-braces: when the tab regains focus, re-sync from the cloud so the
  // list is fresh even if Realtime isn't configured on the project.
  if (typeof window !== 'undefined' && !focusHandler) {
    focusHandler = () => {
      void remergeRemoteForActiveUser();
    };
    window.addEventListener('focus', focusHandler);
  }
}

export function unbindHistoryToUser(): void {
  if (!currentUserId) {
    return;
  }
  // Keep the account's local cache (scoped to this user id) so re-signing in on
  // this device restores past reviews even before the cloud sync has merged.
  currentUserId = null;
  if (focusHandler) {
    window.removeEventListener('focus', focusHandler);
    focusHandler = null;
  }
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
  const base = read().find((entry) => entry.id === id);
  if (!base) {
    return null;
  }
  const payload = readPayload(id);
  if (payload) {
    return { ...base, ...payload };
  }
  // Legacy entries may still carry heavy fields inline; they'll be split out on
  // the next write.
  return base;
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
  if (trimmed.some((existing) => existing.id === entry.id)) {
    pendingIds.add(entry.id);
  } else {
    pendingIds.delete(entry.id);
  }
  write(trimmed);
  return trimmed;
}

export function deleteHistoryEntry(id: string): HistoryEntry[] {
  const tombstones = readTombstones();
  tombstones.add(id);
  writeTombstones(tombstones);
  pendingIds.delete(id);
  const next = read().filter((entry) => entry.id !== id);
  write(next);
  deletePayload(id);
  const userId = currentUserId;
  if (userId) {
    void import('./supabaseHistoryService').then((mod) => mod.removeRemoteHistory(userId, id));
  }
  return next;
}

export function clearHistory(): HistoryEntry[] {
  writeTombstones(new Set());
  write([]);
  clearAllPayloads();
  const userId = currentUserId;
  if (userId) {
    void import('./supabaseHistoryService').then((mod) => mod.clearRemoteHistory(userId));
  }
  return [];
}

/**
 * Removes every piece of locally-cached history for the current user without
 * touching the cloud (used after a deleted account has already been wiped
 * server-side, so no trace of it survives on this device).
 */
export function wipeLocalHistory(): void {
  const keys = [GUEST_KEY];
  const userId = currentUserId;
  if (userId) {
    keys.push(`${GUEST_KEY}.${userId}`);
  }
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Best-effort.
    }
  }
  try {
    window.localStorage.removeItem(TOMBSTONE_KEY);
  } catch {
    // Best-effort.
  }
  clearAllPayloads();
  pendingIds.clear();
  notify();
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