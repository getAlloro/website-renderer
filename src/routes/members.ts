/**
 * Site member sign-in routes
 *
 * Same-origin routes on the site's own domain. The browser talks only to this
 * renderer; the renderer forwards to the Alloro app with a shared secret, the site
 * host and the visitor address, then sets or clears the host-only session cookie.
 * The session token never reaches page script: /verify removes it from the answer.
 *
 * Mounted AFTER the subdomain middleware (the site host must be known) and BEFORE
 * the catch-all site route. JSON bodies are parsed here and nowhere else, capped at
 * 8 KiB. Nothing here reads or writes the database.
 *
 * Never log an email, a code, a token or a cookie from this file.
 */

import express, { Router, Request, Response, NextFunction } from 'express';
import { getApiBaseUrl } from '../lib/apiBaseUrl';
import {
  buildClearMemberCookie,
  buildMemberCookie,
  hostWithoutPort,
  isSameSiteJsonPost,
  isValidMemberToken,
  readMemberToken,
  resolveVisitorIp,
  safeNextPath,
} from '../middleware/memberSession';

const APP_PATH = '/api/site-members-public';
const UPSTREAM_TIMEOUT_MS = 10_000;
const BODY_LIMIT = '8kb';

// Must match the header and env names in the app's config/siteMembers.ts.
const SECRET_ENV = 'SITE_MEMBERS_RENDERER_SECRET';
const SECRET_HEADER = 'x-alloro-renderer-secret';
const SITE_HOST_HEADER = 'x-alloro-site-host';
const VISITOR_IP_HEADER = 'x-alloro-visitor-ip';
const MEMBER_TOKEN_HEADER = 'x-alloro-member-token';

const MAX_EMAIL_LENGTH = 320;
const MAX_CODE_LENGTH = 64;
const MAX_NEXT_LENGTH = 512;
const HOST_SHAPE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

interface Envelope {
  success: boolean;
  data: unknown;
  error: { code: string; message: string } | null;
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, data: null, error: { code, message } } satisfies Envelope);
}

function unavailable(res: Response): void {
  fail(res, 503, 'MEMBERS_UNAVAILABLE', 'Sign-in is not available right now. Please try again.');
}

function isEnvelope(value: unknown): value is Envelope {
  return !!value && typeof value === 'object' && typeof (value as { success?: unknown }).success === 'boolean';
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

/** The site host this request was served on, without a port. Null when it is not a plain hostname. */
function siteHost(req: Request): string | null {
  const host = hostWithoutPort(req.headers.host);
  return HOST_SHAPE.test(host) ? host : null;
}

interface UpstreamCall {
  method: 'GET' | 'POST';
  path: '/code' | '/verify' | '/session' | '/signout';
  host: string;
  visitorIp: string | null;
  token?: string | null;
  body?: Record<string, string>;
}

/**
 * One call to the app. Null means "not available": no secret configured, a network
 * failure, a timeout, or an answer that is not the agreed envelope.
 */
async function callApp(call: UpstreamCall): Promise<{ status: number; envelope: Envelope } | null> {
  const secret = process.env[SECRET_ENV];
  if (!secret) return null;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    [SECRET_HEADER]: secret,
    [SITE_HOST_HEADER]: call.host,
  };
  if (call.visitorIp) headers[VISITOR_IP_HEADER] = call.visitorIp;
  if (call.token) headers[MEMBER_TOKEN_HEADER] = call.token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${getApiBaseUrl()}${APP_PATH}${call.path}`, {
      method: call.method,
      headers,
      body: call.method === 'POST' ? JSON.stringify(call.body ?? {}) : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });
    const envelope: unknown = await upstream.json();
    if (!isEnvelope(envelope)) {
      console.warn(`[members] ${call.path} answered ${upstream.status} without the expected envelope`);
      return null;
    }
    return { status: upstream.status, envelope };
  } catch (err) {
    // The error name only (AbortError, TypeError, SyntaxError): a message could carry request detail.
    console.warn(`[members] ${call.path} failed: ${err instanceof Error ? err.name : 'unknown error'}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store');
  next();
}

/** Cross-site defence for every POST: see isSameSiteJsonPost. Runs before the body is read. */
function requireSameSiteJsonPost(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') {
    next();
    return;
  }
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  if (!isSameSiteJsonPost({ origin, host: req.headers.host, contentType: req.headers['content-type'] })) {
    fail(res, 403, 'FORBIDDEN', 'This request is not allowed.');
    return;
  }
  next();
}

