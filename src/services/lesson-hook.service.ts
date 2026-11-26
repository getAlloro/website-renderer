/**
 * The lesson hook on a members-only post (getAlloro/alloro plans/11192026-site-courses-library, T6).
 *
 * When the post gate lets a signed-in member open a members-only post, and courses are on for the
 * site, the page gets one empty element at the end of the post's content:
 *
 *   <div data-alloro-courses="lesson" data-post-id="{post id}"></div>
 *
 * The members site script (already on the page through the site wrapper while members are on)
 * fills it with the Mark as complete button and the files attached to the post. The element
 * carries no content of its own, so a page whose script does not run shows nothing extra.
 *
 * WHERE IT GOES: appended to the post's own content before the single post template is rendered,
 * so it lands wherever the template prints {{post.content}}, inside the post body. A template that
 * never prints the content gets it before the last </main>, or failing that before </body>.
 *
 * ⛔ Only ever on a response that is already private and no-store (an allowed members-only post).
 * Never on a public post, and never through the shared single post cache.
 *
 * Pure: no database, no Redis, no request.
 */

// Must match SITE_COURSES_HOOK_ATTRIBUTE, SITE_COURSES_HOOKS.lesson and SITE_COURSES_POST_ID_ATTRIBUTE
// in the app's config/siteCourses.ts.
export const HOOK_ATTRIBUTE = 'data-alloro-courses';
const LESSON_HOOK = 'lesson';
const POST_ID_ATTRIBUTE = 'data-post-id';

/** A site with the courses switch on. A row from before the app migration has no flag: off. */
export function isCoursesEnabled(project: { members_enabled?: boolean | null; courses_enabled?: boolean | null }): boolean {
  return project.members_enabled === true && project.courses_enabled === true;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function lessonHookHtml(postId: string): string {
  return `<div ${HOOK_ATTRIBUTE}="${LESSON_HOOK}" ${POST_ID_ATTRIBUTE}="${escapeAttribute(postId)}"></div>`;
}

/** A copy of the post whose content ends with the lesson hook. The post itself is not changed. */
export function withLessonHook<T extends { id: string; content?: string | null }>(post: T): T {
  return { ...post, content: `${post.content || ''}${lessonHookHtml(post.id)}` };
}

/**
 * Make sure the rendered page carries the hook once. When the template printed the content, the
 * page is returned unchanged; otherwise the hook goes before the last </main>, or before </body>,
 * or at the end.
 */
export function ensureLessonHook(html: string, postId: string): string {
  const hook = lessonHookHtml(postId);
  if (html.includes(hook)) return html;
  const lower = html.toLowerCase();
  for (const closing of ['</main>', '</body>']) {
    const at = lower.lastIndexOf(closing);
    if (at !== -1) return `${html.slice(0, at)}${hook}${html.slice(at)}`;
  }
  return `${html}${hook}`;
}
