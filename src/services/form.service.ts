/**
 * Form Block Resolution Service
 *
 * Resolves {{ form_block id='<uuid>' }} shortcodes at runtime:
 * 1. Scans HTML for form block shortcodes
 * 2. Reads the published markup of each form from Redis, then the DB for the rest (one query)
 * 3. Replaces every shortcode with that form's rendered_html; an unknown id renders nothing
 *
 * The markup is written by the Alloro app at publish time
 * (website_builder.forms → form_versions.rendered_html) and is trusted, like post
 * content: it goes into the page verbatim.
 */

import { getDb } from '../lib/db';
import { getRedis } from '../lib/redis';
import {
  FORM_BLOCK_SHORTCODE_REGEX,
  parseFormBlockShortcodes,
  hasFormBlockShortcodes,
} from '../utils/shortcodes';

export const FORM_BLOCK_TTL = 60; // 1 minute — a publish shows up within a minute without ?nocache=1

// The shortcode regex accepts any 36 chars of [0-9a-f-]; Postgres only accepts a real
// uuid. A malformed id is treated as unknown instead of being sent to the DB, where it
// would fail the whole query and strip every form on the page.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface FormBlockRow {
  id: string;
  rendered_html: string | null;
}

function cacheKey(projectId: string, formId: string): string {
  return `form:${projectId}:${formId}`;
}

/**
 * Read cached markup for each id. Individual GETs, not MGET: the production Redis
 * is a cluster and a multi-key command across slots fails (see ?nocache=1 in site.ts).
 * A cached '' is a real value — the id is unknown to this project, or published
 * without markup — kept so an unknown id does not hit the DB on every request.
 */
async function readCached(projectId: string, ids: string[]): Promise<Map<string, string>> {
  const redis = getRedis();
  const found = new Map<string, string>();

  await Promise.all(
    ids.map(async (id) => {
      try {
        const cached = await redis.get(cacheKey(projectId, id));
        if (cached !== null) found.set(id, cached);
      } catch {
        // Cache miss or Redis down — fall through to DB
      }
    })
  );

  return found;
}

async function writeCached(projectId: string, entries: Map<string, string>): Promise<void> {
  const redis = getRedis();

  await Promise.all(
    [...entries].map(async ([id, html]) => {
      try {
        await redis.set(cacheKey(projectId, id), html, 'EX', FORM_BLOCK_TTL);
      } catch {
        // Cache write failure is non-fatal
      }
    })
  );
}

/**
 * One parameterized query for every id missing from the cache: the published version
 * of each active form in this project. The project id is the tenant scope — an id
 * placed on a page from another project resolves to nothing.
 */
async function fetchPublishedMarkup(projectId: string, ids: string[]): Promise<FormBlockRow[]> {
  const db = getDb();
  return db('forms as f')
    .join('form_versions as v', 'v.id', 'f.published_version_id')
    .where('f.project_id', projectId)
    .where('f.status', 'active')
    .whereIn('f.id', ids)
    .select('f.id', 'v.rendered_html');
}

function stripFormBlocks(html: string): string {
  return html.replace(FORM_BLOCK_SHORTCODE_REGEX, '');
}

/**
 * Resolve all {{ form_block }} shortcodes in the given HTML.
 */
export async function resolveFormBlocks(html: string, projectId: string): Promise<string> {
  if (!hasFormBlockShortcodes(html)) {
    return html;
  }

  const shortcodes = parseFormBlockShortcodes(html);
  if (shortcodes.length === 0) {
    return html;
  }

  const ids = shortcodes.map((s) => s.id);
  const markup = await readCached(projectId, ids);
  const missing = ids.filter((id) => !markup.has(id));

  if (missing.length > 0) {
    const fresh = new Map<string, string>();
    const queryable: string[] = [];

    for (const id of missing) {
      if (UUID_RE.test(id)) {
        queryable.push(id);
      } else {
        console.warn(`[form-block] Malformed form id '${id}' on project ${projectId}; rendering nothing`);
        fresh.set(id, '');
      }
    }

    if (queryable.length > 0) {
      let rows: FormBlockRow[];
      try {
        rows = await fetchPublishedMarkup(projectId, queryable);
      } catch (err) {
        // A DB failure must not take the page down: the page renders without its forms.
        console.error('[form-block] Failed to load published forms, rendering the page without them:', err);
        return stripFormBlocks(html);
      }

      for (const row of rows) {
        const id = String(row.id).toLowerCase();
        if (!row.rendered_html) {
          console.warn(`[form-block] Form ${id} is published without markup (project ${projectId}); rendering nothing`);
        }
        fresh.set(id, row.rendered_html || '');
      }

      for (const id of queryable) {
        if (fresh.has(id)) continue;
        // Not an active, published form of this project. Cached as '' so the miss is
        // not re-queried on every request; one warning per id per DB lookup.
        console.warn(`[form-block] Unknown form ${id} on project ${projectId}; rendering nothing`);
        fresh.set(id, '');
      }
    }

    await writeCached(projectId, fresh);
    for (const [id, value] of fresh) markup.set(id, value);
  }

  // Function replacement, so $$, $& and $' in the markup stay literal.
  return html.replace(FORM_BLOCK_SHORTCODE_REGEX, (_match, id: string) => markup.get(id.toLowerCase()) ?? '');
}
