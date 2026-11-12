/**
 * Single Post Service
 *
 * Resolves /{type-slug}/{post-slug} URLs to post type + post data.
 * Used by the site route to render single post pages.
 */

import { getDb } from '../lib/db';
import { getRedis } from '../lib/redis';
import { readLayoutChoice } from '../utils/singlePostLayout';

const SINGLE_POST_TTL = 120; // 2 minutes

/**
 * The stored sections of the page layout a site picked for a post type, or null for Default
 * (getAlloro/alloro plans/10162026-single-post-layouts, Slice 2). The layout is looked up in the
 * site's template family: the template's slug, or its id when it has none — the same rule Alloro
 * applies in SinglePostLayoutModel. One query, not cached, and any failure (table or column
 * missing, query error) means Default, so a layout can never take a page down.
 */
export async function getPickedLayoutSections(
  project: { id: string; template_id: string | null; single_layouts?: unknown },
  postTypeSlug: string,
): Promise<unknown | null> {
  const choice = readLayoutChoice(project.single_layouts, postTypeSlug);
  if (!choice || !project.template_id) return null;
  try {
    const row = await getDb()('single_post_layouts as layout')
      .whereRaw(
        "layout.template_family = (select coalesce(nullif(template.slug, ''), template.id::text) from templates as template where template.id = ?)",
        [project.template_id],
      )
      .where('layout.post_type_slug', postTypeSlug)
      .where('layout.slug', choice)
      .first('layout.sections');
    return row ? row.sections : null;
  } catch (err) {
    console.warn(`[site] Page layout "${choice}" for ${postTypeSlug} on project ${project.id} could not be read; using Default:`, err);
    return null;
  }
}

interface SinglePostResult {
  postType: {
    id: string;
    slug: string;
    name: string;
    single_template: { name: string; content: string }[] | string;
  };
  post: {
    id: string;
    title: string;
    slug: string;
    content: string;
    excerpt: string | null;
    featured_image: string | null;
    custom_fields: Record<string, unknown> | string | null;
    seo_data: Record<string, unknown> | null;
    categories: string;
    tags: string;
    created_at: string;
    updated_at: string;
    published_at: string | null;
  };
}

/**
 * Look up a published post by type slug and post slug.
 * Returns the post type (with single_template) and enriched post data, or null.
 */
export async function getSinglePostData(
  projectId: string,
  templateId: string,
  typeSlug: string,
  postSlug: string
): Promise<SinglePostResult | null> {
  const redis = getRedis();
  const cacheKey = `sp:${projectId}:${typeSlug}:${postSlug}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // Cache miss
  }

  const db = getDb();

  // Look up post type by slug + template
  const postType = await db('post_types')
    .where({ template_id: templateId, slug: typeSlug })
    .select('id', 'slug', 'name', 'single_template')
    .first();

  if (!postType) return null;

  // Parse single_template if string
  if (typeof postType.single_template === 'string') {
    try { postType.single_template = JSON.parse(postType.single_template); } catch { postType.single_template = []; }
  }

  // Look up published post
  const post = await db('posts')
    .where({
      project_id: projectId,
      post_type_id: postType.id,
      slug: postSlug,
      status: 'published',
    })
    .select(
      'id', 'title', 'slug', 'content', 'excerpt', 'featured_image',
      'custom_fields', 'seo_data', 'created_at', 'updated_at', 'published_at'
    )
    .first();

  if (!post) return null;

  // Enrich with categories and tags
  const [catRows, tagRows] = await Promise.all([
    db('post_category_assignments')
      .join('post_categories', 'post_category_assignments.category_id', 'post_categories.id')
      .where('post_category_assignments.post_id', post.id)
      .select('post_categories.name'),
    db('post_tag_assignments')
      .join('post_tags', 'post_tag_assignments.tag_id', 'post_tags.id')
      .where('post_tag_assignments.post_id', post.id)
      .select('post_tags.name'),
  ]);

  post.categories = catRows.map((r: any) => r.name).join(', ');
  post.tags = tagRows.map((r: any) => r.name).join(', ');

  const result: SinglePostResult = { postType, post };

  try {
    await redis.set(cacheKey, JSON.stringify(result), 'EX', SINGLE_POST_TTL);
  } catch {
    // Cache write failure is non-fatal
  }

  return result;
}
