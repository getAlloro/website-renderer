/**
 * Versioned app imports, served from the site origin.
 *
 *   GET /api/imports/:filename/v/:version
 *
 * The same route shape the app serves (alloro `src/routes/imports.ts`), for the
 * references that `localizeVersionedImports` rewrites into page HTML. The bytes are
 * fetched from API_BASE_URL once and kept in Redis for the app's own max-age, so a
 * visitor's render-blocking stylesheet is one request on the connection they already
 * have instead of a second TLS connection to the app server. `?nocache=1` on a page
 * flushes the `imp:` keys with the rest (routes/site.ts).
 *
 * Runs BEFORE the subdomain middleware, like the JSON API: imports are global, not per
 * site. The unversioned `/api/imports/:filename` form is deliberately not handled here
 * and falls through to the site route like any other unknown path.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getRedis } from '../lib/redis';
import { getApiBaseUrl } from '../lib/apiBaseUrl';
import { VERSIONED_IMPORT_PATH } from '../utils/versionedImports';

const CACHE_PREFIX = 'imp:';
const DEFAULT_TTL = 3600; // the app's own Cache-Control max-age on these responses
const MIN_TTL = 60;
const MAX_TTL = 86400;
const ERROR_TTL = 60; // a 404/410 is remembered briefly so a bad reference cannot hammer the app
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

interface CachedImport {
  status: number;
  contentType: string;
  body: string; // base64
  ttl: number;
}

// Concurrent misses for the same key share one upstream fetch.
const inflight = new Map<string, Promise<CachedImport | null>>();

function ttlFromCacheControl(header: string | null): number {
  const match = /max-age=(\d+)/i.exec(header || '');
  if (!match) return DEFAULT_TTL;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, parseInt(match[1], 10)));
}

async function fetchUpstream(filename: string, version: string): Promise<CachedImport | null> {
  const url = `${getApiBaseUrl()}/api/imports/${filename}/v/${version}`;
  try {
    const upstream = await fetch(url, {
      headers: { 'accept-encoding': 'identity' },
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    // 200 is content; 404/410 are the app's own answers for an unknown or deprecated
    // version and are passed through. Anything else is an upstream failure.
    if (![200, 404, 410].includes(upstream.status)) {
      console.warn(`[imports] ${url} answered ${upstream.status}`);
      return null;
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > MAX_BODY_BYTES) {
      console.warn(`[imports] ${url} is ${buffer.length} bytes, above the ${MAX_BODY_BYTES} byte limit`);
      return null;
    }
    return {
      status: upstream.status,
      contentType: upstream.headers.get('content-type') || 'application/octet-stream',
      body: buffer.toString('base64'),
      ttl: upstream.status === 200 ? ttlFromCacheControl(upstream.headers.get('cache-control')) : ERROR_TTL,
    };
  } catch (err) {
    console.warn(`[imports] ${url} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function loadImport(filename: string, version: string): Promise<CachedImport | null> {
  const key = `${CACHE_PREFIX}${filename}:${version}`;
  const redis = getRedis();

  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as CachedImport;
  } catch {
    // Cache miss, corrupt entry or Redis down — fetch from the app
  }

  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchUpstream(filename, version)
      .then(async (entry) => {
        if (entry) {
          try {
            await redis.set(key, JSON.stringify(entry), 'EX', entry.ttl);
          } catch {
            // Cache write failure is non-fatal
          }
        }
        return entry;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

async function versionedImportHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  const match = VERSIONED_IMPORT_PATH.exec(req.path);
  if (!match) {
    next();
    return;
  }
  const [, filename, version] = match;

  const entry = await loadImport(filename, version);
  if (!entry) {
    res.status(502).set('Cache-Control', 'no-store').type('text/plain').send('Import unavailable');
    return;
  }

  res
    .status(entry.status)
    .set('Content-Type', entry.contentType)
    .set('Cache-Control', entry.status === 200 ? `public, max-age=${entry.ttl}` : 'no-store')
    .send(Buffer.from(entry.body, 'base64'));
}

export const importsRouter = Router();

importsRouter.get('/api/imports/:filename/v/:version', versionedImportHandler);
