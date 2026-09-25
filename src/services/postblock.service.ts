/**
 * Post Block Resolution Service
 *
 * Resolves {{ post_block }} shortcodes at runtime:
 * 1. Scans HTML for shortcodes
 * 2. Batch-fetches post blocks from template (via Redis cache)
 * 3. Batch-fetches posts with filters (via Redis cache)
 * 4. Renders post data into post block HTML
 * 5. Replaces shortcodes with rendered output
 */

import { getDb } from '../lib/db';
import { getRedis } from '../lib/redis';
import { parseShortcodes, hasPostBlockShortcodes, renderPostBlockHtml, escapeHtml, type PostBlockShortcode } from '../utils/shortcodes';
import { getPaginationScript } from '../utils/pagination-client';
import type { Section } from '../types';
import crypto from 'crypto';
import { emptyShortcodeState } from '../utils/empty-shortcode-state';

const POST_BLOCK_TTL = 300; // 5 minutes
const POSTS_TTL = 120; // 2 minutes

interface PostBlockRow {
  slug: string;
  sections: Section[] | string;
  post_type_slug: string;
}

interface PostRow {
  title: string;
  slug: string;
  content: string;
  excerpt: string | null;
  featured_image: string | null;
  custom_fields: Record<string, unknown> | string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  categories: string | null;
  tags: string | null;
}

