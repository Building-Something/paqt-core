# PAQT — MASTER IMPLEMENTATION INSTRUCTION

## Mission
Build **Paqt**, a production-quality AI contract risk analysis and review workspace.

The attached source specification is the functional baseline. It describes an app that:
- accepts a PDF contract,
- extracts text client-side with pdf.js,
- analyzes it with Groq through a same-origin Express proxy,
- supports page-aware risk detection for large documents,
- shows an overall risk score, risk breakdown, key terms, contract information, a risk list, an annotated PDF viewer, Excel export, and an AI chat assistant.

Treat those behaviors as the minimum product contract. Rename all product branding to **Paqt**. Do not carry over unrelated product concepts from any previous project.

## Product strategy — invented for Paqt
Paqt is positioned as **"the contract decision layer before you sign."**

Target user:
- founders and small-business operators,
- freelancers/agencies,
- procurement and operations teams,
- anyone who receives business contracts but cannot afford a full legal review every time.

Core promise:
> Upload a contract. Paqt tells you what matters, where it is, why it matters, and what you should do next.

The differentiator is not "AI summarizes contracts." It is **evidence-linked decision support**:
1. Every material risk points to a real page.
2. Every risk quotes the underlying clause.
3. Every recommendation explains the practical action.
4. The user can ask follow-up questions against the actual contract.
5. Large PDFs are analyzed incrementally rather than pretending one giant model call is reliable.

## Product principles
- Evidence before explanation.
- Never invent contract language.
- Never claim legal advice.
- Deterministic UI behavior around probabilistic AI.
- Graceful degradation when AI, PDF extraction, or network services fail.
- Server-side API secrets only.
- Deployment must be simple: one Node process serves the built SPA and API.
- A fresh clone must build and run without hidden manual steps.

## Important source-grounded baseline
Preserve the source specification's technical behaviors where applicable:
- React 18 + TypeScript + Vite + Tailwind.
- Same-origin `/api/groq` and `/api/health`.
- Express production server and Vite development proxy.
- `GROQ_API_KEY` server environment variable.
- Groq `openai/gpt-oss-120b` for analysis.
- `reasoning_effort: "low"` and `include_reasoning: false`.
- Client-side PDF extraction with page markers.
- Small-document single-pass path and large-document batched path.
- Risk normalization, deduplication, deterministic fallback scoring, synthesis.
- Annotated PDF viewer, risk list, chat, XLSX export.
- Strict TypeScript/lint/build acceptance gates.

## Security/deployment correction
Do NOT expose `GROQ_API_KEY` through `VITE_*`.
The browser must never call Groq directly.

Production topology:
Browser -> same-origin Express -> Groq API
Browser -> same-origin static SPA

Development topology:
Browser -> Vite -> `/api` proxy -> Express :3001 -> Groq

## Non-goals for v1
- No fake e-signature legal validity claims.
- No payment processing.
- No persistent cloud database unless explicitly added later.
- No user authentication requirement for the demo/MVP.
- No background job infrastructure.
- No external vector database.
- No invented legal citations.
- No automatic legal advice.

## Quality bar
The result should look like a serious SaaS product, not a generated demo:
- excellent responsive layout,
- coherent information hierarchy,
- empty/loading/error/success states,
- keyboard accessibility,
- no layout jumps during analysis,
- precise copy,
- polished micro-interactions,
- mobile usability,
- meaningful telemetry-free diagnostics through server logs,
- no console errors in the normal path.

## Required implementation sequence
Read all Paqt spec files in numerical order. Implement:
1. foundation/config,
2. shared types,
3. server,
4. PDF extraction + AI service,
5. analysis state,
6. UI shell,
7. analysis dashboard,
8. PDF annotation,
9. chat,
10. export,
11. test/verification,
12. deployment documentation.

Never skip verification because the UI "looks right."
