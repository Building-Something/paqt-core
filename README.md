# Paqt

Paqt is an AI-assisted contract review workspace. It identifies potentially important clauses in a contract, links every finding to the exact page and quote, and lets users ask follow-up questions. It also composes agreements from a plain-English brief and runs the same review pipeline over the result.

> Paqt is a decision-support tool, not legal advice.

## Product surface

The app is organized as a contract workspace with a sidebar shell:

- **Dashboard** (`/`) — stats, quick actions, and recent activity across analyses and drafts. History lives in `localStorage` (`paqt.history.v1`) and is never sent to the server.
- **Analyze** (`/analyze`) — upload a PDF for a risk review, or reopen past reviews from browser history.
- **Workspace** (`/analysis?id=<history-id>`) — the full-width three-zone review: decision brief + risk list, document viewer (PDF or generated-draft sections), and the contract assistant. File analyses reopen as a read-only archive; generated-draft analyses re-run the review from the stored markdown.
- **Compose** (`/generate`) — a horizontal split view: the composer on the right (brief → clarifying questions → revise), and a Google-Docs-style rich text editor on the left where the drafted agreement is directly editable and automatically saved. One click exports a professionally formatted legal PDF. Drafts persist to browser history and reopen with `/generate?draft=<history-id>`.

## Quick start

Requirements: Node 20+, npm.

```bash
npm ci
cp .env.example .env     # then set GROQ_API_KEY
npm run dev
```

- SPA (Vite): <http://localhost:5173>
- API (Express): <http://localhost:3001> — Vite proxies `/api` to it in development.

Production:

```bash
npm ci
npm run build
npm start       # serves dist/ + API, honors $PORT (default 3001)
```

## Scripts

| Script            | Purpose                                              |
| ----------------- | ---------------------------------------------------- |
| `npm run dev`     | Vite + Express together (SPA on 5173, API proxied)   |
| `npm run build`   | `tsc -b` type-check then production bundle           |
| `npm start`       | Serve `dist/` and the API from Express               |
| `npm run preview` | Preview the built bundle                             |
| `npm run lint`    | ESLint over the repo                                 |
| `npm test`        | Run the Vitest + Testing Library suite (jsdom)        |
| `npm run test:watch` | Run Vitest in watch mode                           |
| `docker compose up --build -d` | Run frontend + backend containers       |

## Repository layout

```
server/               Express server (Node, no build step)
  index.mjs           static SPA + /api/groq proxy + /api/health, $PORT support
  groqProxy.mjs       Groq request; server-owned model/temperature/reasoning
  dev.mjs             dev bootstrap (Vite + API)
src/
  main.tsx, App.tsx   entry + routes; AnalysisProvider wraps the app
  components/         sidebar shell, three-zone workspace, markdown, chat, dropzone,
                      ContractEditor + ContractToolbar (TipTap rich text), …
  pages/              Dashboard, AnalyzeHub, Analysis (workspace), Generate, About, Privacy
  contexts/           AnalysisContext — session state, pipeline, chat, history record
  services/           pdfService (pdf.js extraction), groqService (chat + batch analyze),
                      draftService (ask/generate/revise), historyService (localStorage),
                      exportService (downloads), pdfExportService (PDF via pdfmake)
  hooks/              useServerHealth, useHistory (live subscription to history)
  utils/              batching, risk normalization/dedup/scoring, draft sectioning,
                      contractDocument (markdown <-> editor JSON + pdfmake doc-definition),
                      JSON parsing
  types/              shared types (risk, analysis, session, progress…)
public/fonts/         Liberation Serif TTFs (on-screen editor + embedded in PDF exports)
scripts/
  verify-core.ts      browser-free assertion suite for the core logic (npx tsx)
  verify-compose.ts   markdown <-> editor JSON round-trips + PDF doc-definition checks
  verify-pdf.ts       end-to-end pdfmake render (multi-page PDF with embedded fonts)
instructions/         product/architecture specs the implementation was built against
```

## How the review pipeline works

