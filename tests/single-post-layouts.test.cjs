// A site's picked page layout renders its single posts (getAlloro/alloro plans/10162026-single-post-layouts, Slice 2).
// The pick-order cases are shared with getAlloro/alloro (src/__tests__/fixtures/single-post-layout-pick-order.json);
// the copy in tests/fixtures/ must stay identical.
const assert = require('node:assert/strict');
const { after, beforeEach, test } = require('node:test');
const { readLayoutChoice, pickSingleSections } = require('../dist/utils/singlePostLayout');
const { getPickedLayoutSections } = require('../dist/services/singlepost.service');
const { GenerationRenderModel } = require('../dist/models/GenerationRenderModel');
const database = require('../dist/lib/db');
const redis = require('../dist/lib/redis');
const site = require('../dist/routes/site');
const { cases } = require('./fixtures/single-post-layout-pick-order.json');

const original = { db: database.getDb, redis: redis.getRedis, runs: GenerationRenderModel.publishedRunIds };
after(() => {
  database.getDb = original.db;
  redis.getRedis = original.redis;
  GenerationRenderModel.publishedRunIds = original.runs;
});

/** A query stub: `layoutRow` answers the single_post_layouts lookup, every other table is empty. */
let calls;
let layoutRow;
let layoutError;
function stubDb() {
  return (table) => {
    const call = { table, where: [], whereRaw: [] };
    calls.push(call);
    const chain = {
      where: (...args) => { call.where.push(args); return chain; },
      whereRaw: (...args) => { call.whereRaw.push(args); return chain; },
      whereIn: () => chain, whereNull: () => chain, whereNotNull: () => chain, orderBy: () => chain,
      join: () => chain, leftJoin: () => chain, select: () => chain, limit: () => chain, offset: () => chain,
      first: async () => {
        if (table.startsWith('single_post_layouts')) {
          if (layoutError) throw layoutError;
          return layoutRow;
        }
        return undefined;
      },
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    return chain;
  };
}
beforeEach(() => {
  calls = [];
  layoutRow = undefined;
  layoutError = null;
  database.getDb = stubDb;
  redis.getRedis = () => ({ get: async () => null, set: async () => undefined, del: async () => undefined });
  GenerationRenderModel.publishedRunIds = async () => [];
});

for (const c of cases) {
  test(`pick order: ${c.name}`, () => {
    const choice = readLayoutChoice(c.picks, c.postType);
    assert.equal(choice, c.expect.choice);
    const layoutSections = choice !== null && c.layouts ? c.layouts[choice] : undefined;
    const result = pickSingleSections(layoutSections, c.defaultSections);
    assert.equal(result.source, c.expect.source);
    if (c.expect.sections) assert.deepEqual(result.sections, c.expect.sections);
    if (c.expect.source === 'builtin') assert.equal(result.sections, null);
  });
}

const project = {
  id: 'project-1', organization_id: 12, template_id: 'template-1',
  wrapper: '<html><head></head><body>{{slot}}</body></html>', header: '', footer: '',
};
const postType = { id: 'type-articles', slug: 'articles', name: 'Articles',
  single_template: [{ name: 'single-post', content: '<article>DEFAULT {{post.title}}</article>' }] };
const post = { id: 'post-1', title: 'Real title', slug: 'real', content: '<p>Body</p>', excerpt: null,
  featured_image: null, custom_fields: {}, seo_data: null, categories: '', tags: '', published_at: null };

test('no pick reads no layout and keeps Default', async () => {
  assert.equal(await getPickedLayoutSections({ ...project, single_layouts: {} }, 'articles'), null);
  assert.equal(calls.length, 0);
});

test('a pick looks the layout up in the site template family, by post type and slug', async () => {
  layoutRow = { sections: [{ name: 'editorial', content: '<section>PICKED</section>' }] };
  const sections = await getPickedLayoutSections({ ...project, single_layouts: { articles: 'editorial' } }, 'articles');
  assert.deepEqual(sections, layoutRow.sections);
  const lookup = calls.find((call) => call.table.startsWith('single_post_layouts'));
  assert.ok(lookup);
  assert.deepEqual(lookup.whereRaw[0][1], ['template-1']);
  assert.match(lookup.whereRaw[0][0], /coalesce\(nullif\(template\.slug, ''\), template\.id::text\)/);
  assert.deepEqual(lookup.where, [['layout.post_type_slug', 'articles'], ['layout.slug', 'editorial']]);
});

test('a failing lookup means Default instead of an error', async () => {
  layoutError = new Error('relation "single_post_layouts" does not exist');
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await getPickedLayoutSections({ ...project, single_layouts: { articles: 'editorial' } }, 'articles'), null);
  } finally {
    console.warn = warn;
  }
});

test('a single post page renders the picked layout', async () => {
  layoutRow = { sections: [{ name: 'editorial', content: '<section>PICKED {{post.title}}</section>' }] };
  const html = await site.assembleSinglePostHtml({ ...project, single_layouts: { articles: 'editorial' } }, postType, post, 'example.org');
  assert.ok(html.includes('PICKED Real title'), html);
  assert.ok(!html.includes('DEFAULT'));
});

test('a single post page keeps Default when the picked layout is gone', async () => {
  layoutRow = undefined;
  const html = await site.assembleSinglePostHtml({ ...project, single_layouts: { articles: 'gone' } }, postType, post, 'example.org');
  assert.ok(html.includes('DEFAULT Real title'), html);
});
