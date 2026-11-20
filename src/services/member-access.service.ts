/**
 * Member access service
 *
 * Read-only lookups behind the members-only page gate, plus the pure decision
 * function. The renderer never inserts, updates or deletes here: the Alloro app
 * owns these tables.
 *
 * Nothing in this file is cached in Redis. A session or an access change must take
 * effect on the next request. The only memo is an in-process, 60-second "does this
 * site have any members-only path at all" flag, used ONLY for sites whose members
 * switch is off, so that an ordinary site pays no query per request.
 *
 * The tables ship in a separate (app-side) deploy. If they are not there yet the
 * query fails with undefined-table (42P01); that is treated as "nothing is gated"
 * and logged once per process.
 */

import crypto from 'crypto';
import { getDb } from '../lib/db';
import type { GateDecision, GatedPost, MemberPageAccess, MemberPostAccess, MemberSession, Project } from '../types';

const ACCESS_TABLE = 'website_builder.site_page_access';
const ACCESS_GROUPS_TABLE = 'website_builder.site_page_access_groups';
const SESSIONS_TABLE = 'website_builder.site_member_sessions';
const MEMBERS_TABLE = 'website_builder.site_members';
const MEMBERSHIPS_TABLE = 'website_builder.site_member_group_memberships';
const POST_ACCESS_TABLE = 'website_builder.site_post_access';
const POST_ACCESS_GROUPS_TABLE = 'website_builder.site_post_access_groups';
const POSTS_TABLE = 'website_builder.posts';
const POST_TYPES_TABLE = 'website_builder.post_types';

const UNDEFINED_TABLE = '42P01';
const ANY_ACCESS_MEMO_MS = 60_000;
const ANY_ACCESS_MEMO_MAX_ENTRIES = 5000;

/** Paths that are never members-only, whatever the access rows say. */
const NEVER_GATED_PATHS = new Set(['/member-login', '/member-apply', '/robots.txt', '/sitemap.xml', '/favicon.ico', '/success']);
const NEVER_GATED_PREFIX = '/_members';

let missingTablesWarned = false;

function isMissingTableError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === UNDEFINED_TABLE;
}