1. **Extraction (client).** pdf.js pulls text from the PDF in the browser — the raw file never leaves the client.
2. **Routing.** Documents that fit one request (≤ 6 pages / 25k chars, `src/constants/pipeline.ts`) use a single AI call. Anything larger switches to **per-page streaming**: each page is analyzed individually and in order so every page gets focused attention, findings accumulate live into the risk breakdown, and the analysis can be interrupted, left, and resumed from the last analyzed page instead of restarting.
3. **Analysis (server).** Each page is sent to Groq through Paqt’s `/api/groq` proxy with strict server-side model, temperature, and reasoning settings. The model returns structured findings (JSON) — parsing is defensive (`src/utils/json.ts`).
4. **Checkpoints (client).** After every analyzed page, progress is saved under `paqt.checkpoints.v1` (`src/services/checkpointService.ts`) — findings, key terms, the page reached, and (when the PDF is small enough) the file itself, so a paused review can resume later or after a reload. Completed analyses move into history and the checkpoint is cleared.
5. **Cross-clause pass (server).** Because single-page extraction cannot see risks hidden across clauses, a document-wide pass hunts for conflicts, contradictions, compounded exposures, broken cross-references, and undermined protections. To stay inside the model's per-minute token budget it runs in **overlapping windows** (a bounded slice of pages per call, `INTERACTION_WINDOW_CHAR_LIMIT`) instead of one giant full-text request, always at the highest supported reasoning effort (`high`). Every new finding is deterministically verified against the real page text — quotes are matched (exact then fuzzy), page numbers re-pinned, and anything unverifiable is dropped (`src/utils/riskVerify.ts`, `groqService.findInteractionRisks`). Interaction risks can carry a `relatedPages` list shown in the UI.
6. **Normalization.** Risks are deduplicated, typed, sorted by page then severity, and scored with a deterministic heuristic (`src/utils/risks.ts`). Scores are 0–100 decision-support signals, defaulting to 10 when no risks are found.
7. **Chat.** The assistant answers with a **capped, page-aware excerpt** of the extracted text (the asked-about page plus neighbors, or the document head, ≤ `ANALYSIS_CONTEXT_LIMIT` chars) plus the full analysis, so answers reference real clauses without burning the whole contract per message.

All AI configuration (model, key, timeout, reasoning prompts) lives on the server. The browser bundle never contains `GROQ_API_KEY`.

## AI rate limiting

The Groq free plan publishes tight limits for `openai/gpt-oss-120b`: 30 requests/min, 1,000 requests/day, and **8K tokens/min (TPM)**. Paqt applies defense-in-depth so those limits surface as slow-but-working, not hard failures:

- **Reset-aware retries** — the proxy forwards Groq's `retry-after` and `x-ratelimit-*` headers and puts a machine-readable `retryAfterMs` on every 429 body. The client retries after the *real* reset window (capped at `MAX_RATE_LIMIT_WAIT_MS`) instead of a fixed ~1s guess that just burns the window and re-429s.
- **Client-side token pacing** — every request reserves an estimated token budget (chars/4 + output + overhead) from a sliding per-minute bucket (`CLIENT_TOKEN_BUDGET_PER_MINUTE`, `src/services/tokenPacer.ts`). Calls that would land a doomed request simply wait until budget refills, which smoothly spaces large-document pipelines.
- **Budget-sane call sizes** — per-page extraction ships ≤ `PER_PAGE_MAX_TOKENS` of output, the interaction pass runs in ≤ `INTERACTION_WINDOW_CHAR_LIMIT` overlapping windows, and chat context is capped at `ANALYSIS_CONTEXT_LIMIT` chars — so no single call approaches the ~8K tokens/min ceiling by itself.
- **Honest, unobtrusive states** — rate-limit waits are developer-facing only (console). The progress panel keeps showing the current step ("Analyzing page 3 of 9…") with a neutral "Still working on the contract…" label during retries. If an individual request still fails after retries, that page or interaction window is skipped and logged, and the brief is synthesized deterministically from the findings already gathered — the analysis completes instead of dying at the last step.

If the free tier is too slow for production use, upgrade to the Groq Developer plan for higher RPM/TPM, or raise `CLIENT_TOKEN_BUDGET_PER_MINUTE` alongside it.

## Drafting flow

`/generate` runs a small agentic loop:

