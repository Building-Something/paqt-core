# PAQT — IMPLEMENTATION CHECKLIST

## Phase 1 — Foundation
- [ ] package.json
- [ ] Vite
- [ ] Tailwind
- [ ] TypeScript strict
- [ ] ESLint
- [ ] routing
- [ ] `.env.example`
- [ ] `.gitignore`

## Phase 2 — Server
- [ ] raw-body Groq proxy
- [ ] health endpoint
- [ ] timeout
- [ ] request size limit
- [ ] structured errors
- [ ] production static hosting
- [ ] SPA fallback
- [ ] dev process runner

## Phase 3 — PDF/AI
- [ ] pdf.js extraction
- [ ] page markers
- [ ] small-document path
- [ ] batched path
- [ ] retry
- [ ] normalization
- [ ] dedupe
- [ ] deterministic score
- [ ] synthesis
- [ ] chat

## Phase 4 — UI
- [ ] landing
- [ ] upload
- [ ] progress
- [ ] summary
- [ ] risk list
- [ ] PDF viewer
- [ ] risk markers
- [ ] chat
- [ ] export
- [ ] disclaimer

## Phase 5 — Polish
- [ ] responsive
- [ ] keyboard accessibility
- [ ] error states
- [ ] empty states
- [ ] loading states
- [ ] mobile layout
- [ ] no console errors

## Phase 6 — Deployment
- [ ] production build
- [ ] `npm start`
- [ ] `/api/health`
- [ ] secret not in bundle
- [ ] test host `$PORT`
- [ ] README deployment instructions

## Final gate
Do not declare Paqt complete until every acceptance item is verified.
