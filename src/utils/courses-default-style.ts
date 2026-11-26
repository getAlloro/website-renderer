/**
 * The default look of the member course pieces (getAlloro/alloro plans/11192026-site-courses-library, Rev 4).
 *
 * The members site script fills the courses hooks (the course list, one course's lessons, and the
 * Mark as complete button on a lesson) with plain markup and class names. A site whose own stylesheet
 * never mentions those classes showed them unstyled, flush against the page edge. This adds one small
 * <style> to a page that carries a courses hook, so every site gets a readable layout.
 *
 * ⛔ IT GOES FIRST IN <head>, AND NO SELECTOR IS MORE SPECIFIC THAN ONE CLASS PLUS ONE ELEMENT OR TWO
 * CLASSES. So a site that repeats one of these selectors in its own stylesheet wins, because its rule
 * loads later. Plain class selectors still beat element-level resets (Tailwind's preflight sets heading
 * sizes and list styles on the bare elements), which zero-specificity :where() rules would lose to.
 * This is the floor, never the final look.
 *
 * ⛔ NO COLOURS OR FONTS OF ITS OWN. Text, links and buttons inherit the site's; borders are drawn from
 * the current text colour, so the same rules read on a light or a dark site.
 *
 * Analog: utils/review-read-more.ts (a self-contained style added only to pages that need it).
 */

import { HOOK_ATTRIBUTE } from '../services/lesson-hook.service';

/** Marks the injected block, so a page is never given it twice. */
export const COURSES_DEFAULT_STYLE_ATTRIBUTE = 'data-alloro-courses-default';

/**
 * An element that carries a courses hook. A stylesheet or script that only MENTIONS the attribute (a
 * site's own `[data-alloro-courses=outline]` rule) is not a hook, so the text alone never counts.
 */
const HOOK_ELEMENT = new RegExp(`<[a-z][a-z0-9-]*\\s[^<>]*\\b${HOOK_ATTRIBUTE}=`, 'i');

/** The opening <head> tag, never <header>. */
const HEAD_OPEN_TAG = /<head(?:\s[^>]*)?>/i;

const LINE = 'color-mix(in srgb,currentColor 16%,transparent)';
const FALLBACK_LINE = 'rgba(127,127,127,.3)';

const RULES = [
  `.alloro-courses{max-width:46rem;margin:0 auto;padding:clamp(1.75rem,5vw,3.25rem) 1.25rem}`,
  `.alloro-courses h1{margin:0 0 1.25rem}`,
  // ⛔ The one !important: the renderer's post content style forces every <p> in a post body to
  // display:block!important, and the lesson hook sits inside the post body, so an empty status line
  // showed as a blank bar. Hiding an EMPTY status line is never a site's design choice.
  `[${HOOK_ATTRIBUTE}] .alloro-members-message:empty{display:none!important}`,
  `ul.alloro-courses-list{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}`,
  `.alloro-courses-card{padding:1.1rem 1.25rem;border:1px solid ${FALLBACK_LINE};border-color:${LINE};border-radius:10px}`,
  `h3.alloro-courses-title{margin:0 0 .3rem;font-size:1.15rem}`,
  `h2.alloro-courses-title{margin:0 0 .35rem;font-size:1.6rem;line-height:1.2}`,
  `.alloro-courses-back{display:inline-block;margin:0 0 1rem;font-size:.92rem}`,
  `.alloro-courses-back::before{content:"\\2190\\00a0"}`,
  `.alloro-courses-description{margin:0 0 .5rem;opacity:.8}`,
  `.alloro-courses-progress{margin:0;font-size:.9rem;opacity:.7}`,
  `.alloro-courses-lessons{list-style:none;margin:1.25rem 0 0;padding:0;border:1px solid ${FALLBACK_LINE};border-color:${LINE};border-radius:10px;counter-reset:alloro-lesson}`,
  `.alloro-courses-lesson{display:flex;align-items:center;gap:.9rem;padding:.9rem 1.1rem;counter-increment:alloro-lesson}`,
  `.alloro-courses-lesson+.alloro-courses-lesson{border-top:1px solid ${FALLBACK_LINE};border-top-color:${LINE}}`,
  `.alloro-courses-lesson::before{content:counter(alloro-lesson);flex:none;width:1.6rem;height:1.6rem;display:grid;place-items:center;border:1px solid ${FALLBACK_LINE};border-color:${LINE};border-radius:999px;font-size:.8rem;opacity:.75}`,
  `.alloro-courses-lesson-link,.alloro-courses-lesson-title{flex:1}`,
  `.alloro-courses-done,.alloro-courses-lock{flex:none;font-size:.78rem;font-weight:600;padding:.25rem .65rem;border:1px solid ${FALLBACK_LINE};border-color:${LINE};border-radius:999px}`,
  `.alloro-courses-lesson.is-locked{opacity:.55}`,
  `.alloro-courses-hint{margin:.75rem 0 0;font-size:.9rem;opacity:.7}`,
  `.alloro-courses-complete-row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;margin:2rem 0 0}`,
  `.alloro-courses-files{margin:1.5rem 0 0;padding:1rem 1.25rem;border:1px solid ${FALLBACK_LINE};border-color:${LINE};border-radius:10px}`,
  `.alloro-courses-files-heading{margin:0 0 .5rem;font-size:1rem}`,
  `.alloro-courses-files-list{margin:0;padding-left:1.25rem}`,
];

export function getCoursesDefaultStyle(): string {
  return `<style ${COURSES_DEFAULT_STYLE_ATTRIBUTE}>${RULES.join('')}</style>`;
}

/**
 * The page with the default course style added once, when it carries a courses hook. It goes right
 * after the opening <head> tag so the site's own styles load after it, or failing that at the start.
 * Any other page is returned unchanged. Pure: no database, no Redis, no request.
 */
export function withCoursesDefaultStyle(html: string): string {
  if (!HOOK_ELEMENT.test(html) || html.includes(COURSES_DEFAULT_STYLE_ATTRIBUTE)) return html;
  const style = getCoursesDefaultStyle();
  const head = HEAD_OPEN_TAG.exec(html);
  if (!head) return `${style}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${style}${html.slice(at)}`;
}
