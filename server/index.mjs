import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { groqProxyHandler, initKey, isBillingConfigured } from './groqProxy.mjs';

const distPath = fileURLToPath(new URL('../dist', import.meta.url));
const indexHtmlPath = join(distPath, 'index.html');
const port = process.env.PORT || 3001;

const configured = initKey();
const billingConfigured = isBillingConfigured();

const app = express();

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ configured, billingConfigured });
});

app.use('/api/groq', groqProxyHandler);

app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Unknown API route.' } });
});

if (existsSync(distPath)) {
  app.use(express.static(distPath));

  app.use((req, res, next) => {
    if (req.method === 'GET' && req.accepts('html')) {
      res.sendFile(indexHtmlPath);
      return;
    }
    next();
  });
}

app.listen(port, () => {
  console.log(`[paqt] server listening on http://localhost:${port}`);
  console.log(
    `[paqt] groq ${configured ? 'configured' : 'NOT configured (set GROQ_API_KEY)'}`,
  );
  console.log(
    `[paqt] plan enforcement ${billingConfigured ? 'ON' : 'OFF (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to gate /api/groq on an active plan)'}`,
  );
  console.log(
    `[paqt] serving ${existsSync(distPath) ? 'dist/' : 'API only (dist/ not built)'}`,
  );
});