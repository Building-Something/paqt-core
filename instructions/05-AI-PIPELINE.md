# PAQT — AI PIPELINE

## PDF extraction
Use pdf.js.

For each page:
1. call `getTextContent()`,
2. concatenate text items,
3. normalize whitespace,
4. wrap with:
```text
=== PAGE N START ===
<page text>
=== PAGE N END ===
```

If extraction fails, surface:
`Failed to extract text from PDF`.

If a page has no extractable text, treat it as potentially scanned and do not invent its contents.

## Routing
Constants:
- single-call max pages: 1
- single-call max chars: 25,000
- per-page max tokens: 2,560
- per-page reasoning effort: medium
- analysis context truncation: 16,000 chars (chat; keeps a turn within the TPM budget)
- interaction full-text char limit: 300,000
- interaction max tokens: 8,192
- interaction window char limit: 20,000
- interaction window overlap pages: 1
- client token budget per minute: 7,000
- max rate-limit wait: 60,000 ms

### Single-page document
One JSON-mode request (single page up to 25k chars).

### Multi-page document — per-page streaming
Every document with more than one page is analyzed page by page, in order, so
every page gets focused attention and results accumulate live:

1. For each page (sequentially): one JSON-mode request containing only that page,
   asking for `risks` and `keyTerms` for that page.
2. Normalize + deduplicate + sort the accumulated risk set after every page and
   surface it through progress, so the breakdown grows live during analysis.
3. After the last page, run the cross-clause interaction pass.

Never parallelize pages by default because rate limits and ordering matter.

### Checkpoint / resume
After every analyzed page the client persists a checkpoint (`checkpointService.ts`,
storage key `paqt.checkpoints.v1`):

- id, fileName, pageCount, processedPages, accumulated risks + key terms,
- the PDF itself (base64) when it fits the storage limit so a pause can resume
  without re-upload; otherwise resume requires re-selecting the same file,
- capped to the most recent 3 checkpoints.

Resuming starts the loop at `processedPages` with the stored findings instead of
re-analyzing completed pages. On success the checkpoint is cleared and the final
analysis is written to history under the same id.

### Cross-clause interaction pass (both paths)
The per-page/single-pass extraction is intentionally local: it is told to analyze
only the supplied page, so risks that live across clauses or in clause interactions
are structurally invisible to it. A document-wide pass fixes exactly that:

1. Build overlapping windows over the pages (`buildInteractionWindows`): pages are
   packed into consecutive groups of ≤ `INTERACTION_WINDOW_CHAR_LIMIT` chars, each new
   window re-including the last `INTERACTION_OVERLAP_PAGES` pages so clause pairs that
   straddle a window boundary are still read together. The pass is skipped gracefully
   when the whole document has no text or exceeds `INTERACTION_FULL_TEXT_CHAR_LIMIT`.
2. Request JSON per window in strict JSON mode at `reasoning_effort: high`
   (per-page extraction stays at `medium`), budgets `INTERACTION_MAX_TOKENS`. If a
   strict-JSON attempt is rejected, one relaxed retry (no JSON mode) runs before the
   window is skipped with a warning and the remaining windows continue.
3. The prompt feeds each window's text + the already-identified risks and returns ONLY
   net-new cross-clause risks: contradictions, undermined protections, compounded
   exposures, broken cross-references, inconsistent definitions, coverage gaps.
   Each carries `pageNumber` plus `relatedPages`.
4. Deterministic grounding: every returned quote is verified against the real page
   text (`src/utils/riskVerify.ts`) — exact match first, then fuzzy token-overlap with
   a contiguous-run requirement. Page numbers are re-pinned to where the quote actually
   appears; findings with no verifiable quote are dropped.
5. Verified interaction risks merge with extraction risks and are normalized as one
   set before scoring and synthesis.

The pass is best-effort: any window error skips it with a warning rather than failing
the analysis.

## Rate limiting
Groq's free plan caps `openai/gpt-oss-120b` at 30 RPM / 1K RPD / 8K TPM / 200K TPD.
Paqt mitigates with three layers:

1. **Reset-aware retries.** The proxy forwards Groq's `retry-after` and `x-ratelimit-*`
   headers and includes `retryAfterMs` in the JSON body of every 429. The client retries
   after the reported reset window (capped at `MAX_RATE_LIMIT_WAIT_MS`) instead of a
   fixed guess.
2. **Client-side token pacing.** Every request reserves an estimated budget
   (chars/4 + output + overhead) from a sliding per-minute bucket
   (`TokenPacer`, `CLIENT_TOKEN_BUDGET_PER_MINUTE`). Requests that would exceed the
   budget wait until it refills, so per-page streaming naturally spaces out instead of
   firing doomed calls.
3. **Budget-sane call sizes.** Per-page output ≤ `PER_PAGE_MAX_TOKENS`, interaction
   windows ≤ `INTERACTION_WINDOW_CHAR_LIMIT`, chat context ≤ `ANALYSIS_CONTEXT_LIMIT`
   chars (page-aware: the asked-about page + neighbors, head-of-document fallback).

Rate-limit waits stay developer-facing (console). The UI keeps showing the current
step ("Analyzing page 3 of 9…") with a neutral "Still working on the contract…"
label during retries. Failures are contained so the analysis always completes:

- a page that fails after retries is skipped and logged (`analyzePage`),
- an interaction window that fails is skipped and logged, the rest continue,
- the final brief degrades to a deterministic synthesis of the gathered risks
  (`fallbackSynthesis`) instead of surfacing an error.

## Deterministic score
Weights:
- critical 95
- high 75
- medium 50
- low 25

Average all risks.
Clamp to 5–98.
Round.
No risks = 10.

The score is a UX heuristic, not a legal conclusion.

## JSON parsing
Accept:
- raw JSON,
- fenced JSON,
- surrounding prose where an object can safely be extracted.

Reject non-object output.

## Chat
Use plain text response mode.
Context:
- capped, page-aware contract excerpt (≤ `ANALYSIS_CONTEXT_LIMIT` chars; the
  asked-about page + neighbors, else the document head),
- analysis,
- user question.

The assistant must:
- quote actual clauses when possible,
- explain in plain language,
- distinguish facts from interpretation,
- avoid pretending to be a lawyer,
- remind users that the product is informational and professional legal advice may be needed.
