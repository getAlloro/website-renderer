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
 * GET /_members/files/:id is the stable address of a library file. The app decides who
 * may open it; an allowed member is redirected to a signed link that lasts five minutes.
 * That link appears in the Location header of that redirect and nowhere else.
 *
 * Courses (getAlloro/alloro plans/11192026-site-courses-library, T6), all private and no-store:
 *   GET    /_members/courses                 the member's courses
 *   GET    /_members/courses/:slug           one course's lessons, open or locked, done or not
 *   GET    /_members/lessons/:postId         one post's done mark and attached files
 *   POST   /_members/lessons/:postId/done    mark it done      DELETE  the same address: undo
 * The app decides everything (switch, session, groups, which website owns the post); these
 * routes check the shape of the address, forward the session cookie's token, and pass the
 * answer through.
 *
 * Never log an email, a code, a token or a cookie from this file.
 */

import express, { Router, Request, Response, NextFunction } from 'express';
import { getApiBaseUrl } from '../lib/apiBaseUrl';
import { memberForbiddenPage } from '../templates/member-forbidden';
import { pageNotFoundPage } from '../templates/page-not-found';
import {
  buildClearMemberCookie,
  buildMemberCookie,
  buildSignInRedirect,
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

const FILES_PATH = '/_members/files/';
const FILE_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNED_LINK_SHAPE = /^https:\/\/[^\s]+$/;
// Must match the codes in the app's SiteMembersPublicError.ts.
const FILE_FORBIDDEN_CODE = 'SITE_MEMBERS_FILE_FORBIDDEN';
const FILE_UNAVAILABLE_MESSAGE = 'This file is not available right now. Please try again.';
const FILE_BUSY_MESSAGE = 'Too many tries. Please wait a while and try again.';

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
  path:
    | '/code' | '/verify' | '/session' | '/signout' | '/files/open'
    | '/courses/list' | '/courses/outline' | '/lessons/state' | '/lessons/done' | '/lessons/undo';
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

// The one DELETE route (undo a lesson's done mark), as the router sees it under /_members.
// Matched case-blind with an optional trailing slash, as Express matches the route itself.
const LESSON_DONE_SUBPATH = /^\/lessons\/[^/]+\/done\/?$/i;

/** True for a write this router serves: every POST, and the lesson-done DELETE. */
function isWrite(req: Request): boolean {
  return req.method === 'POST' || (req.method === 'DELETE' && LESSON_DONE_SUBPATH.test(req.path));
}

/**
 * Cross-site defence for every write: see isSameSiteJsonPost. Runs before the body is read.
 * Any other DELETE is left to answer 404 below, as it always has.
 */
function requireSameSiteJsonPost(req: Request, res: Response, next: NextFunction): void {
  if (!isWrite(req)) {
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

/** The signed link in an allowed answer, or null when the answer does not carry a usable one. */
function signedLinkFrom(envelope: Envelope): string | null {
  const url = (envelope.data as { url?: unknown } | null)?.url;
  return envelope.success && typeof url === 'string' && SIGNED_LINK_SHAPE.test(url) ? url : null;
}

/**
 * A library file's stable address. The app is asked every time, signed in or not, so a
 * site with members off answers 404 here exactly as the app does. The member is whoever
 * the session cookie belongs to; nothing in the address names one.
 */
membersRouter.get(`${FILES_PATH}:id`, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'private, no-store').set('X-Robots-Tag', 'noindex, nofollow').vary('Cookie');
  const fileId = String(req.params.id).toLowerCase();
  const host = siteHost(req);
  if (!host || !FILE_ID_SHAPE.test(fileId)) {
    res.status(404).type('html').send(pageNotFoundPage());
    return;
  }

  const result = await callApp({
    method: 'POST',
    path: '/files/open',
    host,
    visitorIp: resolveVisitorIp(req.socket.remoteAddress, req.headers['x-forwarded-for']),
    token: readMemberToken(req.headers.cookie),
    body: { fileId },
  });
  if (!result) {
    res.status(503).type('text/plain').send(FILE_UNAVAILABLE_MESSAGE);
    return;
  }

  const { status, envelope } = result;
  const link = status === 200 ? signedLinkFrom(envelope) : null;
  if (link) {
    // An empty body: the link is in the Location header only, not repeated in redirect text.
    res.status(302).set('Location', link).end();
    return;
  }
  if (status === 401) {
    res.redirect(302, buildSignInRedirect(`${FILES_PATH}${fileId}`));
    return;
  }
  // 400 is the app refusing the id's shape: to a visitor that is the same as a file that is not there.
  if (status === 404 || status === 400) {
    res.status(404).type('html').send(pageNotFoundPage());
    return;
  }
  if (status === 403 && envelope.error?.code === FILE_FORBIDDEN_CODE) {
    res.status(403).type('html').send(memberForbiddenPage());
    return;
  }
  if (status === 429) {
    res.status(429).type('text/plain').send(FILE_BUSY_MESSAGE);
    return;
  }
  res.status(503).type('text/plain').send(FILE_UNAVAILABLE_MESSAGE);
});

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

// Must match SITE_COURSE_SLUG_PATTERN and SITE_COURSE_SLUG_MAX_LENGTH in the app's config/siteCourses.ts.
const COURSE_SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COURSE_SLUG_MAX_LENGTH = 120;

type CourseCall = Extract<UpstreamCall['path'], '/courses/list' | '/courses/outline' | '/lessons/state' | '/lessons/done' | '/lessons/undo'>;

function notFound(res: Response): void {
  fail(res, 404, 'NOT_FOUND', 'Not found.');
}

/**
 * Ask the app on behalf of whoever the session cookie belongs to, and pass its answer
 * through. The app is asked signed in or not, so a site with courses off answers 404 here
 * exactly as the app does.
 */
async function forwardCourseCall(req: Request, res: Response, path: CourseCall, body: Record<string, string> = {}): Promise<void> {
  res.set('Cache-Control', 'private, no-store').vary('Cookie');
  const ctx = context(req, res);
  if (!ctx) return;
  const result = await callApp({ method: 'POST', path, ...ctx, token: readMemberToken(req.headers.cookie), body });
  if (!result) {
    unavailable(res);
    return;
  }
  res.status(result.status).json(result.envelope);
}

/** A course slug from the address, or null when it is not one. */
function courseSlug(raw: string): string | null {
  return raw.length <= COURSE_SLUG_MAX_LENGTH && COURSE_SLUG_SHAPE.test(raw) ? raw : null;
}

/** A post id from the address, lower case, or null when it is not one. */
function postId(raw: string): string | null {
  const id = raw.toLowerCase();
  return FILE_ID_SHAPE.test(id) ? id : null;
}

membersRouter.get('/_members/courses', async (req: Request, res: Response) => {
  await forwardCourseCall(req, res, '/courses/list');
});

membersRouter.get('/_members/courses/:slug', async (req: Request, res: Response) => {
  const slug = courseSlug(String(req.params.slug));
  if (!slug) {
    notFound(res);
    return;
  }
  await forwardCourseCall(req, res, '/courses/outline', { slug });
});

membersRouter.get('/_members/lessons/:postId', async (req: Request, res: Response) => {
  const id = postId(String(req.params.postId));
  if (!id) {
    notFound(res);
    return;
  }
  await forwardCourseCall(req, res, '/lessons/state', { postId: id });
});

membersRouter.post('/_members/lessons/:postId/done', async (req: Request, res: Response) => {
  const id = postId(String(req.params.postId));
  if (!id) {
    notFound(res);
    return;
  }
  await forwardCourseCall(req, res, '/lessons/done', { postId: id });
});

membersRouter.delete('/_members/lessons/:postId/done', async (req: Request, res: Response) => {
  const id = postId(String(req.params.postId));
  if (!id) {
    notFound(res);
    return;
  }
  await forwardCourseCall(req, res, '/lessons/undo', { postId: id });
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
