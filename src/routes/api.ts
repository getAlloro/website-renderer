/**
 * Public JSON API Routes
 *
 * Paginated endpoints for posts and reviews, keyed by hostname.
 * These routes run BEFORE the subdomain middleware since they use
 * :hostname as a path parameter instead of relying on subdomains.
 */

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDb } from '../lib/db';
import { getRedis } from '../lib/redis';
import {
  getProjectByHostname,
  getProjectByCustomDomain,
  getProjectByPendingDomain,
  getDomainRedirectTarget,
} from '../services/project.service';
import {
  fetchReviewCount,
  fetchReviews,
  getProjectReviewScope,
} from '../services/review.service';
import type { Project } from '../types';

const API_CACHE_TTL = 120; // 2 minutes

// ---------------------------------------------------------------------------
// Rate limiter — 30 requests/minute per IP, in-memory
// ---------------------------------------------------------------------------

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    next();
    return;
  }

  if (bucket.count >= RATE_LIMIT) {
    res.status(429).json({ error: 'Too many requests. Try again later.' });
    return;
  }

  bucket.count++;
  next();
}

// Periodically prune stale buckets (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(ip);
  }
}, 300_000).unref();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveProject(hostname: string): Promise<Project | null> {
  const project = await getProjectByHostname(hostname);
  if (project) return project;
  const verified = await getProjectByCustomDomain(hostname);
  if (verified) return verified;
  // Domain switch fallbacks (verified lookup first, unchanged): a pending domain
  // and an old redirected domain both resolve to their live project, so
  // pagination on a page loaded before a switch keeps working.
  return (await getProjectByPendingDomain(hostname)) ?? (await getDomainRedirectTarget(hostname));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hashParams(parts: string[]): string {
  return crypto.createHash('md5').update(parts.join('|')).digest('hex').slice(0, 12);
}

function parseCommaSeparated(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// GET /api/posts/:hostname/:postTypeSlug
// ---------------------------------------------------------------------------

async function postsHandler(req: Request, res: Response): Promise<void> {
  const hostname = req.params.hostname as string;
  const postTypeSlug = req.params.postTypeSlug as string;

  const project = await resolveProject(hostname);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const page = clamp(parseInt(req.query.page as string, 10) || 1, 1, Infinity);
  const perPage = clamp(parseInt(req.query.per_page as string, 10) || 9, 1, 50);
  const order: 'asc' | 'desc' = req.query.order === 'asc' ? 'asc' : 'desc';
  const orderBy = ['title', 'created_at', 'updated_at', 'published_at', 'sort_order'].includes(req.query.order_by as string)
    ? (req.query.order_by as string)
    : 'created_at';

  const cats = parseCommaSeparated(req.query.cats);
  const tags = parseCommaSeparated(req.query.tags);
  const ids = parseCommaSeparated(req.query.ids);
  const excIds = parseCommaSeparated(req.query.exc_ids);

  // Cache check
  const redis = getRedis();
  const cacheKey = `api:posts:${project.id}:${postTypeSlug}:${hashParams([
    String(page), String(perPage), order, orderBy,
    cats.join(','), tags.join(','), ids.join(','), excIds.join(','),
  ])}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      res.json(JSON.parse(cached));
      return;
    }
  } catch {
    // Cache miss or Redis down — fall through to DB
  }

  const db = getDb();

  // Base query builder (shared between count and data queries)
  function applyFilters(query: any) {
    query = query
      .join('post_types', 'posts.post_type_id', 'post_types.id')
      .where({
        'posts.project_id': project!.id,
        'posts.status': 'published',
        'post_types.slug': postTypeSlug,
      });

    if (ids.length > 0) {
      query = query.whereIn('posts.slug', ids);
    }
    if (excIds.length > 0) {
      query = query.whereNotIn('posts.slug', excIds);
    }
    if (cats.length > 0) {
      query = query.whereExists(function (this: any) {
        this.select(db.raw('1'))
          .from('post_category_assignments')
          .join('post_categories', 'post_category_assignments.category_id', 'post_categories.id')
          .whereRaw('post_category_assignments.post_id = posts.id')
          .whereIn('post_categories.slug', cats);
      });
    }
    if (tags.length > 0) {
      query = query.whereExists(function (this: any) {
        this.select(db.raw('1'))
          .from('post_tag_assignments')
          .join('post_tags', 'post_tag_assignments.tag_id', 'post_tags.id')
          .whereRaw('post_tag_assignments.post_id = posts.id')
          .whereIn('post_tags.slug', tags);
      });
    }

    return query;
  }

  // Total count
  const countQuery = applyFilters(db('posts')).count('posts.id as total').first();
  const countResult = await countQuery;
  const total = parseInt(String(countResult?.total ?? '0'), 10);
  const totalPages = Math.ceil(total / perPage);

  // Data query
  const offset = (page - 1) * perPage;
  const orderColumn = orderBy === 'title' ? 'posts.title'
    : orderBy === 'sort_order' ? 'posts.sort_order'
    : orderBy === 'published_at' ? 'posts.published_at'
    : orderBy === 'updated_at' ? 'posts.updated_at'
    : 'posts.created_at';

  const posts = await applyFilters(db('posts'))
    .select(
      'posts.id',
      'posts.title',
      'posts.slug',
      'posts.content',
      'posts.excerpt',
      'posts.featured_image',
      'posts.custom_fields',
      'posts.created_at',
      'posts.updated_at',
      'posts.published_at'
    )
    .orderBy(orderColumn, order)
    .limit(perPage)
    .offset(offset);

  // Enrich with category and tag names
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
      post.categories = catMap.get(post.id) || [];
      post.tags = tagMap.get(post.id) || [];
    }
  }

  // Shape response posts
  const responsePosts = posts.map((p: any) => {
    let customFields: Record<string, unknown> = {};
    if (typeof p.custom_fields === 'string') {
      try { customFields = JSON.parse(p.custom_fields); } catch { customFields = {}; }
    } else if (p.custom_fields) {
      customFields = p.custom_fields;
    }

    return {
      title: p.title,
      slug: p.slug,
      url: `/${postTypeSlug}/${p.slug}`,
      content: p.content,
      excerpt: p.excerpt,
      featured_image: p.featured_image,
      categories: p.categories || [],
      tags: p.tags || [],
      custom_fields: customFields,
      created_at: p.created_at,
      updated_at: p.updated_at,
      published_at: p.published_at,
    };
  });

  const payload = {
    posts: responsePosts,
    total,
    page,
    per_page: perPage,
    total_pages: totalPages,
  };

  try {
    await redis.set(cacheKey, JSON.stringify(payload), 'EX', API_CACHE_TTL);
  } catch {
    // Cache write failure is non-fatal
  }

  res.json(payload);
}

// ---------------------------------------------------------------------------
// GET /api/reviews/:hostname
// ---------------------------------------------------------------------------

async function reviewsHandler(req: Request, res: Response): Promise<void> {
  const hostname = req.params.hostname as string;

  const project = await resolveProject(hostname);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const page = clamp(parseInt(req.query.page as string, 10) || 1, 1, Infinity);
  const perPage = clamp(parseInt(req.query.per_page as string, 10) || 6, 1, 50);
  const order: 'asc' | 'desc' = req.query.order === 'asc' ? 'asc' : 'desc';
  const minRating = clamp(parseInt(req.query.min_rating as string, 10) || 1, 1, 5);
  const locationParam = (req.query.location as string) || 'primary';

  const scope = await getProjectReviewScope(project);

  if (scope.locationIds.length === 0 && scope.placeIds.length === 0) {
    res.json({ reviews: [], total: 0, page, per_page: perPage, total_pages: 0 });
    return;
  }

  // Cache check
  const redis = getRedis();
  const cacheKey = `api:reviews:${project.id}:${hashParams([
    scope.locationIds.join(','),
    scope.placeIds.join(','),
    locationParam,
    String(page),
    String(perPage),
    order,
    String(minRating),
  ])}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      res.json(JSON.parse(cached));
      return;
    }
  } catch {
    // Cache miss or Redis down — fall through to DB
  }

  const offset = (page - 1) * perPage;
  const filters = {
    min_rating: minRating,
    limit: perPage,
    offset,
    order,
  };
  const [total, reviews] = await Promise.all([
    fetchReviewCount(scope, filters),
    fetchReviews(scope, filters),
  ]);
  const totalPages = Math.ceil(total / perPage);

  const payload = {
    reviews,
    total,
    page,
    per_page: perPage,
    total_pages: totalPages,
  };

  try {
    await redis.set(cacheKey, JSON.stringify(payload), 'EX', API_CACHE_TTL);
  } catch {
    // Cache write failure is non-fatal
  }

  res.json(payload);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const apiRouter = Router();

apiRouter.get('/api/posts/:hostname/:postTypeSlug', rateLimiter, postsHandler);
apiRouter.get('/api/reviews/:hostname', rateLimiter, reviewsHandler);