1. **Brief** → the drafting service asks a few targeted clarifying questions.
2. **Questions** → answers (or skips) → a full legal-style Markdown agreement with numbered sections (`## 1. …`, `### 1.1 …`), WHEREAS recitals, placeholder brackets like `[Client Full Legal Name]`, and a `## SIGNATURES` section (`src/services/draftService.ts`).
3. **Draft** → Markdown is converted to TipTap editor JSON (`markdownToDoc` in `src/utils/contractDocument.ts`) and opened in a rich text editor (StarterKit + Underline + TextAlign) on the left, styled like a legal document in `Liberation Serif`. Edits flow back through `docToMarkdown` and are autosaved to history (debounced), plus persisted to `draftDoc` so the exact formatting is preserved on reopen.
4. **Revise** → a natural-language instruction rewrites the whole agreement consistently.
5. **Export PDF** → `pdfExportService` loads the Liberation Serif TTFs (TTF → base64 → pdfmake vfs), builds a letter-size legal layout (`buildContractPdfDoc`: margins, title block, justified sections, uppercase section headings, page footer, auto-generated signature lines after IN WITNESS WHEREOF), and downloads the PDF.
6. **Analyze for risks** → the live Markdown of the draft becomes analysis pages and runs through the same review pipeline (`beginWithText`).

## Client-side history

`src/services/historyService.ts` stores up to 40 entries under `paqt.history.v1`:

- `kind: 'analysis'` — the full `ContractAnalysis` payload (summary, score, risks, recommendations) plus `pageCount`; generated-draft analyses also store the draft markdown.
- `kind: 'draft'` — brief, markdown, editor JSON (`draftDoc`, optional for older entries), and section count for composition.

Entries are written on analysis completion and draft generation, and are re-opened via query params (`?id=`, `?draft=`). No contract text or documents are persisted server-side. A tiny pub/sub (`subscribeHistory`) keeps dashboard/analyze lists live; `useHistory` wraps it in a hook.

## Verified routes (production server)

```bash
curl http://localhost:3001/api/health      # {"configured":true} when GROQ_API_KEY is set
curl http://localhost:3001/                # SPA
curl http://localhost:3001/analyze         # SPA fallback
```

## Verification

```bash
npm run lint
npx tsc --noEmit -p tsconfig.app.json      # strict type-check
npm test                                  # component + unit tests (Vitest, jsdom)
npm run build
npx tsx scripts/verify-core.ts             # core-logic assertions (ALL PASS)
npx tsx scripts/verify-compose.ts          # markdown <-> editor JSON / PDF def checks
npx tsx scripts/verify-pdf.ts              # end-to-end pdfmake render (multi-page PDF)
```

### Tests

`npm test` runs the Vitest suite in a jsdom environment (React Testing Library for

components, plain Vitest for pure logic). Note that each gate above serves a distinct

purpose:

- `scripts/verify-*.ts` run with `npx tsx` as a before-you-commit sanity check on pure

  logic (they exit non-zero on failure but are not a test runner).
- `npm test` is the real regression suite and should be kept green as features evolve:

  - `src/pages/GeneratePage.test.tsx` — brief/draft rendering and the draft → analyze

    navigation (verifies Analyze for risks navigates immediately, before the Groq

    pipeline resolves).
  - `src/utils/contractDocument.test.ts` — markdown ↔ editor-JSON round-trips, marks,

    flattening, signature detection, and the pdfmake doc-definition structure.

Add a test alongside any new feature; run `npm run test:watch` while developing.

## Deployment

### Docker (recommended)

Two containers on a bridge network:

- `paqt-frontend` — builds the SPA in a Node stage, serves it with nginx (hashed-asset immutable caching, SPA fallback), proxies `/api` to the backend. Published on `8080`.
- `paqt-backend` — Node/Express, API only. Not published to the host; reachable only from nginx.

```bash
docker compose up --build -d
# frontend: http://localhost:8080
```

- `GROQ_API_KEY` is loaded from the local `.env` via compose `env_file` — never baked into an image.
- Both services have healthchecks and `restart: unless-stopped`.
- Stop: `docker compose down`.

### Plain Node (no Docker)

`npm ci && npm run build && npm start` with `GROQ_API_KEY` set. Works on Render, Railway, Fly.io, or any platform that runs a Node process with a public port (`$PORT` is honored).

## Privacy model

PDF extraction happens in the browser. Extracted contract text is sent to Groq through Paqt’s server proxy for analysis. The MVP has no database and does not promise permanent storage.

## Legal disclaimer

Paqt provides AI-generated informational analysis and is not a substitute for qualified legal counsel. Users should obtain professional advice before making material legal or commercial decisions.