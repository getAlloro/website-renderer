/**
 * Menu Autofill Expansion
 *
 * Turns `post_autofill` placeholder rows into real nav entries, immediately
 * before the menu tree is built. A placeholder names a post type instead of a
 * URL and is never stored expanded — it resolves on every render, which is why
 * renaming, unpublishing or deleting a post can never leave a stale nav entry
 * behind.
 *
 * A placeholder replaces ITSELF, in place: the posts land at the placeholder's
 * position and the placeholder's level. Put one under "About Us" and the
 * doctors become children of "About Us". Put one inside a "Doctors" link and
 * you get a dropdown. One rule, both shapes.
 *
 * ⛔ This is a deliberate parallel implementation. The dashboard preview is
 * rendered by a different repository (getAlloro/alloro,
 * src/controllers/user-website/user-website-utils/menu-autofill-expansion.ts)
 * which shares no code with this one. The two must agree on expansion
 * semantics — position, ordering, limit, and the dropping of children — or an
 * owner sees one nav in the dashboard and a different one on their live site.
 * Change both together.
 *
 * Plan: getAlloro/alloro plans/08112026-menu-post-type-autofill
 */

import { getDb } from '../lib/db';
import { getRedis } from '../lib/redis';

/** Must match src/config/menuItems.ts in getAlloro/alloro. */
const ITEM_TYPE_POST_AUTOFILL = 'post_autofill';
const AUTOFILL_ORDER_OLDEST = 'oldest';

/**
 * Short TTL, and much shorter than MENU_TTL on purpose.
 *
 * The menu cache holds the placeholder row, which changes only when someone
 * edits the menu. This cache holds the posts the placeholder resolves to, which
 * change whenever an owner publishes a doctor. getAlloro/alloro clears
 * `menuposts:{projectId}:*` on every post write, so this TTL is only the
 * backstop for a missed invalidation, not the normal path.
 */
const AUTOFILL_POSTS_TTL = 60;

export interface MenuItemAutofillFields {
  item_type?: string | null;
  autofill_post_type_id?: string | null;
  autofill_order?: string | null;
  autofill_limit?: number | null;
}

export interface AutofillPost {
  id: string;
  post_type_id: string;
  post_type_slug: string;
  title: string;
  slug: string;
  sort_order: number;
  ordered_at: string;
}

export function isAutofillPlaceholder(item: MenuItemAutofillFields): boolean {
  return (
    item.item_type === ITEM_TYPE_POST_AUTOFILL &&
    Boolean(item.autofill_post_type_id)
  );
}

/**
 * The one place the fill order is defined.
 *
 * `sort_order` always ascends and is never reversed — it is a position someone
 * set by hand, so flipping it for a "newest first" placeholder would be
 * nonsense. Only the date leg responds to the direction. `id` breaks a tie so
 * the nav cannot reshuffle between two renders of the same data.
 */
function compareForFill(a: AutofillPost, b: AutofillPost, oldestFirst: boolean): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;

  const at = new Date(a.ordered_at).getTime();
  const bt = new Date(b.ordered_at).getTime();
  if (at !== bt) return oldestFirst ? at - bt : bt - at;

  return oldestFirst ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
}

/**
 * Published posts for a set of post types, with Redis caching.
 *
 * `ordered_at` is COALESCE(published_at, created_at), not published_at alone —
 * production holds a published post with a NULL published_at, and ordering by a
 * null column would drop that entry somewhere unpredictable in the nav.
 */
