/**
 * Site members: the one cookie this renderer reads and writes, and the cross-site
 * check for the routes that set it. Pure functions, no I/O, no dependency.
 *
 * The cookie is first-party and host-only on the site's own domain: no Domain
 * attribute is ever written, so a sign-in on one site is invisible to every other.
 * The value is an opaque session token issued by the Alloro app; it is never logged.
 */

import { isIP } from 'net';

/** Must match SITE_MEMBER_COOKIE_NAME in the app's config/siteMembers.ts. */
export const MEMBER_COOKIE_NAME = 'alloro_member';

/** 30 days, fixed. Must match SITE_MEMBER_SESSION_TTL_DAYS in the app. */
export const MEMBER_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;

export function isValidMemberToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/**
 * The member session token from a raw Cookie header, or null.
 * Tolerates a missing, repeated or malformed header. The first well-formed
 * `alloro_member` pair wins; a malformed value is skipped, never repaired.
 */
export function readMemberToken(cookieHeader: string | string[] | undefined | null): string | null {
  if (!cookieHeader) return null;
  const header = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
  if (typeof header !== 'string') return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== MEMBER_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (isValidMemberToken(value)) return value;
  }
  return null;
}

/** Strip the port from a Host header value; lowercased. Handles bracketed IPv6. */
export function hostWithoutPort(host: string | undefined | null): string {
  const value = (host || '').trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(0, end + 1) : value;
  }
  return value.split(':')[0];
}

/** The local proving runtime serves plain http on *.localhost, so Secure must be left off there. */
export function isLocalHost(host: string | undefined | null): boolean {
  const name = hostWithoutPort(host);
  return name === 'localhost' || name === '127.0.0.1' || name.endsWith('.localhost');
}

function cookieAttributes(host: string | undefined | null, maxAge: number): string {
  const secure = isLocalHost(host) ? '' : '; Secure';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** Set-Cookie value for a fresh session. Throws on a token that is not the expected shape. */
export function buildMemberCookie(token: string, host: string | undefined | null): string {
  if (!isValidMemberToken(token)) throw new Error('Invalid member session token.');
  return `${MEMBER_COOKIE_NAME}=${token}; ${cookieAttributes(host, MEMBER_COOKIE_MAX_AGE_SECONDS)}`;
}

/** Set-Cookie value that removes the session cookie. Same attributes, or the browser keeps the old one. */
export function buildClearMemberCookie(host: string | undefined | null): string {
  return `${MEMBER_COOKIE_NAME}=; ${cookieAttributes(host, 0)}`;
}

export function isJsonContentType(contentType: string | undefined | null): boolean {
  return typeof contentType === 'string' && /^\s*application\/json\s*(;|$)/i.test(contentType);
}

export interface SameSitePostInput {
  /** The Origin request header, if the browser sent one. */
  origin: string | undefined | null;
  /** The Host request header. */
  host: string | undefined | null;
  contentType: string | undefined | null;
}

/**
 * The cross-site defence for the cookie-setting routes.
 *
 * 1. The body must be declared `application/json`. A cross-site HTML form cannot send
 *    that type, and script can only send it after a CORS preflight this renderer never
 *    approves.
 * 2. When the browser sends Origin, it must be this request's own host. The renderer sits
 *    behind a TLS-terminating proxy, so the scheme is checked as "https, or http on a
 *    local host" rather than read from the socket.
 */
export function isSameSiteJsonPost(input: SameSitePostInput): boolean {
  if (!isJsonContentType(input.contentType)) return false;
  if (input.origin === undefined || input.origin === null || input.origin === '') return true;

  const host = (input.host || '').trim().toLowerCase();
  if (!host) return false;

  let origin: URL;
  try {
    origin = new URL(input.origin);
  } catch {
    return false; // includes the literal "null" origin
  }
  if (origin.host.toLowerCase() !== host) return false;
  if (origin.protocol === 'https:') return true;
  return origin.protocol === 'http:' && isLocalHost(host);
}

/** Must match SITE_MEMBER_NEXT_PATH_MAX_LENGTH in the app. */
const NEXT_PATH_MAX_LENGTH = 512;

/**
 * Whether `next` is a plain path on this site. Mirrors the app's isSafeNextPath
 * (the app is the authority and checks again): printable ASCII only, one leading
 * slash, no "//", no backslash, no scheme, no encoded slash or backslash.
 */
export function isSafeNextPath(next: unknown): next is string {
  if (typeof next !== 'string' || next.length === 0 || next.length > NEXT_PATH_MAX_LENGTH) return false;
  if (!next.startsWith('/')) return false;
  if (!/^[\x21-\x7e]+$/.test(next)) return false;
  if (next.includes('\\') || next.includes('//')) return false;
  return !/%(2f|5c)/i.test(next);
}

/** Where a visitor goes after signing in: a path on this site, or the home page. */
export function safeNextPath(next: unknown): string {
  return isSafeNextPath(next) ? next : '/';
}

/** Must match SITE_MEMBER_LOGIN_PATH in the app. */
export const MEMBER_LOGIN_PATH = '/member-login';

/**
 * The sign-in redirect for a members-only path. `search` is the raw query string
 * including its leading "?", or empty. Leading slashes collapse to one so the
 * `next` value can never name another host.
 */
export function buildSignInRedirect(path: string, search = ''): string {
  const cleanPath = '/' + path.replace(/^\/+/, '');
  const withQuery = cleanPath + (search.startsWith('?') ? search : '');
  // A query the app would refuse (too long, an encoded slash) is dropped; the page itself is kept.
  const next = isSafeNextPath(withQuery) ? withQuery : safeNextPath(cleanPath);
  return `${MEMBER_LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The visitor address to report to the app for its sign-in limits.
 * The renderer is reached through a reverse proxy on the same machine, so when the
 * socket peer is loopback the address the proxy appended (the right-most
 * X-Forwarded-For entry) is used. Entries further left are client-supplied and are
 * never trusted. A direct connection reports its own socket address. Null when
 * no usable address exists.
 */
export function resolveVisitorIp(socketAddress: string | undefined | null, forwardedFor: string | string[] | undefined | null): string | null {
  const socket = (socketAddress || '').trim();
  if (LOOPBACK_ADDRESSES.has(socket) && forwardedFor) {
    const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
    const entries = header.split(',').map((entry) => entry.trim()).filter(Boolean);
    const last = entries[entries.length - 1];
    if (last && isIP(last) !== 0) return last;
  }
  return isIP(socket) !== 0 ? socket : null;
}
