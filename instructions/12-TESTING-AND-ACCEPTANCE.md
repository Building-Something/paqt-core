# PAQT — TESTING + ACCEPTANCE

## Static checks
```bash
npm ci
npm run lint
npx tsc --noEmit -p tsconfig.app.json
npm run build
```

All must pass.

## Server checks
Start:
```bash
npm start
```

Health:
```bash
curl http://localhost:3001/api/health
```

Expected JSON:
```json
{"configured":true}
```
when `GROQ_API_KEY` is present.

## API smoke test
POST a JSON-mode request through `/api/groq`.
Confirm:
- 200 response,
- valid JSON content,
- server owns model and reasoning settings.

## Functional tests
### Small PDF
- upload,
- extract,
- single-pass analysis,
- render score,
- render risks,
- chat,
- export.

### Large PDF
- progress shows real page ranges,
- batches are sequential,
- risks retain correct page numbers,
- duplicate risks are removed,
- synthesis completes.

### Failure tests
- missing key,
- invalid key,
- 429,
- timeout,
- malformed JSON,
- empty PDF,
- scanned/image-only PDF,
- oversized request.

## UX acceptance
- responsive at 360px width,
- no horizontal page overflow,
- all buttons keyboard accessible,
- modals closable,
- no console errors in normal flow.

## Security acceptance
- no `GROQ_API_KEY` in client bundle,
- no direct browser call to api.groq.com,
- no contract text in server logs,
- `.env` is gitignored.

## Product acceptance
A first-time user should understand within 10 seconds:
1. what Paqt does,
2. what to upload,
3. what the result means,
4. where the evidence comes from,
5. that the output is informational, not legal advice.
