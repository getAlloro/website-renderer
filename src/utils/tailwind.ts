/* eslint-disable @typescript-eslint/no-var-requires */
const { compile: twCompile, optimize: twOptimize } = require('@tailwindcss/node') as {
  compile: (css: string, opts: { base: string; onDependency: (p: string) => void }) => Promise<{ build: (candidates: string[]) => string }>;
  optimize: (css: string, opts: { minify: boolean }) => { code: string };
};

import { createHash } from 'crypto';
import path from 'path';
import { getRedis } from '../lib/redis';
import { inspectGenerationStyle } from './generation-style';

const CACHE_TTL = 60 * 60 * 24; // 24 hours
const CACHE_PREFIX = 'tw:';

// Tailwind browser script patterns to strip:
// - cdn.tailwindcss.com (Play CDN v3)
// - @tailwindcss/browser (v4 browser build via jsdelivr/unpkg/etc.)
const TW_CDN_SCRIPT_RE =
  /<script[^>]*src=["'][^"']*(?:cdn\.tailwindcss\.com|@tailwindcss\/browser)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi;
const TW_CDN_INLINE_RE =
  /<script[^>]*>[\s\S]*?(?:cdn\.tailwindcss\.com|@tailwindcss\/browser)[\s\S]*?<\/script>/gi;

// Candidate extraction: class="..." and className="..."
const CLASS_ATTR_RE = /(?:class|className)\s*=\s*["']([^"']+)["']/gi;

/**
 * Singleton: the compiled Tailwind stylesheet, initialized once on first use.
 * `build(candidates)` is cheap (~3ms) — the expensive `compile()` (~10ms) runs once.
 */
let compilerPromise: ReturnType<typeof twCompile> | null = null;

function getCompiler(): ReturnType<typeof twCompile> {
  if (!compilerPromise) {
    compilerPromise = twCompile('@import "tailwindcss";', {
      base: path.dirname(require.resolve('tailwindcss/package.json')),
      onDependency: () => {},
    });
  }
  return compilerPromise;
}

/**
 * Extract all potential Tailwind candidate strings from HTML.
 * Pulls values from class="..." attributes and splits on whitespace.
 */
function extractCandidates(html: string): string[] {
  const candidates = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = CLASS_ATTR_RE.exec(html)) !== null) {
    const classStr = match[1];
    for (const cls of classStr.split(/\s+/)) {
      const trimmed = cls.trim();
      if (trimmed) candidates.add(trimmed);
    }
  }

  // Reset lastIndex for the global regex
  CLASS_ATTR_RE.lastIndex = 0;

  return Array.from(candidates);
}

/**
 * Hash a string with MD5 for cache keying.
 */
function hashCandidates(candidates: string[]): string {
  return createHash('md5').update(candidates.sort().join(',')).digest('hex');
}

/**
 * Strip any Tailwind Play CDN <script> tags from HTML.
 */
