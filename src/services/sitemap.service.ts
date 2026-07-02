import { getDb } from '../lib/db';
import { getRedis } from '../lib/redis';
import type { Project } from '../types';

/**
 * Per-project robots.txt + sitemap.xml.
 *
 * Both paths previously fell through the unknown-path homepage fallback —
 * every client site served its homepage HTML at /robots.txt and /sitemap.xml,
 * so Google had no clean discovery of pages or posts. Sitemaps are built from
 * published pages plus published posts at /{post_type.slug}/{post.slug}, with
 * absolute URLs on the project's primary public host, and Redis-cached like
 * the other per-site data (keys included in the ?nocache=1 flush).
 */

const CACHE_TTL = 3600; // 1 hour — content changes surface via ?nocache=1 or TTL

/**
 * The single canonical host for a site — shared by canonical tags, og:url,
 * sitemap loc URLs, the robots Sitemap: line, AND the host-unification
 * redirect. All must agree on ONE host or Google sees www and non-www as
 * duplicate copies.
 *
 * Prefers the www variant when the project actually has it configured
 * (custom_domain_alt is exactly `www.<custom_domain>`): the established
 * client sites are indexed on www and their sitemaps were submitted to Search
 * Console on www, so www is the lowest-churn unification (canonicals don't
 * move; only the sitemap/robots host aligns to match). Falls back to the bare
 * custom_domain when there is no www alt, and to the generated hostname for
 * sites without a custom domain (never www'd).
 */
export function primaryPublicHost(project: Project): string {
  if (project.custom_domain) {
    const wwwVariant = `www.${project.custom_domain}`;
    if (project.custom_domain_alt === wwwVariant) return wwwVariant;
    return project.custom_domain;
  }
  return `${project.generated_hostname}.sites.getalloro.com`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function buildRobotsTxt(project: Project): Promise<string> {
  const redis = getRedis();
  const cacheKey = `robots:${project.id}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return cached;
  } catch {
    // cache miss/error — build fresh
  }

  const host = primaryPublicHost(project);
  const robots = `User-agent: *\nAllow: /\n\nSitemap: https://${host}/sitemap.xml\n`;

  try {
    await redis.set(cacheKey, robots, 'EX', CACHE_TTL);
  } catch {
    // non-fatal
  }

  return robots;
}

export async function buildSitemapXml(project: Project): Promise<string> {
  const redis = getRedis();
  const cacheKey = `sitemap:${project.id}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return cached;
  } catch {
    // cache miss/error — build fresh
  }

  const db = getDb();
  const host = primaryPublicHost(project);

  const pages: Array<{ path: string; updated_at: Date | string | null }> = await db(
    'website_builder.pages'
  )
    .where({ project_id: project.id, status: 'published' })
    .select('path', 'updated_at');

  const posts: Array<{ slug: string; type_slug: string; updated_at: Date | string | null }> =
    await db('website_builder.posts as p')
      .join('website_builder.post_types as pt', 'p.post_type_id', 'pt.id')
      .where('p.project_id', project.id)
      .where('p.status', 'published')
      .select('p.slug', 'pt.slug as type_slug', 'p.updated_at');

  const seen = new Set<string>();
  const entries: Array<{ path: string; lastmod: string | null }> = [];

  const toLastmod = (value: Date | string | null): string | null => {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
  };

  for (const page of pages) {
    if (!page.path || seen.has(page.path)) continue;
    seen.add(page.path);
    entries.push({ path: page.path, lastmod: toLastmod(page.updated_at) });
  }
  for (const post of posts) {
    const path = `/${post.type_slug}/${post.slug}`;
    if (seen.has(path)) continue;
    seen.add(path);
    entries.push({ path, lastmod: toLastmod(post.updated_at) });
  }

  const urlBlocks = entries
    .map((entry) => {
      const loc = `https://${host}${entry.path === '/' ? '/' : entry.path}`;
      const lastmod = entry.lastmod ? `\n    <lastmod>${entry.lastmod}</lastmod>` : '';
      return `  <url>\n    <loc>${xmlEscape(loc)}</loc>${lastmod}\n  </url>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlBlocks}\n</urlset>\n`;

  try {
    await redis.set(cacheKey, xml, 'EX', CACHE_TTL);
  } catch {
    // non-fatal
  }

  return xml;
}