function formatDate(dateStr: string | Date | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function hashFilters(shortcode: PostBlockShortcode): string {
  const key = [
    shortcode.tags.join(','),
    shortcode.cats.join(','),
    shortcode.ids.join(','),
    shortcode.exc_ids.join(','),
    shortcode.order,
    shortcode.order_by,
    String(shortcode.limit),
    String(shortcode.offset),
  ].join('|');
  return crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
}

/**
 * Fetch a post block by template ID and slug, with Redis caching.
 */
async function fetchPostBlock(templateId: string, slug: string): Promise<PostBlockRow | null> {
  const redis = getRedis();
  const cacheKey = `pb:${templateId}:${slug}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // Cache miss or Redis down — fall through to DB
  }

  const db = getDb();
  const row = await db('post_blocks')
    .join('post_types', 'post_blocks.post_type_id', 'post_types.id')
    .where({ 'post_blocks.template_id': templateId, 'post_blocks.slug': slug })
    .select(
      'post_blocks.slug',
      'post_blocks.sections',
      'post_types.slug as post_type_slug'
    )
    .first();

  if (!row) return null;

  // Parse sections if stored as string
  if (typeof row.sections === 'string') {
    row.sections = JSON.parse(row.sections);
  }

  try {
    await redis.set(cacheKey, JSON.stringify(row), 'EX', POST_BLOCK_TTL);
  } catch {
    // Cache write failure is non-fatal
  }

  return row;
}

/**
 * Fetch posts matching a shortcode's filters, with Redis caching.
 */
async function fetchPosts(
  projectId: string,
  postTypeSlug: string,
  shortcode: PostBlockShortcode
): Promise<PostRow[]> {
  const redis = getRedis();
  const filterHash = hashFilters(shortcode);
  const cacheKey = `posts:${projectId}:${postTypeSlug}:${filterHash}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // Cache miss
  }

  const db = getDb();

  // Build query: posts joined with post_type for slug matching
  let query = db('posts')
    .join('post_types', 'posts.post_type_id', 'post_types.id')
    .where({
      'posts.project_id': projectId,
      'posts.status': 'published',
      'post_types.slug': postTypeSlug,
    })
    .select(
      'posts.id',
      'posts.title',
      'posts.slug',
      'posts.content',
      'posts.excerpt',
      'posts.featured_image',
      'posts.created_at',
      'posts.updated_at',
      'posts.published_at',
      'posts.sort_order',
      'posts.custom_fields'
    );

  // Filter by specific post slugs (inclusion)
  if (shortcode.ids.length > 0) {
    query = query.whereIn('posts.slug', shortcode.ids);
  }

  // Filter by excluded post slugs
  if (shortcode.exc_ids.length > 0) {
    query = query.whereNotIn('posts.slug', shortcode.exc_ids);
  }

  // Filter by category slugs
  if (shortcode.cats.length > 0) {
    query = query.whereExists(function () {
      this.select(db.raw('1'))
        .from('post_category_assignments')
        .join('post_categories', 'post_category_assignments.category_id', 'post_categories.id')
        .whereRaw('post_category_assignments.post_id = posts.id')
        .whereIn('post_categories.slug', shortcode.cats);
    });
  }

  // Filter by tag slugs
  if (shortcode.tags.length > 0) {
    query = query.whereExists(function () {
      this.select(db.raw('1'))
        .from('post_tag_assignments')
        .join('post_tags', 'post_tag_assignments.tag_id', 'post_tags.id')
        .whereRaw('post_tag_assignments.post_id = posts.id')
        .whereIn('post_tags.slug', shortcode.tags);
    });
  }

  // Order
  const orderColumn = shortcode.order_by === 'title' ? 'posts.title'
    : shortcode.order_by === 'sort_order' ? 'posts.sort_order'
    : shortcode.order_by === 'published_at' ? 'posts.published_at'
    : 'posts.created_at';
  query = query.orderBy(orderColumn, shortcode.order);

  // Pagination
  if (shortcode.limit > 0) {
    query = query.limit(shortcode.limit);
  }
  if (shortcode.offset > 0) {
    query = query.offset(shortcode.offset);
  }

  const posts = await query;

  // Enrich with category and tag names for each post
  const postIds = posts.map((p: any) => p.id);

  if (postIds.length > 0) {
    const [catRows, tagRows] = await Promise.all([
      db('post_category_assignments')
        .join('post_categories', 'post_category_assignments.category_id', 'post_categories.id')
        .whereIn('post_category_assignments.post_id', postIds)
        .select('post_category_assignments.post_id', 'post_categories.name'),
      db('post_tag_assignments')
        .join('post_tags', 'post_tag_assignments.tag_id', 'post_tags.id')
        .whereIn('post_tag_assignments.post_id', postIds)
        .select('post_tag_assignments.post_id', 'post_tags.name'),
    ]);

    const catMap = new Map<string, string[]>();
    const tagMap = new Map<string, string[]>();

    for (const row of catRows) {
      const arr = catMap.get(row.post_id) || [];
      arr.push(row.name);
      catMap.set(row.post_id, arr);
    }
    for (const row of tagRows) {
      const arr = tagMap.get(row.post_id) || [];
      arr.push(row.name);
      tagMap.set(row.post_id, arr);
    }

    for (const post of posts) {
      post.categories = (catMap.get(post.id) || []).join(', ');
      post.tags = (tagMap.get(post.id) || []).join(', ');
    }
  }

  try {
    await redis.set(cacheKey, JSON.stringify(posts), 'EX', POSTS_TTL);
  } catch {
    // Cache write failure is non-fatal
  }

  return posts;
}

/**
 * Fetch total count of posts matching a shortcode's filters, with Redis caching.
 * Mirrors fetchPosts query logic but returns only the count.
 */