async function withMissingTablesAs<T>(fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    if (!missingTablesWarned) {
      missingTablesWarned = true;
      console.warn('[members] site member tables are not present yet (42P01); treating every page as not members-only');
    }
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Drop trailing slashes, the way siteRoute's trailing-slash redirect does. The root stays "/". */
export function normalizeGatePath(path: string): string {
  const stripped = path.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

export function isNeverGatedPath(path: string): boolean {
  const normalized = normalizeGatePath(path);
  return NEVER_GATED_PATHS.has(normalized) || normalized === NEVER_GATED_PREFIX || normalized.startsWith(NEVER_GATED_PREFIX + '/');
}

/**
 * The longest members-only path that equals the request path or contains it at a
 * "/" boundary. `/base-camp` covers `/base-camp`, `/base-camp/` and
 * `/base-camp/assets/app.js`, and does NOT cover `/base-camp-news`.
 *
 * A members-only home page ("/") covers the home page only. It is not a prefix of
 * the whole site.
 */
export function matchGatedPath(gatedPaths: readonly string[], requestPath: string): string | null {
  if (isNeverGatedPath(requestPath)) return null;
  const request = normalizeGatePath(requestPath);
  let best: string | null = null;
  let bestLength = -1;
  for (const gated of gatedPaths) {
    if (typeof gated !== 'string' || !gated.startsWith('/')) continue;
    const base = normalizeGatePath(gated);
    const matches = base === '/' ? request === '/' : request === base || request.startsWith(base + '/');
    if (matches && base.length > bestLength) {
      best = gated;
      bestLength = base.length;
    }
  }
  return best;
}

export interface GateInput {
  /** The access rule covering this path or post, or null when it is public. */
  access: Pick<MemberPageAccess, 'groupIds'> | null;
  /** projects.members_enabled. */
  isMembersEnabled: boolean;
  /** The signed-in, active member of THIS site, or null. */
  member: MemberSession | null;
}

/**
 * The gate, exactly as the plan lists it:
 *   not members-only                      -> open       (serve as today)
 *   members-only, switch off              -> not-found  (fail closed)
 *   members-only, no valid session        -> sign-in
 *   members-only, member in no listed group -> forbidden
 *   members-only, allowed                 -> allow
 * A members-only path with no groups listed is open to every active member.
 */
export function decideGate(input: GateInput): GateDecision {
  if (!input.access) return 'open';
  if (!input.isMembersEnabled) return 'not-found';
  if (!input.member) return 'sign-in';
  if (input.access.groupIds.length === 0) return 'allow';
  const memberGroups = new Set(input.member.groupIds);
  return input.access.groupIds.some((groupId) => memberGroups.has(groupId)) ? 'allow' : 'forbidden';
}

/** SHA-256 of the raw cookie token, hex. This is what site_member_sessions.token_hash stores. */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Force "do not index" on HTML served to a signed-in member: every existing robots
 * meta tag is removed and one noindex tag is written before </head>.
 */
export function forceNoindex(html: string): string {
  const tag = '<meta name="robots" content="noindex, nofollow">';
  const stripped = html.replace(/<meta\s+[^>]*name=["']?robots["']?[^>]*>\s*/gi, '');
  if (/<\/head>/i.test(stripped)) return stripped.replace(/<\/head>/i, () => `${tag}\n</head>`);
  return stripped;
}

// ---------------------------------------------------------------------------
// Lookups (read-only)
// ---------------------------------------------------------------------------

interface AccessRow {
  id: string;
  path: string;
}

async function loadAccessRows(projectId: string): Promise<AccessRow[]> {
  return withMissingTablesAs<AccessRow[]>([], async () => {
    const rows: AccessRow[] = await getDb()(ACCESS_TABLE).where({ project_id: projectId }).select('id', 'path');
    return rows;
  });
}

const anyAccessMemo = new Map<string, { hasAny: boolean; expiresAt: number }>();

/**
 * True when the site has at least one members-only path. Memoised in this process
 * for 60 seconds per site; never stored in Redis.
 */
export async function hasAnyPageAccess(projectId: string, now: number = Date.now()): Promise<boolean> {
  const memo = anyAccessMemo.get(projectId);
  if (memo && memo.expiresAt > now) return memo.hasAny;

  const hasAny = await withMissingTablesAs(false, async () => {
    const row = await getDb()(ACCESS_TABLE).where({ project_id: projectId }).select('id').first();
    return !!row;
  });

  if (anyAccessMemo.size >= ANY_ACCESS_MEMO_MAX_ENTRIES) anyAccessMemo.clear();
  anyAccessMemo.set(projectId, { hasAny, expiresAt: now + ANY_ACCESS_MEMO_MS });
  return hasAny;
}

/** Test seam: forget the 60-second memos (members-only paths and members-only posts). */
export function resetMemberAccessMemo(): void {
  anyAccessMemo.clear();
  anyPostAccessMemo.clear();
}

/**
 * Whether the gate has anything to look up for this site.
 * Switch on: always (the owner is using the feature; an access change must apply at once).
 * Switch off: only when the 60-second memo says the site has members-only paths, so a
 * site that never used the feature costs at most one small query a minute.
 */
async function siteMayHaveGatedPaths(project: Pick<Project, 'id' | 'members_enabled'>): Promise<boolean> {
  if (project.members_enabled === true) return true;
  return hasAnyPageAccess(project.id);
}

/** Every members-only path of a site, read fresh. Empty for a site that has none. */
export async function listGatedPaths(project: Pick<Project, 'id' | 'members_enabled'>): Promise<string[]> {
  if (!(await siteMayHaveGatedPaths(project))) return [];
  return (await loadAccessRows(project.id)).map((row) => row.path);
}

/**
 * The access rule covering a request path: the longest members-only path that equals
 * it or contains it at a "/" boundary, with the groups it is limited to.
 * Null when the path is public.
 */
export async function getPageAccess(projectId: string, path: string): Promise<MemberPageAccess | null> {
  if (isNeverGatedPath(path)) return null;
  const rows = await loadAccessRows(projectId);
  if (rows.length === 0) return null;

  const gatedPath = matchGatedPath(rows.map((row) => row.path), path);
  if (gatedPath === null) return null;
  const access = rows.find((row) => row.path === gatedPath);
  if (!access) return null;

  // A failure here must not open the page: only a missing table falls back, and that
  // fallback ("no groups") still requires a signed-in member.
  const groupRows = await withMissingTablesAs<Array<{ group_id: string }>>([], async () => {
    const result: Array<{ group_id: string }> = await getDb()(ACCESS_GROUPS_TABLE)
      .where({ page_access_id: access.id, project_id: projectId })
      .select('group_id');
    return result;
  });

  return { gatedPath, groupIds: groupRows.map((row) => row.group_id) };
}

/**
 * The active member behind a session token hash, on this site only, with their groups.
 * One read-only query. Null when the session is unknown, revoked, expired, belongs to
 * another site, or the member is not active.
 */
export async function getMemberForSession(projectId: string, tokenSha256Hex: string): Promise<MemberSession | null> {
  if (!/^[0-9a-f]{64}$/.test(tokenSha256Hex)) return null;

  return withMissingTablesAs<MemberSession | null>(null, async () => {
    const db = getDb();
    const rows: Array<{ member_id: string; group_id: string | null }> = await db(`${SESSIONS_TABLE} as s`)
      .join(`${MEMBERS_TABLE} as m`, function () {
        this.on('m.id', '=', 's.member_id').andOn('m.project_id', '=', 's.project_id');
      })
      .leftJoin(`${MEMBERSHIPS_TABLE} as g`, function () {
        this.on('g.member_id', '=', 'm.id').andOn('g.project_id', '=', 'm.project_id');
      })
      .where('s.token_hash', tokenSha256Hex)
      .where('s.project_id', projectId)
      .whereNull('s.revoked_at')
      .where('s.expires_at', '>', db.fn.now())
      .where('m.status', 'active')
      .select('m.id as member_id', 'g.group_id as group_id');

    if (rows.length === 0) return null;
    const groupIds = rows.map((row) => row.group_id).filter((groupId): groupId is string => typeof groupId === 'string');
    return { memberId: rows[0].member_id, groupIds };
  });
}

export interface MemberGateResult {
  decision: GateDecision;
  access: MemberPageAccess | null;
}

/**
 * Run the gate for one request. `readToken` is only called once a members-only path
 * on a members-enabled site is found, so a public page does no cookie work.
 */
export async function resolveMemberGate(
  project: Pick<Project, 'id' | 'members_enabled'>,
  path: string,
  readToken: () => string | null
): Promise<MemberGateResult> {
  if (isNeverGatedPath(path)) return { decision: 'open', access: null };
  if (!(await siteMayHaveGatedPaths(project))) return { decision: 'open', access: null };

  const access = await getPageAccess(project.id, path);
  const isMembersEnabled = project.members_enabled === true;
  if (!access || !isMembersEnabled) return { decision: decideGate({ access, isMembersEnabled, member: null }), access };

  const token = readToken();
  const member = token ? await getMemberForSession(project.id, hashSessionToken(token)) : null;
  return { decision: decideGate({ access, isMembersEnabled, member }), access };
}

// ---------------------------------------------------------------------------
// Members-only posts (getAlloro/alloro plans/11192026-site-courses-library, T3)
//
// A row in site_post_access makes one post members-only; rows in
// site_post_access_groups limit it to groups. No row means the post is open to everyone.
//
// ⛔ EVERY place that reads posts for the public goes through this section:
//   - a single post page asks resolvePostGate BEFORE its cache is read;
//   - every list, feed, menu and sitemap asks listGatedPosts / listGatedPostIds and
//     leaves those posts out BEFORE its shared cache is written.
// A new public reader of posts must do the same.
//
// Like the path gate, nothing here is cached in Redis: the members-only posts of a
// site are read fresh (one small query), so an access change applies on the next
// request. The shared list caches stay correct without a flush because their keys
// carry postGateCacheTag(): a different set of members-only posts is a different key.
//
// Members switch off: same as the path gate, fail closed. A members-only post is a
// 404 at its own address and stays out of every list. A site with the switch off and
// no rows pays at most one small query a minute (the same 60-second memo).
// ---------------------------------------------------------------------------

/** What the post gate needs to know about a site. A row from before the app migration has no flag: off. */
export type PostGateSite = Pick<Project, 'id' | 'members_enabled'>;

/**
 * A caller that only holds a project id does not know the members switch. That is
 * treated as "may be on": the members-only posts are read fresh every time, never
 * through the 60-second memo. Pass the project where there is one.
 */
export function toPostGateSite(site: PostGateSite | string): PostGateSite {
  return typeof site === 'string' ? { id: site, members_enabled: true } : site;
}

async function loadGatedPosts(projectId: string): Promise<GatedPost[]> {
  return withMissingTablesAs<GatedPost[]>([], async () => {
    const rows: Array<{ access_id: string; post_id: string; post_slug: string; type_slug: string }> = await getDb()(`${POST_ACCESS_TABLE} as a`)
      .join(`${POSTS_TABLE} as p`, function () {
        this.on('p.id', '=', 'a.post_id').andOn('p.project_id', '=', 'a.project_id');
      })
      .join(`${POST_TYPES_TABLE} as pt`, 'pt.id', 'p.post_type_id')
      .where('a.project_id', projectId)
      .select('a.id as access_id', 'a.post_id as post_id', 'p.slug as post_slug', 'pt.slug as type_slug');
    return rows.map((row) => ({ accessId: row.access_id, postId: row.post_id, typeSlug: row.type_slug, postSlug: row.post_slug }));
  });
}

const anyPostAccessMemo = new Map<string, { hasAny: boolean; expiresAt: number }>();

/** True when the site has at least one members-only post. Memoised in this process for 60 seconds per site. */
export async function hasAnyPostAccess(projectId: string, now: number = Date.now()): Promise<boolean> {
  const memo = anyPostAccessMemo.get(projectId);
  if (memo && memo.expiresAt > now) return memo.hasAny;

  const hasAny = await withMissingTablesAs(false, async () => {
    const row = await getDb()(POST_ACCESS_TABLE).where({ project_id: projectId }).select('id').first();
    return !!row;
  });

  if (anyPostAccessMemo.size >= ANY_ACCESS_MEMO_MAX_ENTRIES) anyPostAccessMemo.clear();
  anyPostAccessMemo.set(projectId, { hasAny, expiresAt: now + ANY_ACCESS_MEMO_MS });
  return hasAny;
}

/**
 * Every members-only post of a site, read fresh in one query: its id (for lists) and
 * its address (for the single post page and the sitemap). Empty for a site that has none.
 * Drafts are included on purpose: a members-only post never depends on its status to stay hidden.
 */
export async function listGatedPosts(site: PostGateSite): Promise<GatedPost[]> {
  if (site.members_enabled !== true && !(await hasAnyPostAccess(site.id))) return [];
  return loadGatedPosts(site.id);
}

/** The ids of a site's members-only posts, de-duplicated and sorted. */
export async function listGatedPostIds(site: PostGateSite): Promise<string[]> {
  return gatedPostIds(await listGatedPosts(site));
}

function gatedPostIds(gated: readonly GatedPost[]): string[] {
  return [...new Set(gated.map((post) => post.postId))].sort();
}

/**
 * Leave members-only posts out of a list. With none, the SAME array is returned, so a
 * site with no members-only posts is untouched.
 */
export function excludeGatedPosts<T extends { id: string }>(posts: T[], gatedIds: readonly string[]): T[] {
  if (gatedIds.length === 0) return posts;
  const gated = new Set(gatedIds);
  return posts.filter((post) => !gated.has(post.id));
}

/**
 * Suffix for a shared (per-site, not per-visitor) cache key that holds a list of posts.
 * Empty when the site has no members-only posts, so its keys are exactly what they were.
 * Otherwise it names the set of members-only posts: change the set and the old entry is
 * never read again, with or without a cache flush.
 */
export function postGateCacheTag(gatedIds: readonly string[]): string {
  if (gatedIds.length === 0) return '';
  const digest = crypto.createHash('sha256').update([...new Set(gatedIds)].sort().join(','), 'utf8').digest('hex');
  return `:g${digest.slice(0, 12)}`;
}

/** The address of a post, as the single post route and the sitemap write it. */
export function gatedPostPath(post: Pick<GatedPost, 'typeSlug' | 'postSlug'>): string {
  return `/${post.typeSlug}/${post.postSlug}`;
}

/** The members-only post at /{typeSlug}/{postSlug}, or null. Exact match on both parts. */
export function findGatedPost(gated: readonly GatedPost[], typeSlug: string, postSlug: string): GatedPost | null {
  return gated.find((post) => post.typeSlug === typeSlug && post.postSlug === postSlug) ?? null;
}

export interface PostGateResult {
  decision: GateDecision;
  /** The access rule of the post at this address, or null when it is open to everyone. */
  access: MemberPostAccess | null;
  /** Every members-only post id of the site, for a caller that must re-check a cached post by id. */
  gatedPostIds: string[];
}

/**
 * THE gate for one post address, /{typeSlug}/{postSlug}. Same decisions as the path gate:
 *   no access row                          -> open       (serve as today)
 *   members-only, switch off               -> not-found  (fail closed)
 *   members-only, no valid session         -> sign-in
 *   members-only, member in no listed group -> forbidden
 *   members-only, allowed                  -> allow
 * `readToken` is only called once a members-only post on a members-enabled site is
 * found, so a public post does no cookie work.
 */
export async function resolvePostGate(
  site: PostGateSite,
  typeSlug: string,
  postSlug: string,
  readToken: () => string | null
): Promise<PostGateResult> {
  const gated = await listGatedPosts(site);
  const ids = gatedPostIds(gated);
  const match = findGatedPost(gated, typeSlug, postSlug);
  if (!match) return { decision: 'open', access: null, gatedPostIds: ids };

  const isMembersEnabled = site.members_enabled === true;
  if (!isMembersEnabled) {
    const access = { postId: match.postId, groupIds: [] };
    return { decision: decideGate({ access, isMembersEnabled, member: null }), access, gatedPostIds: ids };
  }

  // A failure here must not open the post: only a missing table falls back, and that
  // fallback ("no groups") still requires a signed-in member.
  const groupRows = await withMissingTablesAs<Array<{ group_id: string }>>([], async () => {
    const result: Array<{ group_id: string }> = await getDb()(POST_ACCESS_GROUPS_TABLE)
      .where({ post_access_id: match.accessId, project_id: site.id })
      .select('group_id');
    return result;
  });
  const access: MemberPostAccess = { postId: match.postId, groupIds: groupRows.map((row) => row.group_id) };

  const token = readToken();
  const member = token ? await getMemberForSession(site.id, hashSessionToken(token)) : null;
  return { decision: decideGate({ access, isMembersEnabled, member }), access, gatedPostIds: ids };
}
