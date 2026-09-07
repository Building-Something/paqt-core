# PAQT

Paqt is an AI-assisted contract review workspace that identifies potentially important clauses, links findings to document pages, and lets users ask questions about the contract.

## Local setup

Requirements:
- Node 20+
- npm

```bash
npm ci
cp .env.example .env
```

Set:
```env
GROQ_API_KEY=your_key
```

Run:
```bash
npm run dev
```

Production:
```bash
npm ci
npm run build
npm start
```

## Deployment
Deploy as one Node service.

Build:
`npm ci && npm run build`

Start:
`npm start`

Set:
`GROQ_API_KEY`

If the host supplies `PORT`, Express must use it.

## Privacy model
In MVP, PDF extraction happens in the browser. The extracted contract text is sent to Groq through Paqt's server proxy for analysis. The MVP does not require a database and does not promise permanent storage.

Do not describe this as "private" or "secure" beyond what the implementation can prove.

## Legal disclaimer
Paqt provides AI-generated informational analysis and is not a substitute for qualified legal counsel. Users should obtain professional advice for material legal or commercial decisions.
