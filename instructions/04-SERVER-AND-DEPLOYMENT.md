# PAQT — SERVER + DEPLOYMENT

## Environment
`.env.example`
```env
GROQ_API_KEY=
PORT=3001
```

Never use `VITE_GROQ_API_KEY`.

## groqProxy.mjs
Constants:
- Groq endpoint: `https://api.groq.com/openai/v1/chat/completions`
- model: `openai/gpt-oss-120b`
- body limit: 20 MB
- upstream timeout: 120 seconds
- reasoning effort: low
- include reasoning: false

`initKey()` should load the server environment and never crash merely because `.env` is absent.

### Request behavior
1. Accept POST only.
2. Read raw body.
3. Reject oversize payload.
4. Parse JSON.
5. Require non-empty `messages`.
6. Construct upstream request with server-owned model and reasoning controls.
7. Forward upstream status/body.
8. Map timeout to 504.
9. Map upstream connectivity failure to 502.
10. Never expose secrets.

## index.mjs
- initialize key,
- create Express app,
- serve `dist`,
- mount `/api`,
- SPA fallback for non-API GET requests,
- listen on `process.env.PORT || 3001`.

Do not put `express.json()` in front of the raw-body handler.

## dev.mjs
Run Vite and Express together.
Terminate both when either exits or the process receives SIGINT/SIGTERM.

## Deployment contract
Build:
```bash
npm ci
npm run build
```

Run:
```bash
npm start
```

Expected:
- Express binds to `$PORT` when provided.
- `/api/health` works.
- `/` serves the SPA.
- client-side routes return `index.html`.

## Render/Railway/Fly-style deployment
- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Environment variable: `GROQ_API_KEY`
- No secret belongs in the repository.

## Production hardening
- set a sensible body limit,
- timeout upstream requests,
- avoid logging contract text,
- show actionable errors,
- add a health endpoint,
- keep the app stateless in MVP,
- document that uploaded PDFs are processed in-browser and are not persisted by Paqt's MVP server.
