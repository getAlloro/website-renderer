/**
 * Shortcode parser for {{ post_block }} tokens.
 *
 * Syntax:
 *   {{ post_block id='slug' items='post-type-slug' [tags='t1,t2'] [cats='c1,c2']
 *      [ids='s1,s2'] [exc_ids='s3'] [order='asc|desc'] [order_by='created_at|title|sort_order|published_at']
 *      [limit='10'] [offset='0'] }}
 */

export interface PostBlockShortcode {
  raw: string;
  id: string;
  items: string;
  empty: string;
  tags: string[];
  cats: string[];
  ids: string[];
  exc_ids: string[];
  order: 'asc' | 'desc';
  order_by: 'created_at' | 'title' | 'sort_order' | 'published_at';
  limit: number;
  offset: number;
  paginate: 'none' | 'load-more' | 'numbered' | 'infinite';
  per_page: number;
}

const SHORTCODE_REGEX = /\{\{\s*post_block\s+((?:[a-z_]+='[^']*'\s*)+)\}\}/g;
const ATTR_REGEX = /([a-z_]+)='([^']*)'/g;

const VALID_ORDER_BY = new Set(['created_at', 'title', 'sort_order', 'published_at']);
const VALID_PAGINATE = new Set(['none', 'load-more', 'numbered', 'infinite']);

/**
 * Parse all {{ post_block ... }} shortcodes from an HTML string.
 * Invalid shortcodes (missing required attrs) are skipped — left as raw text.
 */
export function parseShortcodes(html: string): PostBlockShortcode[] {
  const results: PostBlockShortcode[] = [];

  let match: RegExpExecArray | null;
  // Reset regex state
  SHORTCODE_REGEX.lastIndex = 0;

  while ((match = SHORTCODE_REGEX.exec(html)) !== null) {
    const raw = match[0];
    const attrString = match[1];

    const attrs: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    ATTR_REGEX.lastIndex = 0;

    while ((attrMatch = ATTR_REGEX.exec(attrString)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }

    // Required attributes
    if (!attrs.id || !attrs.items) {
      continue; // Invalid — leave raw token in HTML
    }

    const orderBy = attrs.order_by || 'created_at';

    results.push({
      raw,
      id: attrs.id,
      items: attrs.items,
      empty: attrs.empty || '',
      tags: attrs.tags ? attrs.tags.split(',').map((s) => s.trim()).filter(Boolean) : [],
      cats: attrs.cats ? attrs.cats.split(',').map((s) => s.trim()).filter(Boolean) : [],
      ids: attrs.ids ? attrs.ids.split(',').map((s) => s.trim()).filter(Boolean) : [],
      exc_ids: attrs.exc_ids ? attrs.exc_ids.split(',').map((s) => s.trim()).filter(Boolean) : [],
      order: attrs.order === 'desc' ? 'desc' : 'asc',
      order_by: VALID_ORDER_BY.has(orderBy) ? orderBy as PostBlockShortcode['order_by'] : 'created_at',
      limit: attrs.limit !== undefined ? (parseInt(attrs.limit, 10) >= 0 ? parseInt(attrs.limit, 10) : 10) : 10,
      offset: attrs.offset ? parseInt(attrs.offset, 10) || 0 : 0,
      paginate: VALID_PAGINATE.has(attrs.paginate) ? attrs.paginate as PostBlockShortcode['paginate'] : 'none',
      per_page: attrs.per_page ? parseInt(attrs.per_page, 10) || 9 : (attrs.limit ? (parseInt(attrs.limit, 10) || 9) : 9),
    });
  }

  return results;
}

/**
 * HTML-escape a string to prevent XSS when injecting post data.
 * Used for all non-content post tokens (title, excerpt, etc.).
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Replace {{post.*}} tokens in post block HTML with actual post data.
 * - {{post.content}} is injected as raw HTML (trusted admin content)
 * - All other tokens are HTML-escaped
 */
/**
 * Wrap post content HTML with scoped typography styles so paragraphs,
 * headings, lists, and blockquotes retain proper spacing even when
 * the site's CSS reset strips default margins.
 */
const POST_CONTENT_STYLES = [
  '.alloro-pc{line-height:1.7!important}',
  // Spacing — !important to override site CSS resets
  '.alloro-pc p{display:block!important;margin-bottom:1em!important}',
  '.alloro-pc p:empty,.alloro-pc p:has(> br:only-child){min-height:1em!important}',
  '.alloro-pc h1{display:block!important;font-size:2em!important;font-weight:700!important;margin-top:1.5em!important;margin-bottom:.5em!important}',
  '.alloro-pc h2{display:block!important;font-size:1.5em!important;font-weight:700!important;margin-top:1.5em!important;margin-bottom:.5em!important}',
  '.alloro-pc h3{display:block!important;font-size:1.25em!important;font-weight:600!important;margin-top:1.5em!important;margin-bottom:.5em!important}',
  '.alloro-pc h4{display:block!important;font-size:1.1em!important;font-weight:600!important;margin-top:1.25em!important;margin-bottom:.5em!important}',
  // Lists
  '.alloro-pc ul{display:block!important;list-style-type:disc!important;margin-bottom:1em!important;padding-left:1.5em!important}',
  '.alloro-pc ol{display:block!important;list-style-type:decimal!important;margin-bottom:1em!important;padding-left:1.5em!important}',
  '.alloro-pc li{display:list-item!important;margin-bottom:.25em!important}',
  // Blockquote
  '.alloro-pc blockquote{display:block!important;margin:1em 0!important;padding:0.5em 0 0.5em 1em!important;border-left:3px solid #d1d5db!important;font-style:italic!important;color:#374151!important}',
  '.alloro-pc blockquote p{margin-bottom:.5em!important}',
  // Inline
  '.alloro-pc strong{font-weight:700!important}',
  '.alloro-pc em{font-style:italic!important}',
  '.alloro-pc u{text-decoration:underline!important}',
  '.alloro-pc s{text-decoration:line-through!important}',
  '.alloro-pc a{color:#2563eb!important;text-decoration:underline!important}',
  // Media
  '.alloro-pc img{max-width:100%!important;height:auto!important;margin:.5em 0!important;border-radius:8px}',
  // Horizontal rule
  '.alloro-pc hr{border:none!important;border-top:1px solid #d1d5db!important;margin:2em 0!important}',
].join('');

function wrapPostContent(html: string): string {
  if (!html) return '';
  return `<style>${POST_CONTENT_STYLES}</style><div class="alloro-pc">${html}</div>`;
}

// =====================================================================
// CONDITIONAL RENDERING ({{if}} / {{if_not}} / {{endif}})
// =====================================================================

/**
 * Post token data shape used for conditional rendering and token replacement.
 */
export interface PostTokenData {
  title: string;
  slug: string;
  url: string;
  content: string;
  excerpt: string | null;
  featured_image: string | null;
  custom_fields: Record<string, unknown>;
  categories: string;
  tags: string;
  created_at: string;
  updated_at: string;
  published_at: string;
}

/**
 * Strip {{if post.X}}...{{endif}} and {{if_not post.X}}...{{endif}} blocks
 * based on whether the named field is empty.
 *
 * Syntax:
 *   {{if post.featured_image}}<img src="{{post.featured_image}}"/>{{endif}}
 *   {{if_not post.featured_image}}<div class="fallback"></div>{{endif}}
 *   {{if post.custom.video_url}}...{{endif}}
 *
 * Empty definition: null, undefined, empty string "", or empty array [].
 * Explicitly NOT empty: "0", 0, false, whitespace-only strings, non-empty
 * arrays, objects.
 *
 * Flat only — nested conditionals are detected; on detection the ENTIRE
 * input HTML is returned unchanged and a warning is logged. Loud-by-design
 * so authors see the bug instead of silent mis-rendering.
 *
 * NOTE: This function is duplicated in two other locations. Keep in sync.
 * The gallery-loop pass (renderGalleryLoops + processItemConditionals
 * below) must ALSO stay in sync across all three:
 *   - alloro/src/controllers/user-website/user-website-services/shortcodeResolver.service.ts
 *   - alloro/frontend/src/components/Admin/PostBlocksTab.tsx
 */
const CONDITIONAL_BLOCK_RE = /\{\{\s*(if|if_not)\s+post\.([\w.]+)\s*\}\}([\s\S]*?)\{\{\s*endif\s*\}\}/g;
const ORPHAN_CONDITIONAL_RE = /\{\{\s*(?:if|if_not)\s+[^}]*\}\}|\{\{\s*endif\s*\}\}/g;
const NESTED_PROBE_RE = /\{\{\s*(?:if|if_not)\s+/;

function isEmptyField(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function resolvePostField(post: PostTokenData, field: string): unknown {
  if (field.startsWith('custom.')) {
    const slug = field.slice('custom.'.length);
    return post.custom_fields ? post.custom_fields[slug] : undefined;
  }
  return (post as unknown as Record<string, unknown>)[field];
}

export function processConditionals(html: string, post: PostTokenData): string {
  if (!html.includes('{{if')) return html;

  // Nesting detection pass. If any block body contains another {{if}}
  // or {{if_not}}, abort loudly and return the input untouched.
  for (const probe of html.matchAll(CONDITIONAL_BLOCK_RE)) {
    if (NESTED_PROBE_RE.test(probe[3])) {
      console.warn(
        `[shortcodes] Nested conditional detected in post template (flat-only in v1). ` +
          `Field: post.${probe[2]}. Block: ${probe[0].slice(0, 200)}`
      );
      return html;
    }
  }

  // Strip-or-unwrap pass.
  let result = html.replace(CONDITIONAL_BLOCK_RE, (_match, kind: string, field: string, body: string) => {
    const value = resolvePostField(post, field);
    const empty = isEmptyField(value);
    const keep = kind === 'if' ? !empty : empty;
    return keep ? body : '';
  });

  // Orphan cleanup: strip any stray markers left by malformed input.
  result = result.replace(ORPHAN_CONDITIONAL_RE, '');

  return result;
}

// =====================================================================
// Gallery Loop Rendering ({{start_gallery_loop field='X'}}...{{end_gallery_loop}})
//
// For a given custom field that holds an array of
//   { url: string; link?: string; alt?: string; caption?: string }
// items, emit the body once per item, with {{item.url|link|alt|caption}}
// replaced and {{if item.X}}/{{if_not item.X}} resolved.
//
// Runs BEFORE processConditionals so the inner {{if item.link}} blocks
// inside a gallery body are resolved into flat HTML first — this
// preserves the outer processConditionals' flat-only invariant for the
// surrounding {{if post.custom.<slug>}} block.
//
// Empty or missing arrays → block replaced with "". Missing item keys →
// empty escaped string.
// =====================================================================

const GALLERY_LOOP_RE =
  /\{\{\s*start_gallery_loop\s+field='([a-z0-9_-]+)'\s*\}\}([\s\S]*?)\{\{\s*end_gallery_loop\s*\}\}/gi;
const ITEM_CONDITIONAL_BLOCK_RE =
  /\{\{\s*(if|if_not)\s+item\.([\w.]+)\s*\}\}([\s\S]*?)\{\{\s*endif\s*\}\}/g;
const ITEM_ORPHAN_CONDITIONAL_RE =
  /\{\{\s*(?:if|if_not)\s+item\.[^}]*\}\}|\{\{\s*endif\s*\}\}/g;

function processItemConditionals(body: string, item: Record<string, unknown>): string {
  if (!body.includes('{{if')) return body;

  for (const probe of body.matchAll(ITEM_CONDITIONAL_BLOCK_RE)) {
    if (NESTED_PROBE_RE.test(probe[3])) {
      console.warn(
        `[shortcodes] Nested item conditional detected in gallery loop (flat-only). ` +
          `Field: item.${probe[2]}. Block: ${probe[0].slice(0, 200)}`
      );
      return body;
    }
  }

  let result = body.replace(
    ITEM_CONDITIONAL_BLOCK_RE,
    (_match, kind: string, field: string, inner: string) => {
      const value = (item as Record<string, unknown>)[field];
      const empty = isEmptyField(value);
      const keep = kind === 'if' ? !empty : empty;
      return keep ? inner : '';
    }
  );

  result = result.replace(ITEM_ORPHAN_CONDITIONAL_RE, '');
  return result;
}

export function renderGalleryLoops(
  html: string,
  customFields: Record<string, unknown>
): string {
  if (!html.includes('start_gallery_loop')) return html;

  return html.replace(
    GALLERY_LOOP_RE,
    (_match, slug: string, body: string) => {
      const raw = customFields ? customFields[slug] : undefined;
      if (!Array.isArray(raw) || raw.length === 0) return '';

      const perItem = raw.map((item) => {
        const safeItem =
          item && typeof item === 'object' && !Array.isArray(item)
            ? (item as Record<string, unknown>)
            : {};
        let out = processItemConditionals(body, safeItem);
        const get = (key: string): string => {
          const v = safeItem[key];
          if (v === null || v === undefined) return '';
          if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
            return '';
          }
          return escapeHtml(String(v));
        };
        out = out.replace(/\{\{\s*item\.url\s*\}\}/g, get('url'));
        out = out.replace(/\{\{\s*item\.link\s*\}\}/g, get('link'));
        out = out.replace(/\{\{\s*item\.alt\s*\}\}/g, get('alt'));
        out = out.replace(/\{\{\s*item\.caption\s*\}\}/g, get('caption'));
        return out;
      });

      return perItem.join('\n');
    }
  );
}

export function renderPostBlockHtml(
  blockHtml: string,
  post: PostTokenData
): string {
  // Step A: resolve gallery loops FIRST so any inner {{if item.X}} is
  // fully resolved into flat HTML before processConditionals runs — the
  // outer conditional engine is flat-only and would otherwise bail.
  const afterGallery = renderGalleryLoops(blockHtml, post.custom_fields || {});

  // Step B: strip {{if post.X}}/{{if_not post.X}} blocks whose field is
  // empty, before any token replacement runs.
  const processed = processConditionals(afterGallery, post);

  let html = processed
    .replace(/\{\{post\.title\}\}/g, escapeHtml(post.title))
    .replace(/\{\{post\.slug\}\}/g, escapeHtml(post.slug))
    .replace(/\{\{post\.url\}\}/g, escapeHtml(post.url))
    .replace(/\{\{post\.content\}\}/g, wrapPostContent(post.content)) // raw HTML — trusted, wrapped with typography
    .replace(/\{\{post\.excerpt\}\}/g, escapeHtml(post.excerpt || ''))
    .replace(/\{\{post\.featured_image\}\}/g, escapeHtml(post.featured_image || ''))
    .replace(/\{\{post\.categories\}\}/g, escapeHtml(post.categories))
    .replace(/\{\{post\.tags\}\}/g, escapeHtml(post.tags))
    .replace(/\{\{post\.created_at\}\}/g, escapeHtml(post.created_at))
    .replace(/\{\{post\.updated_at\}\}/g, escapeHtml(post.updated_at))
    .replace(/\{\{post\.published_at\}\}/g, escapeHtml(post.published_at));

  // Video embed — generates responsive iframe from video_url custom field
  html = html.replace(/\{\{post\.video_embed\}\}/g, () => {
    const url = String(post.custom_fields['video_url'] || '');
    if (!url) return '';
    return buildVideoEmbed(url);
  });

  // Replace {{post.custom.<slug>}} tokens with custom field values.
  // Scalar-only: the gallery-loop pass in Step A consumed valid {{item.*}}
  // tokens, so any non-primitive value reaching this replacement is either
  // an unresolved gallery referenced as a scalar or a malformed value.
  // Emit "" rather than coercing (avoids `[object Object]` / `,,` output).
  // Newlines are converted to <br> after escaping so textarea content
  // renders with line breaks.
  html = html.replace(/\{\{post\.custom\.([a-z0-9_]+)\}\}/g, (_match, fieldSlug: string) => {
    const value = post.custom_fields[fieldSlug];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return '';
    }
    return escapeHtml(String(value)).replace(/\n/g, '<br>');
  });

  return html;
}

/**
 * Check if an HTML string contains any {{ post_block }} shortcodes.
 * Fast check before running the full parser.
 */
export function hasPostBlockShortcodes(html: string): boolean {
  return html.includes('post_block');
}

// =====================================================================
// VIDEO EMBED BUILDER
// =====================================================================

function buildVideoEmbed(url: string): string {
  if (!url) return '';

  // YouTube: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID
  const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]+)/);
  if (ytMatch) {
    return `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:12px;"><iframe src="https://www.youtube.com/embed/${ytMatch[1]}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen></iframe></div>`;
  }

  // Dailymotion: dailymotion.com/video/ID, dai.ly/ID
  const dmMatch = url.match(/(?:dailymotion\.com\/video\/|dai\.ly\/)([\w]+)/);
  if (dmMatch) {
    return `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:12px;"><iframe src="https://www.dailymotion.com/embed/video/${dmMatch[1]}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allowfullscreen></iframe></div>`;
  }

  // Vimeo: vimeo.com/ID
  const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
  if (vimeoMatch) {
    return `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:12px;"><iframe src="https://player.vimeo.com/video/${vimeoMatch[1]}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allow="autoplay;fullscreen;picture-in-picture" allowfullscreen></iframe></div>`;
  }

  // Loom: loom.com/share/ID
  const loomMatch = url.match(/loom\.com\/share\/([\w]+)/);
  if (loomMatch) {
    return `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:12px;"><iframe src="https://www.loom.com/embed/${loomMatch[1]}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allowfullscreen></iframe></div>`;
  }

  return '';
}

