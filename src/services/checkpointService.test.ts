import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveCheckpoint,
  loadCheckpoints,
  getCheckpoint,
  removeCheckpoint,
  subscribeCheckpoints,
  fileToDataUrl,
  dataUrlToFile,
  type ResumeCheckpoint,
} from './checkpointService';
import type { ContractRisk } from '../types';

const RISK: ContractRisk = {
  id: 'r1',
  text: 'The Company shall indemnify the Client against all claims',
  riskLevel: 'high',
  category: 'Indemnity',
  description: 'Unlimited indemnity with no carve-outs.',
  recommendation: 'Cap the indemnity.',
  pageNumber: 2,
  searchText: 'indemnify client claims',
};

function makeCheckpoint(overrides: Partial<ResumeCheckpoint> = {}): ResumeCheckpoint {
  return {
    id: `cp-${Math.random()}`,
    fileName: 'contract.pdf',
    pageCount: 10,
    processedPages: 3,
    risks: [],
    keyTerms: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('checkpointService', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips a checkpoint', () => {
    const checkpoint = makeCheckpoint({
      id: 'cp-1',
      risks: [RISK],
    });
    saveCheckpoint(checkpoint);

    const loaded = getCheckpoint('cp-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.fileName).toBe('contract.pdf');
    expect(loaded?.processedPages).toBe(3);
    expect(loaded?.risks.length).toBe(1);
    expect(loaded?.risks[0].text).toContain('indemnify');
  });

  it('lists checkpoints newest first', () => {
    saveCheckpoint(makeCheckpoint({ id: 'a' }));
    saveCheckpoint(makeCheckpoint({ id: 'b' }));
    const ids = loadCheckpoints().map((entry) => entry.id);
    expect(ids).toEqual(['b', 'a']);
  });

  it('updates an existing checkpoint in place', () => {
    saveCheckpoint(makeCheckpoint({ id: 'x', processedPages: 2 }));
    saveCheckpoint(makeCheckpoint({ id: 'x', processedPages: 5 }));
    const all = loadCheckpoints();
    expect(all.length).toBe(1);
    expect(all[0].processedPages).toBe(5);
  });

  it('caps the number of stored checkpoints', () => {
    saveCheckpoint(makeCheckpoint({ id: '1' }));
    saveCheckpoint(makeCheckpoint({ id: '2' }));
    saveCheckpoint(makeCheckpoint({ id: '3' }));
    saveCheckpoint(makeCheckpoint({ id: '4' }));
    const all = loadCheckpoints();
    expect(all.length).toBe(3);
    expect(all.some((entry) => entry.id === '1')).toBe(false);
  });

  it('removes a checkpoint', () => {
    saveCheckpoint(makeCheckpoint({ id: 'gone' }));
    removeCheckpoint('gone');
    expect(loadCheckpoints()).toEqual([]);
  });

  it('notifies subscribers on changes', () => {
    let notified = 0;
    const unsubscribe = subscribeCheckpoints(() => {
      notified += 1;
    });
    saveCheckpoint(makeCheckpoint({ id: 'n1' }));
    removeCheckpoint('n1');
    unsubscribe();
    saveCheckpoint(makeCheckpoint({ id: 'n2' }));
    expect(notified).toBe(2);
  });

  it('refuses to embed files over the size limit', async () => {
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.pdf', {
      type: 'application/pdf',
    });
    expect(await fileToDataUrl(big)).toBeNull();
  });

  it('round-trips a PDF through base64 back to a File', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const original = new File([bytes], 'sample.pdf', { type: 'application/pdf' });
    const dataUrl = await fileToDataUrl(original);
    expect(dataUrl).not.toBeNull();

    const restored = await dataUrlToFile(dataUrl as string, 'sample.pdf');
    expect(restored.name).toBe('sample.pdf');
    expect(restored.type).toBe('application/pdf');
    expect(restored.size).toBe(bytes.length);
    const restoredBytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(restored);
    });
    expect(Array.from(restoredBytes)).toEqual(Array.from(bytes));
  });
});