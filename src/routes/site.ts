import { Request, Response } from 'express';
import {
  getProjectByHostname,
  getProjectByCustomDomain,
  getArchivedProjectByHostname,
  getArchivedProjectByCustomDomain,
} from '../services/project.service';
import { getPageToRender, hasPublishedPages, getArtifactPageByPrefix } from '../services/page.service';
import { fetchArtifactIndexHtml, fetchArtifactAsset } from '../services/artifact.service';
import { getSinglePostData } from '../services/singlepost.service';
import { buildSitemapXml, buildRobotsTxt, primaryPublicHost } from '../services/sitemap.service';
import { siteNotFoundPage } from '../templates/site-not-found';
import { siteNotReadyPage } from '../templates/site-not-ready';
import { siteArchivedPage } from '../templates/site-archived';
import { pageNotFoundPage } from '../templates/page-not-found';
import { successPage } from '../templates/success-page';
import { renderPage, normalizeSections, injectSeoMeta } from '../utils/renderer';
import { resolvePostBlocks } from '../services/postblock.service';
import { resolveMenus } from '../services/menu.service';
import { resolveReviewBlocks } from '../services/review.service';
import { resolveRedirect as resolveRedirectForProject } from '../services/redirect.service';
import { renderPostBlockHtml } from '../utils/shortcodes';
import { processTailwindCSS } from '../utils/tailwind';
import type { Project, Page, SeoData } from '../types';
import { getDb } from '../lib/db';
import { getRedis } from '../lib/redis';

function getBusinessName(project: Project): string | undefined {
  if (project.step_gbp_scrape && typeof project.step_gbp_scrape === 'object') {
    return (project.step_gbp_scrape as { name?: string }).name;
  }
  return undefined;
}

/**
 * Merge code snippets: project snippets override template snippets by name+location
 */
function mergeCodeSnippets(templateSnippets: any[], projectSnippets: any[]): any[] {
  const result = [...templateSnippets];

  for (const projectSnippet of projectSnippets) {
    const existingIndex = result.findIndex(
      (s) => s.name === projectSnippet.name && s.location === projectSnippet.location
    );

    if (existingIndex >= 0) {
      result[existingIndex] = projectSnippet; // Override
    } else {
      result.push(projectSnippet); // Append
    }
  }

  return result;
}

function getApiBaseUrl(): string {
  return process.env.API_BASE_URL || 'https://app.getalloro.com';
}

const RYBBIT_API_URL = process.env.RYBBIT_API_URL || 'https://analytics.getalloro.com';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildIntegrationScript(platform: string, metadata: Record<string, any>): string | null {
  if (platform === 'rybbit' && metadata.siteId) {
    return `<script src="${RYBBIT_API_URL}/api/script.js" async data-site-id="${metadata.siteId}"></script>`;
  }
  if (platform === 'clarity' && metadata.projectId) {
    const pid = metadata.projectId;
    return `<script type="text/javascript">(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window, document, "clarity", "script", "${pid}");</script>`;
  }
  return null;
}

function hasExistingIntegrationScript(html: string, platform: string, metadata: Record<string, any>): boolean {
  if (platform === 'rybbit' && metadata.siteId) {
    const escaped = escapeRegExp(String(metadata.siteId));
    return new RegExp(`data-site-id=["']?${escaped}["'\\s>]`, 'i').test(html);
  }
  if (platform === 'clarity' && metadata.projectId) {
    const escaped = escapeRegExp(String(metadata.projectId));
    return (
      new RegExp(`clarity\\.ms/tag/["']?${escaped}["'\\s<]`, 'i').test(html) ||
      new RegExp(`["']clarity["']\\s*,\\s*["']script["']\\s*,\\s*["']${escaped}["']`, 'i').test(html)
    );
  }
  return false;
}

function injectBeforeHeadClose(html: string, scripts: string): string {
  if (!scripts) return html;
  if (!/<\/head>/i.test(html)) {
    console.warn('[site] Integration scripts were available, but the HTML has no closing </head>');
    return html;
  }
  return html.replace(/<\/head>/i, `${scripts}\n</head>`);
}

