/**
 * Single post layouts — which sections a single post page renders
 * (getAlloro/alloro plans/10162026-single-post-layouts, Slice 2).
 *
 * One order, the same one Alloro applies (src/controllers/admin-websites/feature-utils/util.single-post-layout.ts):
 *   1. the site's pick (projects.single_layouts[postTypeSlug]), when that layout exists in the site's
 *      template family for the post type and has sections;
 *   2. else the post type's single template (the Default);
 *   3. else the renderer's built-in layout.
 * Anything unreadable falls through, so a layout can never break a page.
 *
 * Both repos test the same cases (tests/fixtures/single-post-layout-pick-order.json here,
 * src/__tests__/fixtures/ there), so the two orders cannot drift apart.
 */

export interface SingleSection {
  name: string;
  content: string;
}

export type SingleSource = 'layout' | 'default' | 'builtin';

/** Reserved for the post type's own single template; picking it means "Default". */
const DEFAULT_LAYOUT_SLUG = 'default';

/** A layout slug: lower-case words joined by single hyphens (the table's CHECK). */
const LAYOUT_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The section name used when a stored section has none. */
const DEFAULT_SECTION_NAME = 'single-post';

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isLayoutSlug(value: unknown): value is string {
  return typeof value === 'string' && value !== DEFAULT_LAYOUT_SLUG && LAYOUT_SLUG_PATTERN.test(value);
}

/** The layout slug a site picked for a post type, or null for Default. Anything unreadable is Default. */
export function readLayoutChoice(stored: unknown, postTypeSlug: string): string | null {
  const picks = parseJson(stored);
  if (!picks || typeof picks !== 'object' || Array.isArray(picks)) return null;
  const slug = (picks as Record<string, unknown>)[postTypeSlug];
  return isLayoutSlug(slug) ? slug : null;
}

/** Sections in the stored shape, or null when there is nothing to render. */
export function usableSections(raw: unknown): SingleSection[] | null {
  const value = parseJson(raw);
  if (!Array.isArray(value)) return null;
  const sections = value
    .filter((section): section is SingleSection => !!section && typeof section === 'object' && typeof (section as SingleSection).content === 'string')
    .map((section) => ({ name: typeof section.name === 'string' ? section.name : DEFAULT_SECTION_NAME, content: section.content }));
  return sections.length > 0 ? sections : null;
}

/** Steps 1 to 3 of the order above. `builtin` leaves `sections` null (the caller fills it). */
export function pickSingleSections(
  layoutSections: unknown,
  defaultSections: unknown,
): { source: SingleSource; sections: SingleSection[] | null } {
  const layout = usableSections(layoutSections);
  if (layout) return { source: 'layout', sections: layout };
  const fallback = usableSections(defaultSections);
  if (fallback) return { source: 'default', sections: fallback };
  return { source: 'builtin', sections: null };
}
