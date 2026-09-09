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
- pages per batch: 8
- batch char limit: 20,000
- batch max tokens: 4,096
- analysis context truncation: 80,000 chars
- interaction full-text char limit: 300,000
- interaction max tokens: 16,384

### Small document
One JSON-mode request.

### Large document
1. Split pages.
2. Group into batches constrained by both page count and character count.
3. Analyze sequentially.
4. Normalize risks.
5. Deduplicate.
6. Sort.

### Cross-clause interaction pass (both paths)
The per-batch/single-pass extraction is intentionally local: it is told to analyze
only supplied pages, so risks that live across clauses or in clause interactions are
structurally invisible to it. A final document-wide pass fixes exactly that:

1. Re-read the FULL extracted text (with page markers) via `extractContractText` —
   only when it fits `INTERACTION_FULL_TEXT_CHAR_LIMIT`; otherwise the pass is skipped
   gracefully.
2. Request JSON without strict JSON mode, at `reasoning_effort: high` (per-page
   extraction stays at `low`), budgets `INTERACTION_MAX_TOKENS`.
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

Never parallelize batches by default because rate limits and ordering matter.

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
