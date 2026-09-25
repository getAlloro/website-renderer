/**
 * Review Block Resolution Service
 *
 * Resolves {{ review_block }} shortcodes at runtime:
 * 1. Scans HTML for review block shortcodes
 * 2. Fetches review block templates from DB (via Redis cache)
 * 3. Resolves project → org locations + selected Google place IDs
 * 4. Fetches visible reviews from local DB (via Redis cache)
 * 5. Renders review data into block HTML with loop markers
 * 6. Replaces shortcodes with rendered output
 */

import { getDb } from '../lib/db';
import { getRedis } from '../lib/redis';
import {
  parseReviewBlockShortcodes,
  hasReviewBlockShortcodes,
  renderReviewBlockHtml,
  escapeHtml,
} from '../utils/shortcodes';
import { getPaginationScript } from '../utils/pagination-client';
import crypto from 'crypto';
import { emptyShortcodeState } from '../utils/empty-shortcode-state';

const REVIEW_BLOCK_TTL = 300; // 5 minutes
const REVIEWS_TTL = 120; // 2 minutes

interface ReviewBlockRow {
  slug: string;
  sections: { name: string; content: string }[] | string;
}

interface ReviewRow {
  stars: number;
  text: string | null;
  reviewer_name: string | null;
  reviewer_photo_url: string | null;
  is_anonymous: boolean;
  review_created_at: string | Date | null;
  has_reply: boolean;
  reply_text: string | null;
  reply_date: string | Date | null;
}

export interface ReviewScopeProject {
  id: string;
  organization_id: number | null;
  selected_place_id?: string | null;
  selected_place_ids?: string[] | string | null;
  primary_place_id?: string | null;
}

export interface ProjectReviewScope {
  locationIds: number[];
  placeIds: string[];
}

export interface ReviewQueryFilters {
  min_rating: number;
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
}

function hashReviewFilters(filters: ReviewQueryFilters, scope: ProjectReviewScope): string {
  const key = [
    scope.locationIds.join(','),
    scope.placeIds.join(','),
    String(filters.min_rating),
    String(filters.limit),
    String(filters.offset),
    filters.order,
  ].join('|');
  return crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
}