async function fetchAutofillPosts(
  projectId: string,
  postTypeIds: string[]
): Promise<AutofillPost[]> {
  if (postTypeIds.length === 0) return [];

  const redis = getRedis();
  const cacheKey = `menuposts:${projectId}:${[...postTypeIds].sort().join(',')}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // Cache miss or Redis down — fall through to DB
  }

  const db = getDb();

  const rows: AutofillPost[] = await db('posts')
    .join('post_types', 'posts.post_type_id', 'post_types.id')
    .where('posts.project_id', projectId)
    .whereIn('posts.post_type_id', postTypeIds)
    .where('posts.status', 'published')
    .select(
      'posts.id',
      'posts.post_type_id',
      'post_types.slug as post_type_slug',
      'posts.title',
      'posts.slug',
      'posts.sort_order',
      db.raw('COALESCE(posts.published_at, posts.created_at) as ordered_at')
    );

  try {
    await redis.set(cacheKey, JSON.stringify(rows), 'EX', AUTOFILL_POSTS_TTL);
  } catch {
    // Cache write failure is non-fatal
  }

  return rows;
}

/** The row shape expansion operates on. */
type ExpandableRow = MenuItemAutofillFields & {
  id: string;
  menu_id: string;
  parent_id: string | null;
  label: string;
  url: string;
  target: string;
  order_index: number;
};

/**
 * Expand every placeholder in a menu's flat row list.
 *
 * Posts for all placeholders are fetched in ONE query, so a menu with several
 * placeholders still costs one round trip. The decision-making itself is in
 * `expandWithPosts`, which touches no database — this function is only the
 * fetch around it.
 */
export async function expandAutofillItems<T extends ExpandableRow>(
  projectId: string,
  items: T[]
): Promise<T[]> {
  const placeholders = items.filter(isAutofillPlaceholder);
  if (placeholders.length === 0) return items;

  const postTypeIds = [
    ...new Set(
      placeholders
        .map((p) => p.autofill_post_type_id)
        .filter((id): id is string => Boolean(id))
    ),
  ];

  const posts = await fetchAutofillPosts(projectId, postTypeIds);
  return expandWithPosts(items, posts);
}

/**
 * The whole expansion decision, with no database and no cache.
 *
 * ⛔ Position is carried by ARRAY ORDER, not by order_index arithmetic. buildTree
 * pushes children in the order rows appear, and rows arrive sorted by
 * order_index, so splicing the posts where the placeholder sat is exactly right.
 *
 * Kept separate and exported so the behaviour can be exercised without a
 * database — this repo has no test harness of its own, so being callable with a
 * literal post list is the only way it can be checked at all.
 */
export function expandWithPosts<T extends ExpandableRow>(
  items: T[],
  posts: AutofillPost[]
): T[] {
  const placeholders = items.filter(isAutofillPlaceholder);
  if (placeholders.length === 0) return items;

  const byPostType = new Map<string, AutofillPost[]>();
  for (const post of posts) {
    const bucket = byPostType.get(post.post_type_id);
    if (bucket) bucket.push(post);
    else byPostType.set(post.post_type_id, [post]);
  }

  // Anything parented to a placeholder is dropped rather than orphaned. The
  // admin refuses to create such rows, but a restored backup or a hand-edited
  // row could still carry one, and silently reparenting it to the root would put
  // a stray entry in a customer's navigation.
  const placeholderIds = new Set(placeholders.map((p) => p.id));

  const expanded: T[] = [];

  for (const item of items) {
    if (item.parent_id && placeholderIds.has(item.parent_id)) continue;

    if (!isAutofillPlaceholder(item)) {
      expanded.push(item);
      continue;
    }

    const all = byPostType.get(item.autofill_post_type_id as string) ?? [];
    const oldestFirst = item.autofill_order === AUTOFILL_ORDER_OLDEST;
    const ordered = [...all].sort((a, b) => compareForFill(a, b, oldestFirst));
    const capped =
      typeof item.autofill_limit === 'number' && item.autofill_limit > 0
        ? ordered.slice(0, item.autofill_limit)
        : ordered;

    for (const post of capped) {
      expanded.push({
        ...item,
        // Prefixed so a synthetic id can never collide with a real menu item id
        // and be mistaken for one by buildTree's parent lookup.
        id: `autofill:${item.id}:${post.id}`,
        label: post.title,
        url: `/${post.post_type_slug}/${post.slug}`,
        target: item.target || '_self',
        item_type: 'link',
        autofill_post_type_id: null,
      });
    }
  }

  return expanded;
}