async function fetchPostCount(
  projectId: string,
  postTypeSlug: string,
  shortcode: PostBlockShortcode
): Promise<number> {
  const redis = getRedis();
  const filterHash = hashFilters(shortcode);
  const cacheKey = `posts-count:${projectId}:${postTypeSlug}:${filterHash}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return parseInt(cached, 10);
  } catch {
    // Cache miss
  }

  const db = getDb();

  let query = db('posts')
    .join('post_types', 'posts.post_type_id', 'post_types.id')
    .where({
      'posts.project_id': projectId,
      'posts.status': 'published',
      'post_types.slug': postTypeSlug,
    })
    .count('* as total');

  if (shortcode.ids.length > 0) {
    query = query.whereIn('posts.slug', shortcode.ids);
  }

  if (shortcode.exc_ids.length > 0) {
    query = query.whereNotIn('posts.slug', shortcode.exc_ids);
  }

  if (shortcode.cats.length > 0) {
    query = query.whereExists(function () {
      this.select(db.raw('1'))
        .from('post_category_assignments')
        .join('post_categories', 'post_category_assignments.category_id', 'post_categories.id')
        .whereRaw('post_category_assignments.post_id = posts.id')
        .whereIn('post_categories.slug', shortcode.cats);
    });
  }

  if (shortcode.tags.length > 0) {
    query = query.whereExists(function () {
      this.select(db.raw('1'))
        .from('post_tag_assignments')
        .join('post_tags', 'post_tag_assignments.tag_id', 'post_tags.id')
        .whereRaw('post_tag_assignments.post_id = posts.id')
        .whereIn('post_tags.slug', shortcode.tags);
    });
  }

  const result = await query.first();
  const total = result ? Number(result.total) : 0;

  try {
    await redis.set(cacheKey, String(total), 'EX', POSTS_TTL);
  } catch {
    // Cache write failure is non-fatal
  }

  return total;
}

/**
 * Resolve all {{ post_block }} shortcodes in the given HTML.
 * Returns the HTML with shortcodes replaced by rendered post block content.
 *
 * If no shortcodes exist, returns the HTML unchanged (fast path).
 */
export async function resolvePostBlocks(
  html: string,
  templateId: string | null,
  projectId: string
): Promise<string> {
  if (!templateId || !hasPostBlockShortcodes(html)) {
    return html;
  }

  const shortcodes = parseShortcodes(html);
  if (shortcodes.length === 0) {
    return html;
  }

  // Batch-fetch all unique post blocks
  const uniqueBlockSlugs = [...new Set(shortcodes.map((s) => s.id))];
  const blockMap = new Map<string, PostBlockRow>();

  await Promise.all(
    uniqueBlockSlugs.map(async (slug) => {
      const block = await fetchPostBlock(templateId, slug);
      if (block) blockMap.set(slug, block);
    })
  );

  // Process each shortcode
  let result = html;
  let hasPagination = false;

  for (const shortcode of shortcodes) {
    const block = blockMap.get(shortcode.id);

    if (!block) {
      // Post block not found — render empty (remove shortcode)
      result = result.replace(shortcode.raw, '');
      continue;
    }

    // For paginated mode, override limit/offset to fetch only the first page
    const isPaginated = shortcode.paginate !== 'none';
    const effectiveShortcode = isPaginated
      ? { ...shortcode, limit: shortcode.per_page, offset: 0 }
      : shortcode;

    // Fetch posts matching this shortcode's filters
    const posts = await fetchPosts(projectId, block.post_type_slug, effectiveShortcode);

    if (posts.length === 0) {
      // Only opted-in sites show a provisional state; legacy shortcodes stay empty.
      const fallback = shortcode.empty === 'placeholder' ? emptyShortcodeState(shortcode.id) : '';
      result = result.replace(shortcode.raw, fallback);
      continue;
    }

    // Assemble block HTML from sections
    const sections = Array.isArray(block.sections) ? block.sections : [];
    const blockHtml = sections.map((s) => s.content).join('\n');

    // Split on loop markers if present
    const loopStartMarker = '{{start_post_loop}}';
    const loopEndMarker = '{{end_post_loop}}';
    const startIdx = blockHtml.indexOf(loopStartMarker);
    const endIdx = blockHtml.indexOf(loopEndMarker);

    let before = '';
    let template = blockHtml;
    let after = '';

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      before = blockHtml.slice(0, startIdx);
      template = blockHtml.slice(startIdx + loopStartMarker.length, endIdx);
      after = blockHtml.slice(endIdx + loopEndMarker.length);
    }

    // Parse custom_fields for each post
    for (const post of posts) {
      if (typeof post.custom_fields === 'string') {
        try { post.custom_fields = JSON.parse(post.custom_fields); } catch { post.custom_fields = {}; }
      }
      if (!post.custom_fields) post.custom_fields = {};
    }

    // Render each post through the loop template
    const postTypeSlug = block.post_type_slug;
    const renderedPosts = posts.map((post) =>
      renderPostBlockHtml(template, {
        title: post.title,
        slug: post.slug,
        url: `/${postTypeSlug}/${post.slug}`,
        content: post.content,
        excerpt: post.excerpt,
        featured_image: post.featured_image,
        custom_fields: post.custom_fields as Record<string, unknown>,
        categories: post.categories || '',
        tags: post.tags || '',
        created_at: formatDate(post.created_at),
        updated_at: formatDate(post.updated_at),
        published_at: formatDate(post.published_at),
      })
    );

    if (isPaginated) {
      hasPagination = true;

      // Calculate pagination metadata
      const totalPosts = await fetchPostCount(projectId, block.post_type_slug, shortcode);
      const perPage = shortcode.per_page;
      const totalPages = Math.ceil(totalPosts / perPage);

      // Build filter string for the client JS
      const filters = [
        shortcode.cats.length ? `cats=${shortcode.cats.join(',')}` : '',
        shortcode.tags.length ? `tags=${shortcode.tags.join(',')}` : '',
        shortcode.ids.length ? `ids=${shortcode.ids.join(',')}` : '',
        shortcode.exc_ids.length ? `exc_ids=${shortcode.exc_ids.join(',')}` : '',
        `order=${shortcode.order}`,
        `order_by=${shortcode.order_by}`,
      ].filter(Boolean).join('&');

      // Encode the loop template for client-side rendering
      const templateBase64 = Buffer.from(template).toString('base64');

      // Resolve hostname for API URL
      const project = await getDb()('projects').where('id', projectId).select('generated_hostname', 'custom_domain').first();
      const apiHostname = project?.custom_domain || project?.generated_hostname || '';

      // Build pagination controls (inside the section, after the grid)
      let controls = '';
      if (totalPages > 1) {
        if (shortcode.paginate === 'load-more') {
          controls = `<div data-alloro-pagination-controls style="text-align:center;margin-top:2rem;"><button data-alloro-load-more style="padding:12px 32px;border:1px solid #d1d5db;border-radius:9999px;background:white;cursor:pointer;font-size:1rem;">Load More</button></div>`;
        } else if (shortcode.paginate === 'numbered') {
          controls = `<nav data-alloro-pagination-controls data-alloro-numbered-pagination style="display:flex;justify-content:center;gap:8px;margin-top:2rem;"></nav>`;
        } else if (shortcode.paginate === 'infinite') {
          controls = `<div data-alloro-pagination-controls data-alloro-scroll-sentinel style="height:1px;"></div>`;
        }
      }

      // Structure: before (section wrapper + grid open) → paginated container with posts → grid close + controls + section close
      // The data-alloro-paginated div wraps ONLY the post cards so client JS can append to it
      // Controls go between the grid close and section close so they inherit the section background
      const gridContent = `<div data-alloro-paginated="true" data-paginate-type="post" data-paginate-mode="${shortcode.paginate}" data-post-type="${block.post_type_slug}" data-per-page="${perPage}" data-total-posts="${totalPosts}" data-total-pages="${totalPages}" data-current-page="1" data-filters="${escapeHtml(filters)}" data-block-template="${templateBase64}" data-api-base="/api/posts/${encodeURIComponent(apiHostname)}/${block.post_type_slug}" style="display:contents">${renderedPosts.join('\n')}</div>`;

      // Insert controls before the closing tags of the section (inside `after`)
      // `after` typically closes the grid div + section wrapper, e.g. "</div>\n  </div>\n</div>"
      // We insert controls after the first closing tag (grid close) but before the rest
      let afterWithControls = after;
      if (controls && after) {
        const firstCloseIdx = after.indexOf('</div>');
        if (firstCloseIdx !== -1) {
          const insertPoint = firstCloseIdx + '</div>'.length;
          afterWithControls = after.slice(0, insertPoint) + controls + after.slice(insertPoint);
        } else {
          afterWithControls = after + controls;
        }
      } else if (controls) {
        afterWithControls = controls;
      }

      result = result.replace(shortcode.raw, before + gridContent + afterWithControls);
    } else {
      result = result.replace(shortcode.raw, before + renderedPosts.join('\n') + after);
    }
  }

  // Inject pagination client script if any post block uses pagination
  if (hasPagination) {
    const script = getPaginationScript();
    result = result.replace('</body>', script + '</body>');
  }

  return result;
}
