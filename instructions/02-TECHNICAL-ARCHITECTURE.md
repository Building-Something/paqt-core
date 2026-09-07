# PAQT — TECHNICAL ARCHITECTURE

## Stack
- React 18
- TypeScript strict
- Vite
- Tailwind CSS
- React Router
- Express 5
- pdfjs-dist
- react-pdf
- react-markdown
- xlsx
- file-saver
- lucide-react
- Groq API through server proxy

Use the versions from the supplied baseline where compatible. Do not add packages casually.

## Runtime topology

### Development
Vite serves the SPA.
Express runs on port 3001.
Vite proxies `/api` to Express.

### Production
Express serves `dist/` and `/api/*` from one origin.

This enables deployment to:
- Render,
- Railway,
- Fly.io,
- a conventional Node VM/container,
- any platform capable of running a Node process with a public port.

## Directory
```text
paqt/
  server/
    dev.mjs
    index.mjs
    groqProxy.mjs
  src/
    components/
    pages/
    services/
    contexts/
    hooks/
    types/
    utils/
    App.tsx
    main.tsx
    index.css
  public/
  index.html
  vite.config.ts
  tailwind.config.js
  postcss.config.js
  tsconfig.app.json
  tsconfig.node.json
  eslint.config.js
  package.json
  .env.example
  .gitignore
  README.md
```

## API
### GET /api/health
Returns:
```json
{"configured":true}
```
or false.

### POST /api/groq
Accepts the subset of chat completion request data needed by Paqt:
- messages,
- temperature,
- max_tokens,
- response_format.

The server owns:
- model selection,
- API key,
- timeout,
- reasoning settings.

Do not allow the browser to override the model.

## Server safety
- No `express.json()` before the raw-body proxy.
- Enforce request size.
- Validate JSON.
- Validate `messages`.
- Return structured errors.
- Never return the API key.
- Never log full contract contents.
- Never log authorization headers.

## State
MVP may use React state/context for the active analysis. Route navigation must not lose the current session.

If persistence is added later, isolate it behind a repository/service boundary.