// Cloudflare email-decode artifact baked by N8N headless rendering
const CF_EMAIL_DECODE_RE =
  /<script[^>]*src=["'][^"']*cloudflare-static\/email-decode[^"']*["'][^>]*>[\s\S]*?<\/script>/gi;

export function stripPlayCDN(html: string): string {
  return html
    .replace(TW_CDN_SCRIPT_RE, '')
    .replace(TW_CDN_INLINE_RE, '')
    .replace(CF_EMAIL_DECODE_RE, '');
}

/**
 * Inject the Play CDN <script> before </head> (used for draft previews).
 */
export function injectPlayCDN(html: string): string {
  const tag = '<script src="https://cdn.tailwindcss.com"></script>';
  return html.replace(/<\/head>/i, `${tag}\n</head>`);
}

/**
 * Compile Tailwind CSS for the given HTML and return minified CSS string.
 */
async function compileCss(candidates: string[]): Promise<string> {
  const compiler = await getCompiler();
  const css = compiler.build(candidates);
  const { code } = twOptimize(css, { minify: true });
  return code;
}

/**
 * Get compiled CSS from Redis cache, or compile and cache on miss.
 */
async function getCachedOrCompile(candidates: string[]): Promise<string> {
  const hash = hashCandidates(candidates);
  const cacheKey = `${CACHE_PREFIX}${hash}`;

  try {
    const redis = getRedis();
    const cached = await redis.get(cacheKey);
    if (cached) return cached;
  } catch {
    // Redis unavailable — compile without caching
  }

  const css = await compileCss(candidates);

  try {
    const redis = getRedis();
    await redis.set(cacheKey, css, 'EX', CACHE_TTL);
  } catch {
    // Cache write failure is non-fatal
  }

  return css;
}

/**
 * Compile Tailwind CSS from header/footer HTML only.
 * Used by artifact pages to style injected site chrome without
 * running preflight resets that would clobber the React app's CSS.
 *
 * Strips Tailwind's preflight/base layer from the output so only
 * utility classes are injected — the React app owns its own resets.
 */
export async function compileHeaderFooterTailwind(headerFooterHtml: string): Promise<string> {
  const candidates = extractCandidates(headerFooterHtml);
  if (candidates.length === 0) return '';
  const css = await getCachedOrCompile(candidates);

  // Strip preflight: remove everything between the first { and the start
  // of utility classes. Preflight is in @layer base which comes first.
  // Simpler approach: just strip common reset selectors that break React apps.
  // The compiled CSS has no @layer wrappers after optimization, so we strip
  // the leading block of universal/element selectors.
  return css
    .replace(/\*\s*,\s*::before\s*,\s*::after\s*\{[^}]*\}/g, '')
    .replace(/::before\s*,\s*::after\s*\{[^}]*\}/g, '')
    .replace(/html\s*\{[^}]*\}/g, '')
    .replace(/body\s*\{[^}]*\}/g, '')
    .replace(/hr\s*\{[^}]*\}/g, '')
    .replace(/h[1-6]\s*\{[^}]*\}/g, '')
    .replace(/a\s*\{[^}]*\}/g, '')
    .replace(/b\s*,\s*strong\s*\{[^}]*\}/g, '')
    .replace(/small\s*\{[^}]*\}/g, '')
    .replace(/code\s*,\s*kbd\s*,\s*samp\s*,\s*pre\s*\{[^}]*\}/g, '')
    .replace(/table\s*\{[^}]*\}/g, '')
    .replace(/button\s*,\s*input\s*,\s*optgroup\s*,\s*select\s*,\s*textarea\s*\{[^}]*\}/g, '')
    .replace(/:-moz-focusring\s*\{[^}]*\}/g, '')
    .replace(/:-moz-ui-invalid\s*\{[^}]*\}/g, '')
    .replace(/progress\s*\{[^}]*\}/g, '')
    .replace(/::-webkit-inner-spin-button\s*,\s*::-webkit-outer-spin-button\s*\{[^}]*\}/g, '')
    .replace(/::-webkit-search-decoration\s*\{[^}]*\}/g, '')
    .replace(/::-webkit-file-upload-button\s*\{[^}]*\}/g, '')
    .replace(/summary\s*\{[^}]*\}/g, '')
    .replace(/blockquote\s*,\s*dl\s*,\s*dd\s*,\s*h[1-6]\s*,\s*hr\s*,\s*figure\s*,\s*p\s*,\s*pre\s*\{[^}]*\}/g, '')
    .replace(/fieldset\s*\{[^}]*\}/g, '')
    .replace(/legend\s*\{[^}]*\}/g, '')
    .replace(/ol\s*,\s*ul\s*,\s*menu\s*\{[^}]*\}/g, '')
    .replace(/textarea\s*\{[^}]*\}/g, '')
    .replace(/img\s*,\s*svg\s*,\s*video\s*,\s*canvas\s*,\s*audio\s*,\s*iframe\s*,\s*embed\s*,\s*object\s*\{[^}]*\}/g, '')
    .replace(/\[hidden\]\s*\{[^}]*\}/g, '');
}

/**
 * Process Tailwind CSS for assembled HTML.
 *
 * - Published pages: strips Play CDN, compiles + injects lean <style> tag
 * - Draft pages: strips any existing Play CDN, injects fresh Play CDN script
 */
export async function processTailwindCSS(
  html: string,
  isDraft: boolean
): Promise<string> {
  // Always strip any existing Play CDN scripts first
  let result = stripPlayCDN(html);

  const generated = inspectGenerationStyle(result);
  if (generated.present) {
    if (!generated.valid) throw new Error('GENERATION_STYLE_REVISION_INVALID');
    return result;
  }

  if (isDraft) {
    // Draft: inject Play CDN for real-time editing
    return injectPlayCDN(result);
  }

  // Published: compile only the CSS needed
  const candidates = extractCandidates(result);

  if (candidates.length === 0) {
    return result;
  }

  const css = await getCachedOrCompile(candidates);

  // Inject compiled CSS as <style> before </head>
  const styleTag = `<style data-tailwind-compiled>${css}</style>`;
  result = result.replace(/<\/head>/i, `${styleTag}\n</head>`);

  return result;
}
