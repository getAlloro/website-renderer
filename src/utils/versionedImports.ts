/**
 * Versioned app imports, served from the site origin.
 *
 * A site wrapper can reference stylesheets and scripts that the app publishes as
 * versioned imports (`https://app.getalloro.com/api/imports/<file>/v/<n>`). Served from
 * the app origin, every visitor pays a second TLS connection plus the app server's
 * response time on the render-blocking path (Lighthouse on www.getalloro.com: the
 * stylesheet hop alone cost ~2.1 s of the 5.1 s LCP). The renderer rewrites those
 * references onto its own origin and serves them from a Redis-backed copy
 * (routes/imports.ts) on the connection the browser already has.
 *
 * Only the versioned form is localized. The unversioned form
 * (`/api/imports/alloro-template.js`, loaded by every hosted site) is a moving target the
 * app owns, and it stays on the app origin on purpose.
 */

const FILENAME = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
const VERSION = '[1-9][0-9]{0,8}';
// The reference must end where the URL ends, so /v/8 never matches inside /v/80.
const URL_END = '(?=["\'\\s?#>)])';

/** A site-origin path the renderer serves itself: /api/imports/<file>/v/<n>. */
export const VERSIONED_IMPORT_PATH = new RegExp(`^/api/imports/(${FILENAME})/v/(${VERSION})$`);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite `${apiBaseUrl}/api/imports/<file>/v/<n>` references in page HTML to the
 * same path on the site origin. Everything else, including the unversioned form and
 * any other origin, is left exactly as it was.
 */
export function localizeVersionedImports(html: string, apiBaseUrl: string): string {
  const base = apiBaseUrl.replace(/\/+$/, '');
  if (!base || !html.includes(`${base}/api/imports/`)) return html;
  const absolute = new RegExp(
    `${escapeRegExp(base)}/api/imports/(${FILENAME})/v/(${VERSION})${URL_END}`,
    'g'
  );
  // A function, not a string: a string replacement reads $$, $& and $' as patterns.
  return html.replace(absolute, (_match, file: string, version: string) => `/api/imports/${file}/v/${version}`);
}