async function getIntegrationScripts(projectId: string, html: string): Promise<string> {
  if (process.env.INTEGRATIONS_SCRIPT_INJECTION === 'false') {
    console.warn('[site] Integration script injection disabled by INTEGRATIONS_SCRIPT_INJECTION=false');
    return '';
  }

  try {
    const db = getDb();
    const rows = await db('website_builder.website_integrations')
      .select('platform', 'metadata')
      .where({ project_id: projectId, status: 'active' })
      .whereIn('type', ['script_injection', 'hybrid']);

    const scripts: string[] = [];
    for (const row of rows) {
      const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      if (hasExistingIntegrationScript(html, row.platform, meta)) continue;
      const script = buildIntegrationScript(row.platform, meta);
      if (script) scripts.push(script);
    }
    return scripts.join('\n');
  } catch (err) {
    console.warn('[site] Failed to load integration scripts, falling back to header_footer_code:', err);
    return '';
  }
}

async function assembleHtml(project: Project, page: Page, servingHost: string): Promise<string> {
  const db = getDb();

  // Fetch template snippets (if project has template)
  const templateSnippets = project.template_id
    ? await db('header_footer_code')
        .where({ template_id: project.template_id, is_enabled: true })
        .orderBy('order_index', 'asc')
    : [];

  // Fetch project snippets
  const projectSnippets = await db('header_footer_code')
    .where({ project_id: project.id, is_enabled: true })
    .orderBy('order_index', 'asc');

  // Merge: project overrides template by name+location
  const mergedSnippets = mergeCodeSnippets(templateSnippets, projectSnippets);

  let html = renderPage(
    project.wrapper || '{{slot}}',
    project.header || '',
    project.footer || '',
    normalizeSections(page.sections),
    mergedSnippets,
    page.id,
    project.id,
    getApiBaseUrl()
  );

  // Resolve {{ post_block }} shortcodes (runtime post rendering)
  html = await resolvePostBlocks(html, project.template_id, project.id);

  // Resolve {{ review_block }} shortcodes (runtime review rendering)
  html = await resolveReviewBlocks(html, project.id, project.template_id || undefined);

  // Resolve {{ menu id='slug' }} shortcodes
  html = await resolveMenus(html, project.id, project.template_id || undefined);

  // Inject page-level SEO meta tags (replaces or adds to wrapper).
  // The serving context makes canonical/og:url self-derived and always
  // present, even when seo_data is null or carries junk values.
  const seoData = page.seo_data as SeoData | null;
  html = injectSeoMeta(html, seoData, { host: servingHost, path: page.path });

  // Inject integration-managed tracking scripts (Rybbit, Clarity)
  const integrationScripts = await getIntegrationScripts(project.id, html);
  html = injectBeforeHeadClose(html, integrationScripts);

  // Tailwind CSS: compile for published, Play CDN for drafts
  html = await processTailwindCSS(html, page.status === 'draft');

  return html;
}

/**
 * Assemble HTML for an artifact page (uploaded React app build).
 *
 * Fetches the app's index.html from S3, then injects:
 * - Site header after <body>
 * - Site footer before </body>
 * - SEO meta tags into <head>
 * - Code snippets at their standard injection points
 *
 * Does NOT run Tailwind compilation or inject the form handler script —
 * the React app handles its own CSS and forms.
 */