function context(req: Request, res: Response): { host: string; visitorIp: string | null } | null {
  const host = siteHost(req);
  if (!host) {
    fail(res, 400, 'INVALID_REQUEST', 'This request is not valid.');
    return null;
  }
  return { host, visitorIp: resolveVisitorIp(req.socket.remoteAddress, req.headers['x-forwarded-for']) };
}

export const membersRouter = Router();

membersRouter.use('/_members', noStore, requireSameSiteJsonPost, express.json({ limit: BODY_LIMIT, type: 'application/json' }));

membersRouter.post('/_members/code', async (req: Request, res: Response) => {
  const ctx = context(req, res);
  if (!ctx) return;
  const email = boundedString(req.body?.email, MAX_EMAIL_LENGTH);
  if (!email) {
    fail(res, 400, 'INVALID_REQUEST', 'Enter your email address.');
    return;
  }

  const result = await callApp({ method: 'POST', path: '/code', ...ctx, body: { email } });
  if (!result) {
    unavailable(res);
    return;
  }
  res.status(result.status).json(result.envelope);
});

membersRouter.post('/_members/verify', async (req: Request, res: Response) => {
  const ctx = context(req, res);
  if (!ctx) return;
  const email = boundedString(req.body?.email, MAX_EMAIL_LENGTH);
  const code = boundedString(req.body?.code, MAX_CODE_LENGTH);
  if (!email || !code) {
    fail(res, 400, 'INVALID_REQUEST', 'Enter your email address and the code we sent you.');
    return;
  }
  const body: Record<string, string> = { email, code };
  const next = boundedString(req.body?.next, MAX_NEXT_LENGTH);
  if (next) body.next = safeNextPath(next);

  const result = await callApp({ method: 'POST', path: '/verify', ...ctx, body });
  if (!result) {
    unavailable(res);
    return;
  }
  if (result.status !== 200 || !result.envelope.success) {
    // A refusal carries no token. Rebuilt rather than passed through so nothing extra can ride along.
    res.status(result.status === 200 ? 502 : result.status).json({ success: false, data: null, error: result.envelope.error ?? null });
    return;
  }

  const data = result.envelope.data as { token?: unknown; next?: unknown } | null;
  if (!data || !isValidMemberToken(data.token)) {
    console.warn('[members] /verify answered 200 without a usable session');
    unavailable(res);
    return;
  }

  res.append('Set-Cookie', buildMemberCookie(data.token, req.headers.host));
  res.status(200).json({ success: true, data: { next: safeNextPath(data.next) }, error: null } satisfies Envelope);
});

membersRouter.get('/_members/session', async (req: Request, res: Response) => {
  res.vary('Cookie');
  const token = readMemberToken(req.headers.cookie);
  // No cookie means not signed in. Answered here so an ordinary visitor costs the app nothing.
  if (!token) {
    res.status(200).json({ success: true, data: { signedIn: false, firstName: null }, error: null } satisfies Envelope);
    return;
  }
  const ctx = context(req, res);
  if (!ctx) return;

  const result = await callApp({ method: 'GET', path: '/session', ...ctx, token });
  if (!result) {
    unavailable(res);
    return;
  }
  res.status(result.status).json(result.envelope);
});

membersRouter.post('/_members/signout', async (req: Request, res: Response) => {
  const token = readMemberToken(req.headers.cookie);
  const host = siteHost(req);
  // Ask the app to revoke the session, then clear the cookie whatever the app said:
  // the visitor asked to be signed out of this browser.
  if (token && host) {
    await callApp({
      method: 'POST',
      path: '/signout',
      host,
      visitorIp: resolveVisitorIp(req.socket.remoteAddress, req.headers['x-forwarded-for']),
      token,
    });
  }
  res.append('Set-Cookie', buildClearMemberCookie(req.headers.host));
  res.status(200).json({ success: true, data: { signedOut: true }, error: null } satisfies Envelope);
});

// Anything else under /_members is not a page: never let it fall through to the site route.
membersRouter.all(['/_members', '/_members/*'], (_req: Request, res: Response) => {
  fail(res, 404, 'NOT_FOUND', 'Not found.');
});

// Body-parser refusals (too large, not JSON) answer in the same envelope, not the HTML error page.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
membersRouter.use('/_members', (err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.too.large') {
    fail(res, 413, 'INVALID_REQUEST', 'This request is too large.');
    return;
  }
  if (err.status === 400) {
    fail(res, 400, 'INVALID_REQUEST', 'This request is not valid.');
    return;
  }
  console.error('[members] route error:', err.name);
  unavailable(res);
});
