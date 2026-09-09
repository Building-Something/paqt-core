import { describe, expect, it } from 'vitest';
import { TokenPacer } from './tokenPacer';

describe('TokenPacer', () => {
  it('grants the full budget at start', () => {
    const now = 0;
    const pacer = new TokenPacer({ tokensPerMinute: 6000, nowMs: () => now });
    expect(pacer.reserve(1000)).toBe(0);
    expect(pacer.reserve(5000)).toBe(0);
    expect(pacer.reserve(1)).toBeGreaterThan(0);
  });

  it('returns a wait when the budget is exhausted', () => {
    const now = 0;
    const pacer = new TokenPacer({ tokensPerMinute: 6000, nowMs: () => now });
    expect(pacer.reserve(6000)).toBe(0);
    const waitMs = pacer.reserve(6000);
    expect(waitMs).toBeGreaterThan(0);
    expect(waitMs).toBe(60_000);
  });

  it('refills as time passes', () => {
    let now = 0;
    const pacer = new TokenPacer({ tokensPerMinute: 6000, nowMs: () => now });
    pacer.reserve(6000);
    now = 30_000;
    expect(pacer.reserve(3000)).toBe(0);
    now = 30_000;
    expect(pacer.reserve(3000)).toBeGreaterThan(0);
  });

  it('caps at the configured capacity', () => {
    let now = 0;
    const pacer = new TokenPacer({ tokensPerMinute: 7000, nowMs: () => now });
    pacer.reserve(1000);
    now = 100_000;
    expect(pacer.reserve(7000)).toBe(0);
    expect(pacer.reserve(1)).toBeGreaterThan(0);
  });

  it('carries a deficit after an over-budget request', () => {
    const now = 0;
    const pacer = new TokenPacer({ tokensPerMinute: 6000, nowMs: () => now });
    expect(pacer.reserve(10_000)).toBe(40_000);
    expect(pacer.reserve(1000)).toBe(50_000);
  });

  it('refunds unused budget', () => {
    const now = 0;
    const pacer = new TokenPacer({ tokensPerMinute: 6000, nowMs: () => now });
    expect(pacer.reserve(6000)).toBe(0);
    pacer.refund(2000);
    expect(pacer.reserve(2000)).toBe(0);
    expect(pacer.reserve(1)).toBeGreaterThan(0);
  });

  it('charges actual usage against the budget', () => {
    const now = 0;
    const pacer = new TokenPacer({ tokensPerMinute: 6000, nowMs: () => now });
    expect(pacer.reserve(6000)).toBe(0);
    pacer.charge(1000);
    expect(pacer.reserve(1000)).toBe(20_000);
  });

  it('handles zero tokens without waiting', () => {
    const now = 0;
    const pacer = new TokenPacer({ tokensPerMinute: 1000, nowMs: () => now });
    expect(pacer.reserve(0)).toBe(0);
  });
});