async function assembleArtifactHtml(project: Project, page: Page, servingHost: string): Promise<string> {
  if (!page.artifact_s3_prefix) {
    throw new Error(`Artifact page ${page.id} has no S3 prefix`);
  }

  const db = getDb();

  // Serve the React app's index.html as-is — no wrapper, header, or footer.
  // Only inject SEO meta tags and code snippets into the existing HTML structure.
  let html = await fetchArtifactIndexHtml(page.artifact_s3_prefix);

  // Inject SEO meta tags (canonical/og:url self-derived from serving context)
  const seoData = page.seo_data as SeoData | null;
  html = injectSeoMeta(html, seoData, { host: servingHost, path: page.path });

  // Inject code snippets (tracking scripts, analytics, etc.)
  const templateSnippets = project.template_id
    ? await db('header_footer_code')
        .where({ template_id: project.template_id, is_enabled: true })
        .orderBy('order_index', 'asc')
    : [];

  const projectSnippets = await db('header_footer_code')
    .where({ project_id: project.id, is_enabled: true })
    .orderBy('order_index', 'asc');

  const mergedSnippets = mergeCodeSnippets(templateSnippets, projectSnippets);

  if (mergedSnippets.length > 0) {
    const targeted = mergedSnippets.filter((s) => {
      if (!s.page_ids || s.page_ids.length === 0) return true;
      return s.page_ids.includes(page.id);
    });

    const byLocation: Record<string, any[]> = {
      head_start: targeted.filter((s) => s.location === 'head_start').sort((a: any, b: any) => a.order_index - b.order_index),
      head_end: targeted.filter((s) => s.location === 'head_end').sort((a: any, b: any) => a.order_index - b.order_index),
      body_start: targeted.filter((s) => s.location === 'body_start').sort((a: any, b: any) => a.order_index - b.order_index),
      body_end: targeted.filter((s) => s.location === 'body_end').sort((a: any, b: any) => a.order_index - b.order_index),
    };

    if (byLocation.head_start.length > 0) {
      const code = byLocation.head_start.map((s) => s.code).join('\n');
      html = html.replace(/<head>/i, `<head>\n${code}`);
    }
    if (byLocation.head_end.length > 0) {
      const code = byLocation.head_end.map((s) => s.code).join('\n');
      html = html.replace(/<\/head>/i, `${code}\n</head>`);
    }
    if (byLocation.body_start.length > 0) {
      const code = byLocation.body_start.map((s) => s.code).join('\n');
      html = html.replace(/<body([^>]*)>/i, `<body$1>\n${code}`);
    }
    if (byLocation.body_end.length > 0) {
      const code = byLocation.body_end.map((s) => s.code).join('\n');
      html = html.replace(/<\/body>/i, `${code}\n</body>`);
    }
  }

  // Inject integration-managed tracking scripts after legacy snippets so duplicates can be skipped.
  const integrationScripts = await getIntegrationScripts(project.id, html);
  html = injectBeforeHeadClose(html, integrationScripts);

  return html;
}

/**
 * Default single post template if none is defined on the post type.
 */
const DEFAULT_SINGLE_TEMPLATE = [
  {
    name: 'single-post',
    content: `<article style="max-width: 800px; margin: 0 auto; padding: 40px 20px;">
  <h1 style="font-size: 2rem; margin-bottom: 16px;">{{post.title}}</h1>
  <p style="color: #6b7280; font-size: 14px; margin-bottom: 24px;">{{post.published_at}}</p>
  <img src="{{post.featured_image}}" alt="{{post.title}}" style="width: 100%; max-height: 400px; object-fit: cover; border-radius: 12px; margin-bottom: 24px;" />
  <div style="line-height: 1.7;">{{post.content}}</div>
</article>`,
  },
];

