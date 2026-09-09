export interface TokenPacerConfig {
  tokensPerMinute: number;
  nowMs?: () => number;
}

export class TokenPacer {
  readonly tokensPerMinute: number;
  private available: number;
  private lastRefillMs: number;
  private readonly nowMs: () => number;

  constructor(config: TokenPacerConfig) {
    const now = config.nowMs ?? Date.now;
    this.tokensPerMinute = config.tokensPerMinute;
    this.nowMs = now;
    this.available = config.tokensPerMinute;
    this.lastRefillMs = now();
  }

  reserve(tokens: number): number {
    const now = this.nowMs();
    const elapsedMs = Math.max(0, now - this.lastRefillMs);
    const refillRate = this.tokensPerMinute / 60_000;
    this.available = Math.min(
      this.tokensPerMinute,
      this.available + elapsedMs * refillRate,
    );
    this.lastRefillMs = now;
    if (tokens <= this.available) {
      this.available -= tokens;
      return 0;
    }
    const waitMs = Math.ceil((tokens - this.available) / refillRate);
    this.available -= tokens;
    return Math.max(0, waitMs);
  }

  charge(tokens: number): void {
    this.available -= tokens;
  }

  refund(tokens: number): void {
    this.available = Math.min(this.tokensPerMinute, this.available + tokens);
  }
}