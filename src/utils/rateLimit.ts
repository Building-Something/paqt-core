export interface TokenEstimateInput {
  messages: { content: string }[];
  max_tokens?: number;
}

const DEFAULT_OUTPUT_TOKENS = 4096;
const MIN_OUTPUT_TOKENS = 256;
const OVERHEAD_TOKENS = 64;
const DEFAULT_MAX_WAIT_MS = 60_000;

export function estimateRequestTokens(payload: TokenEstimateInput): number {
  const inputChars = payload.messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  const inputTokens = Math.ceil(inputChars / 4);
  const outputTokens = Math.max(
    payload.max_tokens ?? DEFAULT_OUTPUT_TOKENS,
    MIN_OUTPUT_TOKENS,
  );
  return inputTokens + outputTokens + OVERHEAD_TOKENS;
}

export function extractRetryAfterMs(
  bodyRetryAfterMs?: unknown,
  headerRetryAfter?: string | null,
  maxMs = DEFAULT_MAX_WAIT_MS,
): number | undefined {
  const fromBody = Number(bodyRetryAfterMs);
  if (Number.isFinite(fromBody) && fromBody > 0) {
    return Math.min(Math.max(0, fromBody), maxMs);
  }
  if (headerRetryAfter) {
    const seconds = Number.parseFloat(headerRetryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.max(0, Math.round(seconds * 1000)), maxMs);
    }
  }
  return undefined;
}