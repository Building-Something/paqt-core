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
- single-call max pages: 6
- single-call max chars: 25,000
- per-page max tokens: 6,144
- per-page reasoning effort: medium
- analysis context truncation: 80,000 chars
- interaction full-text char limit: 300,000
- interaction max tokens: 16,384

### Small document
One JSON-mode request (≤ 6 pages and 25k chars).

### Large document — per-page streaming
Documents beyond the single-call budget are analyzed page by page, in order, so
every page gets focused attention and results accumulate live:

1. For each page (sequentially): one JSON-mode request containing only that page,
   asking for `risks` and `keyTerms` for that page.
2. Normalize + deduplicate + sort the accumulated risk set after every page and
   surface it through progress, so the breakdown grows live during analysis.
3. After the last page, run the cross-clause interaction pass over the full text.

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
are structurally invisible to it. A final document-wide pass fixes exactly that:

1. Re-read the FULL extracted text (with page markers) via `extractContractText` —
   only when it fits `INTERACTION_FULL_TEXT_CHAR_LIMIT`; otherwise the pass is skipped
   gracefully.
2. Request JSON without strict JSON mode, at `reasoning_effort: high` (per-page
   extraction stays at `medium`), budgets `INTERACTION_MAX_TOKENS`.
3. The prompt feeds the full text + the already-identified risks and returns ONLY
   net-new cross-clause risks: contradictions, undermined protections, compounded
   exposures, broken cross-references, inconsistent definitions, coverage gaps.
   Each carries `pageNumber` plus `relatedPages`.
4. Deterministic grounding: every returned quote is verified against the real page
   text (`src/utils/riskVerify.ts`) — exact match first, then fuzzy token-overlap with
   a contiguous-run requirement. Page numbers are re-pinned to where the quote actually
   appears; findings with no verifiable quote are dropped.
5. Verified interaction risks merge with extraction risks and are normalized as one
   set before scoring and synthesis.

The pass is best-effort: any error skips it with a warning rather than failing the
analysis.

## Retry
Up to three attempts.
Retry:
- 429,
- 5xx,
- network failures.

Backoff:
`attempt * 1000ms`.

Do not retry malformed requests.

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
- relevant contract text,
- analysis,
- user question.

The assistant must:
- quote actual clauses when possible,
- explain in plain language,
- distinguish facts from interpretation,
- avoid pretending to be a lawyer,
- remind users that the product is informational and professional legal advice may be needed.
