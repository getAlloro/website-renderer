import { writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
dotenv.config();

import 'express-async-errors';
import express, { Request, Response, NextFunction } from 'express';
import { siteRoute } from './routes/site';
import { worktreeGenerationPreviewRoute } from './routes/generation-preview';
import { verifyDomainRoute } from './routes/verify-domain';
import { apiRouter } from './routes/api';
import { extractSubdomain } from './middleware/subdomain';
import { securityHeaders } from './middleware/securityHeaders';
import { responseCompression } from './middleware/responseCompression';
import { importsRouter } from './routes/imports';
import { getDb } from './lib/db';
import { closeRedis } from './lib/redis';
import { wrapInLayout } from './templates/layout';

const app = express();
const localRuntime = process.env.ALLORO_WORKTREE_TEST_MODE === 'true';
if (localRuntime && (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_NAME !== 'alloro_test' || process.env.DB_SSL !== 'false')) throw new Error('Local renderer database guard refused.');
const PORT = Number(process.env.PORT ?? 7777);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('Invalid renderer port.');

// Do not advertise the server framework; send the baseline security headers on every response.
app.disable('x-powered-by');
app.use(securityHeaders);

// Brotli/gzip every compressible body for clients that accept it (see the middleware).
app.use(responseCompression);

// Ignore favicon requests
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Caddy on-demand TLS validation (must be before subdomain middleware)
app.get('/verify-domain', verifyDomainRoute);

// Public JSON API (must be before subdomain middleware — uses :hostname path param)
app.use(apiRouter);

// Versioned app imports served from the site origin (global, so also before subdomain middleware)
app.use(importsRouter);

if (localRuntime) app.get('/__worktree/generation/:projectId/:runId', worktreeGenerationPreviewRoute);

// Extract subdomain, then render site
app.use(extractSubdomain);
app.get('*', siteRoute);

// Global error handler — catches DB connection errors, etc.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Renderer Error]', err.message);
  const body = `
<div style="text-align:center;padding:3rem 2rem;max-width:500px;">
  <h1 style="color:#1f2937;font-size:1.5rem;font-weight:700;margin-bottom:1rem;">Something went wrong</h1>
  <p style="color:#6b7280;font-size:1rem;line-height:1.6;">We're having trouble loading this page. Please try again in a moment.</p>
</div>`;
  res.status(500).type('html').send(wrapInLayout('Error', body));
});

const server = app.listen(PORT, localRuntime ? '127.0.0.1' : '0.0.0.0', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Renderer listener missing.');
  if (localRuntime && process.env.ALLORO_RENDERER_READY_FILE) {
    const hostname = process.env.ALLORO_RENDERER_HOSTNAME;
    if (!hostname || !/^alloro-test-[a-f0-9]{12}-[a-f0-9]{8}\.localhost$/.test(hostname)) throw new Error('Invalid local renderer hostname.');
    writeFileSync(process.env.ALLORO_RENDERER_READY_FILE, JSON.stringify({ port: address.port, origin: `http://${hostname}:${address.port}` }), { mode: 0o600 });
  }
  console.log(`Site renderer listening on port ${address.port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(async () => {
    await closeRedis();
    getDb().destroy();
    process.exit(0);
  });
});