// =====================================================================
// MENU SHORTCODES
// =====================================================================

export interface MenuShortcode {
  raw: string;
  id: string; // menu slug
  template: string; // menu template slug (empty = bare HTML fallback)
}

const MENU_SHORTCODE_REGEX = /\{\{\s*menu\s+((?:[a-z_]+='[^']*'\s*)+)\}\}/g;

/**
 * Parse all {{ menu id='slug' }} shortcodes from an HTML string.
 */
export function parseMenuShortcodes(html: string): MenuShortcode[] {
  const results: MenuShortcode[] = [];
  MENU_SHORTCODE_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MENU_SHORTCODE_REGEX.exec(html)) !== null) {
    const raw = match[0];
    const attrString = match[1];

    const attrs: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    ATTR_REGEX.lastIndex = 0;
    while ((attrMatch = ATTR_REGEX.exec(attrString)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }

    if (!attrs.id) continue;

    results.push({ raw, id: attrs.id, template: attrs.template || "" });
  }

  return results;
}

/**
 * Check if an HTML string contains any {{ menu }} shortcodes.
 */
export function hasMenuShortcodes(html: string): boolean {
  return html.includes('{{ menu') || html.includes('{{menu');
}

// =====================================================================
// REVIEW BLOCK SHORTCODES
// =====================================================================

export interface ReviewBlockShortcode {
  raw: string;
  id: string;
  empty: string;
  location: string;
  min_rating: number;
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
  paginate: 'none' | 'load-more' | 'numbered' | 'infinite';
  per_page: number;
}

const REVIEW_BLOCK_SHORTCODE_REGEX = /\{\{\s*review_block\s+((?:[a-z_]+='[^']*'\s*)+)\}\}/g;

/**
 * Parse all {{ review_block id='slug' ... }} shortcodes from an HTML string.
 */
export function parseReviewBlockShortcodes(html: string): ReviewBlockShortcode[] {
  const results: ReviewBlockShortcode[] = [];
  REVIEW_BLOCK_SHORTCODE_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = REVIEW_BLOCK_SHORTCODE_REGEX.exec(html)) !== null) {
    const raw = match[0];
    const attrString = match[1];

    const attrs: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    ATTR_REGEX.lastIndex = 0;
    while ((attrMatch = ATTR_REGEX.exec(attrString)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }

    if (!attrs.id) continue;

    results.push({
      raw,
      id: attrs.id,
      empty: attrs.empty || '',
      location: attrs.location || 'primary',
      min_rating: attrs.min_rating ? parseInt(attrs.min_rating, 10) || 1 : 1,
      limit: attrs.limit !== undefined ? (parseInt(attrs.limit, 10) >= 0 ? parseInt(attrs.limit, 10) : 10) : 10,
      offset: attrs.offset ? parseInt(attrs.offset, 10) || 0 : 0,
      order: attrs.order === 'asc' ? 'asc' : 'desc',
      paginate: VALID_PAGINATE.has(attrs.paginate) ? attrs.paginate as ReviewBlockShortcode['paginate'] : 'none',
      per_page: attrs.per_page ? parseInt(attrs.per_page, 10) || 6 : (attrs.limit ? (parseInt(attrs.limit, 10) || 6) : 6),
    });
  }

  return results;
}

/**
 * Check if an HTML string contains any {{ review_block }} shortcodes.
 */
export function hasReviewBlockShortcodes(html: string): boolean {
  return html.includes('review_block');
}

/**
 * Generate star SVG HTML (filled + empty) for a given count.
 */
function generateStarsHtml(count: number): string {
  const filled = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-5 h-5 text-yellow-400"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
  const empty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" class="w-5 h-5 text-gray-300"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
  const stars: string[] = [];
  for (let i = 1; i <= 5; i++) {
    stars.push(i <= count ? filled : empty);
  }
  return stars.join('');
}

function formatReviewDate(dateStr: string | Date | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Replace {{review.*}} tokens in review block HTML with actual review data.
 */
export function renderReviewBlockHtml(
  template: string,
  review: {
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
): string {
  let html = template;
  html = html.replace(/\{\{review\.stars\}\}/g, String(review.stars || 0));
  html = html.replace(/\{\{review\.stars_html\}\}/g, generateStarsHtml(review.stars || 0));
  html = html.replace(/\{\{review\.text\}\}/g, escapeHtml(review.text || ''));
  html = html.replace(/\{\{review\.reviewer_name\}\}/g, escapeHtml(review.reviewer_name || 'Anonymous'));
  html = html.replace(/\{\{review\.reviewer_photo\}\}/g, escapeHtml(review.reviewer_photo_url || ''));
  html = html.replace(/\{\{review\.is_anonymous\}\}/g, String(review.is_anonymous || false));
  html = html.replace(/\{\{review\.date\}\}/g, escapeHtml(formatReviewDate(review.review_created_at)));
  html = html.replace(/\{\{review\.has_reply\}\}/g, String(review.has_reply || false));
  html = html.replace(/\{\{review\.reply_text\}\}/g, escapeHtml(review.reply_text || ''));
  html = html.replace(/\{\{review\.reply_date\}\}/g, escapeHtml(formatReviewDate(review.reply_date)));
  return html;
}
