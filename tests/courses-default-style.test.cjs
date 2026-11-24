const assert = require('node:assert/strict');
const { test } = require('node:test');

// The default look of the member course pieces (getAlloro/alloro plans/11192026-site-courses-library,
// Rev 4): one <style>, added only to a page that carries a courses hook, first in <head> so the
// site's own rules load after it. Pure: nothing here touches a database, Redis or the app.

const { withCoursesDefaultStyle, getCoursesDefaultStyle, COURSES_DEFAULT_STYLE_ATTRIBUTE } = require('../dist/utils/courses-default-style');
const { lessonHookHtml } = require('../dist/services/lesson-hook.service');

const STYLE = getCoursesDefaultStyle();
const LIST_HOOK = '<div data-alloro-courses="list"></div>';

test('a page with a courses hook gets the style right after the opening <head> tag', () => {
  const page = `<html><head lang="en"><link rel="stylesheet" href="/site.css"></head><body>${LIST_HOOK}</body></html>`;
  assert.equal(
    withCoursesDefaultStyle(page),
    `<html><head lang="en">${STYLE}<link rel="stylesheet" href="/site.css"></head><body>${LIST_HOOK}</body></html>`,
    'before the site stylesheet, so a site rule with the same selector wins'
  );
});

test('a lesson page (the hook the renderer appends) gets it too', () => {
  const page = `<head></head><body><main>Lesson${lessonHookHtml('p1')}</main></body>`;
  assert.ok(withCoursesDefaultStyle(page).startsWith(`<head>${STYLE}</head>`));
});

test('a page without a courses hook is unchanged', () => {
  const page = '<html><head></head><body><p>data-alloro-courses is only mentioned here</p></body></html>';
  assert.equal(withCoursesDefaultStyle(page), page);
});

test('a site stylesheet that only mentions the hook attribute does not count as a hook', () => {
  const page = '<head><style>[data-alloro-courses=outline]{padding:1rem}[data-alloro-courses="list"]{gap:1rem}</style></head><body><p>Home</p></body>';
  assert.equal(withCoursesDefaultStyle(page), page);
  const withHook = `<head><style>[data-alloro-courses=outline]{padding:1rem}</style></head><body><div class="x" data-alloro-courses="outline"></div></body>`;
  assert.ok(withCoursesDefaultStyle(withHook).startsWith(`<head>${STYLE}`));
});

test('never added twice', () => {
  const once = withCoursesDefaultStyle(`<head></head><body>${LIST_HOOK}</body>`);
  assert.equal(withCoursesDefaultStyle(once), once);
  assert.equal(once.split(COURSES_DEFAULT_STYLE_ATTRIBUTE).length, 2);
});

test('a <header> is never mistaken for <head>; no head at all puts the style first', () => {
  const page = `<header>Site</header>${LIST_HOOK}`;
  assert.equal(withCoursesDefaultStyle(page), `${STYLE}${page}`);
  assert.equal(withCoursesDefaultStyle(`<HEAD>x</HEAD>${LIST_HOOK}`), `<HEAD>${STYLE}x</HEAD>${LIST_HOOK}`);
});

test('no rule is more specific than two classes, so a site can override any of them', () => {
  const rules = STYLE.replace(/^<style[^>]*>|<\/style>$/g, '').split('}').map((rule) => rule.split('{')[0]).filter(Boolean);
  assert.ok(rules.length > 10);
  for (const selectorList of rules) {
    for (const selector of selectorList.split(',')) {
      const classes = (selector.match(/\.[a-z][a-z0-9-]*/gi) || []).length + (selector.match(/\[[^\]]+\]/g) || []).length;
      assert.ok(classes <= 2, `too specific: ${selector}`);
      assert.ok(!selector.includes('#'), `no ids: ${selector}`);
    }
  }
  const important = STYLE.match(/[^{}]+\{[^{}]*!important[^{}]*\}/g) || [];
  assert.deepEqual(important, ['[data-alloro-courses] .alloro-members-message:empty{display:none!important}'],
    'the only !important hides an empty status line inside a hook (the post body forces <p> to display)');
});