function formatDateStr(dateStr: string | Date | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Assemble HTML for a single post page using the post type's single_template.
 */
async function assembleSinglePostHtml(
  project: Project,
  postType: any,
  post: any,
  servingHost: string
): Promise<string> {
  const db = getDb();

  const templateSnippets = project.template_id
    ? await db('header_footer_code')
        .where({ template_id: project.template_id, is_enabled: true })
        .orderBy('order_index', 'asc')
    : [];

  const projectSnippets = await db('header_footer_code')
    .where({ project_id: project.id, is_enabled: true })
    .orderBy('order_index', 'asc');

  const mergedSnippets = mergeCodeSnippets(templateSnippets, projectSnippets);

  // Use single_template from post type, or default
  const sections = Array.isArray(postType.single_template) && postType.single_template.length > 0
    ? postType.single_template
    : DEFAULT_SINGLE_TEMPLATE;

  // Parse custom_fields
  let customFields: Record<string, unknown> = {};
  if (typeof post.custom_fields === 'string') {
    try { customFields = JSON.parse(post.custom_fields); } catch { customFields = {}; }
  } else if (post.custom_fields) {
    customFields = post.custom_fields;
  }

  // Replace {{post.*}} tokens in each section's content
  const postData = {
    title: post.title || '',
    slug: post.slug || '',
    url: `/${postType.slug}/${post.slug}`,
    content: post.content || '',
    excerpt: post.excerpt || '',
    featured_image: post.featured_image || '',
    custom_fields: customFields,
    categories: post.categories || '',
    tags: post.tags || '',
    created_at: formatDateStr(post.created_at),
    updated_at: formatDateStr(post.updated_at),
    published_at: formatDateStr(post.published_at),
  };

  const resolvedSections = sections.map((s: any) => ({
    name: s.name,
    content: renderPostBlockHtml(s.content, postData),
  }));

  let html = renderPage(
    project.wrapper || '{{slot}}',
    project.header || '',
    project.footer || '',
    resolvedSections,
    mergedSnippets,
    undefined,
    project.id,
    getApiBaseUrl()
  );

  // Single post pages may also contain post block shortcodes
  html = await resolvePostBlocks(html, project.template_id, project.id);

  // Resolve {{ review_block }} shortcodes
  html = await resolveReviewBlocks(html, project.id, project.template_id || undefined);

  // Resolve {{ menu id='slug' }} shortcodes
  html = await resolveMenus(html, project.id, project.template_id || undefined);

  // Inject post-level SEO meta tags (canonical/og:url self-derived)
  const postSeoData = post.seo_data as SeoData | null;
  html = injectSeoMeta(html, postSeoData, {
    host: servingHost,
    path: `/${postType.slug}/${post.slug}`,
  });

  // Inject integration-managed tracking scripts (Rybbit, Clarity)
  const integrationScripts = await getIntegrationScripts(project.id, html);
  html = injectBeforeHeadClose(html, integrationScripts);

  // Tailwind CSS: single post pages are always published content
  html = await processTailwindCSS(html, false);

  return html;
}

export async function siteRoute(req: Request, res: Response): Promise<void> {
  const hostname = res.locals.hostname as string | undefined;
  const customDomain = res.locals.customDomain as string | undefined;
  const pagePath = req.path === '/' ? '/' : req.path;

  // ?nocache=1 — flush all per-site Redis cache keys for this request.
  // SCAN + per-key DEL: the production Redis is a cluster with the KEYS
  // command disabled and CROSSSLOT enforcement on multi-key DEL — the old
  // keys()+del(...) flush silently threw and did NOTHING (verified
  // 2026-07-02); every "nocache-verified" change had actually propagated
  // via TTL expiry alone.
  if (req.query.nocache === '1') {
    try {
      const redis = getRedis();
      const patterns = ['pb:*', 'posts:*', 'sp:*', 'mt:*', 'menu:*', 'tw:*', 'redir:*', 'rb:*', 'reviews:*', 'sitemap:*', 'robots:*'];
      for (const pattern of patterns) {
        let cursor = '0';
        do {
          const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
          cursor = next;
          for (const key of batch) {
            try {
              await redis.del(key);
            } catch {
              // single-key delete failure is non-fatal
            }
          }
        } while (cursor !== '0');
      }
    } catch {
      // Redis flush failure is non-fatal
    }
  }

  const project = hostname
    ? await getProjectByHostname(hostname)
    : customDomain
      ? await getProjectByCustomDomain(customDomain)
      : null;

  if (!project) {
    // A host that WAS a site gets an explicit 410 Gone (deindex signal),
    // never the soft "not found" — archived projects used to keep serving
    // full duplicate sites because nothing checked archived_at.
    const archived = hostname
      ? await getArchivedProjectByHostname(hostname)
      : customDomain
        ? await getArchivedProjectByCustomDomain(customDomain)
        : null;
    if (archived) {
      res.status(410).type('html').send(siteArchivedPage(hostname || customDomain || 'unknown'));
      return;
    }

    res.status(404).type('html').send(siteNotFoundPage(hostname || customDomain || 'unknown'));
    return;
  }

  const businessName = getBusinessName(project);
  const servingHost = primaryPublicHost(project);

  // Host unification: a custom-domain site answers on BOTH its bare domain and
  // its www variant with 200, so Google sees duplicate www/non-www copies.
  // Redirect every custom-domain request onto the one canonical host
  // (primaryPublicHost — www for sites that have a www alt). Only custom
  // domains are considered: generated *.sites.getalloro.com hostnames set
  // res.locals.hostname (not customDomain), so they never redirect. servingHost
  // is derived from the project's own domain fields, so it is always a host we
  // serve, and the `!==` guard makes this a no-op on the canonical host itself
  // (no loop). Runs before robots/sitemap so those unify onto the same host too.
  if (customDomain && customDomain !== servingHost) {
    res.redirect(301, `https://${servingHost}${req.originalUrl}`);
    return;
  }

  // robots.txt / sitemap.xml — previously these fell through the unknown-path
  // fallback and served homepage HTML. Resolved before everything else so a
  // redirect row or page can never shadow them.
  if (pagePath === '/robots.txt') {
    res.type('text/plain').send(await buildRobotsTxt(project));
    return;
  }
  if (pagePath === '/sitemap.xml') {
    res.type('application/xml').send(await buildSitemapXml(project));
    return;
  }

  // Gate: render only if published pages exist. Project status is not checked —
  // generation is tracked at the page level via generation_status.
  const hasPages = await hasPublishedPages(project.id);
  if (!hasPages) {
    res.type('html').send(siteNotReadyPage(businessName));
    return;
  }

  // Check for redirects before page lookup
  const redirect = await resolveRedirectForProject(project.id, pagePath);
  if (redirect) {
    res.redirect(redirect.type, redirect.to_path);
    return;
  }

  // Get the page content
  const page = await getPageToRender(project.id, pagePath);

  // Artifact page: serve the React app with header/footer/SEO injection
  if (page && page.page_type === 'artifact') {
    const html = await assembleArtifactHtml(project, page, servingHost);
    res.type('html').send(html);
    return;
  }

  if (!page) {
    // Try artifact asset sub-request (e.g., /calculator/assets/index-abc.js)
    const artifactMatch = await getArtifactPageByPrefix(project.id, pagePath);
    if (artifactMatch && artifactMatch.page.artifact_s3_prefix) {
      const asset = await fetchArtifactAsset(
        artifactMatch.page.artifact_s3_prefix,
        artifactMatch.subPath
      );
      if (asset) {
        res
          .type(asset.contentType)
          .set('Cache-Control', 'public, max-age=31536000, immutable')
          .send(asset.buffer);
        return;
      }
    }

    // Try single post routing for 2-segment paths: /{type-slug}/{post-slug}
    const segments = pagePath.split('/').filter(Boolean);
    if (segments.length === 2 && project.template_id) {
      const singlePost = await getSinglePostData(
        project.id,
        project.template_id,
        segments[0],
        segments[1]
      );
      if (singlePost) {
        const html = await assembleSinglePostHtml(project, singlePost.postType, singlePost.post, servingHost);
        res.type('html').send(html);
        return;
      }
    }

    // Serve fallback success page if no DB page exists for /success
    if (pagePath === '/success') {
      res.type('html').send(successPage(businessName, project.primary_color ?? undefined));
      return;
    }

    // Unknown path → real 404. The old behavior rendered the HOMEPAGE with
    // HTTP 200 here (soft-404), which kept dead URLs alive in Google's index,
    // hid broken links from Search Console, and masked every legacy-URL
    // migration gap. Redirect rows (resolved above) remain the correct way
    // to keep old URLs working.
    res.status(404).type('html').send(pageNotFoundPage(businessName));
    return;
  }

  const html = await assembleHtml(project, page, servingHost);
  res.type('html').send(html);
}