function normalizePlaceIds(
  selectedPlaceIds: string[] | string | null | undefined,
  legacyPlaceId: string | null | undefined,
  primaryPlaceId: string | null | undefined
): string[] {
  const ids = Array.isArray(selectedPlaceIds)
    ? selectedPlaceIds
    : typeof selectedPlaceIds === 'string'
      ? selectedPlaceIds.replace(/[{}"]/g, '').split(',')
      : [];

  const normalized = ids
    .concat(legacyPlaceId ? [legacyPlaceId] : [])
    .concat(primaryPlaceId ? [primaryPlaceId] : [])
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return [...new Set(normalized)];
}

export async function getProjectReviewScope(
  project: ReviewScopeProject
): Promise<ProjectReviewScope> {
  const db = getDb();
  const placeIds = normalizePlaceIds(
    project.selected_place_ids,
    project.selected_place_id,
    project.primary_place_id
  );

  if (!project.organization_id) {
    return { locationIds: [], placeIds };
  }

  const rows = await db.raw(
    'SELECT id FROM public.locations WHERE organization_id = ?',
    [project.organization_id]
  );
  const locations: { id: number }[] = rows.rows || rows;

  return {
    locationIds: locations.map((row) => row.id),
    placeIds,
  };
}

function hasReviewScope(scope: ProjectReviewScope): boolean {
  return scope.locationIds.length > 0 || scope.placeIds.length > 0;
}

function buildVisibleReviewQuery(scope: ProjectReviewScope) {
  const db = getDb();
  return db('reviews')
    .where(function () {
      if (scope.locationIds.length > 0) this.whereIn('location_id', scope.locationIds);
      if (scope.placeIds.length > 0) this.orWhereIn('place_id', scope.placeIds);
    })
    .where('hidden', false)
    .whereBetween('stars', [1, 5]);
}

/**
 * Fetch a review block by template ID and slug, with Redis caching.
 */
async function fetchReviewBlock(templateId: string, slug: string): Promise<ReviewBlockRow | null> {
  const redis = getRedis();
  const cacheKey = `rb:${templateId}:${slug}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // Cache miss or Redis down — fall through to DB
  }

  const db = getDb();
  const row = await db('review_blocks')
    .where({ template_id: templateId, slug })
    .select('slug', 'sections')
    .first();

  if (!row) return null;

  if (typeof row.sections === 'string') {
    row.sections = JSON.parse(row.sections);
  }

  try {
    await redis.set(cacheKey, JSON.stringify(row), 'EX', REVIEW_BLOCK_TTL);
  } catch {
    // Cache write failure is non-fatal
  }

  return row;
}

/**
 * Fetch reviews for given location IDs with filters, with Redis caching.
 */
export async function fetchReviews(
  scope: ProjectReviewScope,
  filters: ReviewQueryFilters
): Promise<ReviewRow[]> {
  if (!hasReviewScope(scope)) return [];

  const redis = getRedis();
  const filterHash = hashReviewFilters(filters, scope);
  const cacheKey = `reviews:${filterHash}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // Cache miss
  }

  const reviews = await buildVisibleReviewQuery(scope)
    .where('stars', '>=', filters.min_rating)
    .orderBy('review_created_at', filters.order)
    .limit(filters.limit)
    .offset(filters.offset)
    .select(
      'stars',
      'text',
      'reviewer_name',
      'reviewer_photo_url',
      'is_anonymous',
      'review_created_at',
      'has_reply',
      'reply_text',
      'reply_date'
    );

  try {
    await redis.set(cacheKey, JSON.stringify(reviews), 'EX', REVIEWS_TTL);
  } catch {
    // Cache write failure is non-fatal
  }

  return reviews;
}

/**
 * Fetch total count of reviews matching filters, with Redis caching.
 * Mirrors fetchReviews query logic but returns only the count.
 */
export async function fetchReviewCount(
  scope: ProjectReviewScope,
  filters: ReviewQueryFilters
): Promise<number> {
  if (!hasReviewScope(scope)) return 0;

  const redis = getRedis();
  const filterHash = hashReviewFilters(filters, scope);
  const cacheKey = `reviews-count:${filterHash}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return parseInt(cached, 10);
  } catch {
    // Cache miss
  }

  const result = await buildVisibleReviewQuery(scope)
    .where('stars', '>=', filters.min_rating)
    .count('* as total')
    .first();

  const total = result ? Number(result.total) : 0;

  try {
    await redis.set(cacheKey, String(total), 'EX', REVIEWS_TTL);
  } catch {
    // Cache write failure is non-fatal
  }

  return total;
}

/**
 * Resolve all {{ review_block }} shortcodes in the given HTML.
 */
export async function resolveReviewBlocks(
  html: string,
  projectId: string,
  templateId?: string
): Promise<string> {
  if (!templateId || !hasReviewBlockShortcodes(html)) {
    return html;
  }

  const shortcodes = parseReviewBlockShortcodes(html);
  if (shortcodes.length === 0) {
    return html;
  }

  // Resolve project → org → locations (+ hostname for pagination API URL)
  const db = getDb();
  const project = await db('projects')
    .where('id', projectId)
    .select(
      'id',
      'organization_id',
      'generated_hostname',
      'custom_domain',
      'selected_place_id',
      'selected_place_ids',
      'primary_place_id'
    )
    .first();

  if (!project) {
    // No org — remove all review block shortcodes
    let result = html;
    for (const sc of shortcodes) {
      result = result.replace(sc.raw, '');
    }
    return result;
  }

  const scope = await getProjectReviewScope(project);
  if (!hasReviewScope(scope)) {
    let result = html;
    for (const sc of shortcodes) {
      const fallback = sc.empty === 'placeholder' ? emptyShortcodeState(sc.id) : '';
      result = result.replace(sc.raw, fallback);
    }
    return result;
  }

  // Batch-fetch all unique review blocks
  const uniqueSlugs = [...new Set(shortcodes.map((s) => s.id))];
  const blockMap = new Map<string, ReviewBlockRow>();

  await Promise.all(
    uniqueSlugs.map(async (slug) => {
      const block = await fetchReviewBlock(templateId, slug);
      if (block) blockMap.set(slug, block);
    })
  );

  let result = html;
  let hasPagination = false;

  for (const sc of shortcodes) {
    const block = blockMap.get(sc.id);
    if (!block) {
      result = result.replace(sc.raw, '');
      continue;
    }

    // For paginated mode, override limit/offset to fetch only the first page
    const isPaginated = sc.paginate !== 'none';
    const effectiveShortcode = isPaginated
      ? { ...sc, limit: sc.per_page, offset: 0 }
      : sc;

    // Fetch reviews
    const reviews = await fetchReviews(scope, effectiveShortcode);

    if (reviews.length === 0) {
      const fallback = sc.empty === 'placeholder' ? emptyShortcodeState(sc.id) : '';
      result = result.replace(sc.raw, fallback);
      continue;
    }

    // Assemble block HTML from sections
    const sections = Array.isArray(block.sections) ? block.sections : [];
    const blockHtml = sections.map((s) => s.content).join('\n');

    // Split on loop markers
    const startMarker = '{{start_review_loop}}';
    const endMarker = '{{end_review_loop}}';
    const startIdx = blockHtml.indexOf(startMarker);
    const endIdx = blockHtml.indexOf(endMarker);

    let before = '';
    let template = blockHtml;
    let after = '';

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      before = blockHtml.slice(0, startIdx);
      template = blockHtml.slice(startIdx + startMarker.length, endIdx);
      after = blockHtml.slice(endIdx + endMarker.length);
    }

    // Render each review through the template
    const renderedReviews = reviews.map((review) =>
      renderReviewBlockHtml(template, review)
    );

    if (isPaginated) {
      hasPagination = true;

      // Calculate pagination metadata
      const totalReviews = await fetchReviewCount(scope, sc);
      const perPage = sc.per_page;
      const totalPages = Math.ceil(totalReviews / perPage);

      // Build filter string for the client JS
      const filters = [
        `location=${sc.location}`,
        `min_rating=${sc.min_rating}`,
        `order=${sc.order}`,
      ].filter(Boolean).join('&');

      // Encode the loop template for client-side rendering
      const templateBase64 = Buffer.from(template).toString('base64');

      // Resolve hostname for API URL
      const apiHostname = project?.custom_domain || project?.generated_hostname || '';

      // Build pagination controls
      let controls = '';
      if (totalPages > 1) {
        if (sc.paginate === 'load-more') {
          controls = `<div data-alloro-pagination-controls style="text-align:center;margin-top:2rem;"><button data-alloro-load-more style="padding:12px 32px;border:1px solid #d1d5db;border-radius:9999px;background:white;cursor:pointer;font-size:1rem;">Load More</button></div>`;
        } else if (sc.paginate === 'numbered') {
          controls = `<nav data-alloro-pagination-controls data-alloro-numbered-pagination style="display:flex;justify-content:center;gap:8px;margin-top:2rem;"></nav>`;
        } else if (sc.paginate === 'infinite') {
          controls = `<div data-alloro-pagination-controls data-alloro-scroll-sentinel style="height:1px;"></div>`;
        }
      }

      // Paginated container uses display:contents so it's transparent to grid layout
      const gridContent = `<div data-alloro-paginated="true" data-paginate-type="review" data-paginate-mode="${sc.paginate}" data-per-page="${perPage}" data-total-posts="${totalReviews}" data-total-pages="${totalPages}" data-current-page="1" data-filters="${escapeHtml(filters)}" data-block-template="${templateBase64}" data-api-base="/api/reviews/${encodeURIComponent(apiHostname)}" style="display:contents">${renderedReviews.join('\n')}</div>`;

      // Insert controls inside the section wrapper (after the grid close)
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

      result = result.replace(sc.raw, before + gridContent + afterWithControls);
    } else {
      result = result.replace(sc.raw, before + renderedReviews.join('\n') + after);
    }
  }

  // Inject pagination client script if any review block uses pagination
  if (hasPagination) {
    const script = getPaginationScript();
    result = result.replace('</body>', script + '</body>');
  }

  return result;
}
