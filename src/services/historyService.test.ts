import { beforeEach, describe, expect, it } from 'vitest';
import {
  createHistoryId,
  deleteHistoryEntry,
  getHistoryEntry,
  loadHistory,
  reconcileWithRemote,
  upsertHistoryEntry,
  type HistoryEntry,
} from './historyService';

function makeEntry(id: string, kind: 'analysis' | 'draft' = 'analysis'): HistoryEntry {
  return {
    id,
    kind,
    name: 'Test document',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('historyService deletion tombstones', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('removes a deleted entry from the cache', () => {
    const id = createHistoryId('analysis');
    upsertHistoryEntry(makeEntry(id));
    expect(loadHistory().some((entry) => entry.id === id)).toBe(true);

    deleteHistoryEntry(id);
    expect(loadHistory().some((entry) => entry.id === id)).toBe(false);
  });

  it('does not resurrect a deleted id when a stale merge rewrites it into storage', () => {
    const id = createHistoryId('draft');
    upsertHistoryEntry(makeEntry(id, 'draft'));
    deleteHistoryEntry(id);

    // Simulate a remerge that pulls the row back from a stale remote snapshot.
    const key = 'paqt.history.v1';
    const current = JSON.parse(window.localStorage.getItem(key) ?? '[]') as HistoryEntry[];
    current.push(makeEntry(id, 'draft'));
    window.localStorage.setItem(key, JSON.stringify(current));

    expect(loadHistory().some((entry) => entry.id === id)).toBe(false);
  });

  it('keeps other entries intact after a targeted delete', () => {
    const keepId = createHistoryId('analysis');
    const deleteId = createHistoryId('analysis');
    upsertHistoryEntry(makeEntry(keepId));
    upsertHistoryEntry(makeEntry(deleteId));

    deleteHistoryEntry(deleteId);

    const entries = loadHistory();
    expect(entries.some((entry) => entry.id === deleteId)).toBe(false);
    expect(entries.some((entry) => entry.id === keepId)).toBe(true);
  });

  it('splits heavy draft payloads out of the index but restores them on read', () => {
    const id = 'draft-heavy-payload';
    upsertHistoryEntry({
      ...makeEntry(id, 'draft'),
      draftMarkdown: '# TEST AGREEMENT',
      draftDoc: '{"type":"doc"}',
      draftSignatures: { client: { dataUrl: 'data:image/png;base64,SIGNATURE' } },
    });

    const raw = JSON.parse(window.localStorage.getItem('paqt.history.v1') ?? '[]') as HistoryEntry[];
    const stored = raw.find((entry) => entry.id === id);
    expect(stored?.draftMarkdown).toBeUndefined();
    expect(stored?.draftDoc).toBeUndefined();
    expect(stored?.draftSignatures).toBeUndefined();

    const hydrated = getHistoryEntry(id);
    expect(hydrated?.draftMarkdown).toBe('# TEST AGREEMENT');
    expect(hydrated?.draftDoc).toBe('{"type":"doc"}');
    expect(hydrated?.draftSignatures?.client?.dataUrl).toBe('data:image/png;base64,SIGNATURE');

    deleteHistoryEntry(id);
    expect(getHistoryEntry(id)).toBeNull();
  });
});

describe('reconcileWithRemote (cloud is source of truth)', () => {
  it('drops a local entry missing from the remote when it is not pending', () => {
    const deletedElsewhere = 'analysis-remote-deleted';
    const kept = 'analysis-kept';
    const local = [makeEntry(deletedElsewhere), makeEntry(kept)];
    const remote = [makeEntry(kept)];

    const merged = reconcileWithRemote(local, remote, new Set());

    expect(merged.some((entry) => entry.id === deletedElsewhere)).toBe(false);
    expect(merged.some((entry) => entry.id === kept)).toBe(true);
  });

  it('keeps a local-only entry that is still pending (created offline)', () => {
    const offlineCreated = 'analysis-offline';
    const remote = [makeEntry('analysis-remote')];
    const local = [makeEntry(offlineCreated)];

    const merged = reconcileWithRemote(local, remote, new Set([offlineCreated]));

    expect(merged.some((entry) => entry.id === offlineCreated)).toBe(true);
    expect(merged.some((entry) => entry.id === 'analysis-remote')).toBe(true);
  });

  it('prefers the remote version of a synced entry over stale local data', () => {
    const id = 'analysis-synced';
    const staleLocal = { ...makeEntry(id), name: 'Stale local title' };
    const freshRemote = { ...makeEntry(id), name: 'Fresh remote title' };

    const merged = reconcileWithRemote([staleLocal], [freshRemote], new Set());

    expect(merged.find((entry) => entry.id === id)?.name).toBe('Fresh remote title');
  });

  it('keeps the local version of an entry that has unsynced edits on this device', () => {
    const id = 'analysis-edited';
    const editedLocal = { ...makeEntry(id), name: 'My local edit' };
    const staleRemote = { ...makeEntry(id), name: 'Old cloud title' };

    const merged = reconcileWithRemote([editedLocal], [staleRemote], new Set([id]));

    expect(merged.find((entry) => entry.id === id)?.name).toBe('My local edit');
  });
});