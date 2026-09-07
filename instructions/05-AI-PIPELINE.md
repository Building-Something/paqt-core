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

### Small document
One JSON-mode request.

### Large document
1. Split pages.
2. Group into batches constrained by both page count and character count.
3. Analyze sequentially.
4. Normalize risks.
5. Deduplicate.
6. Sort.
7. Compute deterministic score.
8. Synthesize document-level metadata.
9. Assemble with field-level fallbacks.

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
