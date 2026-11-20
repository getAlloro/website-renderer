const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { after, before, beforeEach, test } = require('node:test');
const express = require('express');

// Members-only posts, renderer side (getAlloro/alloro plans/11192026-site-courses-library, T3).
// One test per place a post can reach the public: the single post page and its shared
// cache, the public feed, {{ post_block }} lists (and their count), menu auto-fill, the
// sitemap. Plus: a site with no access rows behaves exactly as before.
//
// The database is a recorded stand-in that really applies the filters these paths send
// (project, status, post type, whereIn / whereNotIn), and Redis is an in-memory map that
// records every key read and written. Nothing here connects to a real database or Redis.
const database = require('../dist/lib/db');
const redisLib = require('../dist/lib/redis');
const { GenerationRenderModel } = require('../dist/models/GenerationRenderModel');

const original = { getDb: database.getDb, getRedis: redisLib.getRedis, publishedRunIds: GenerationRenderModel.publishedRunIds };

const TOKEN = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG0';
const HOST = 'demo.sites.test';
const PUBLIC_HOST = 'demo.sites.getalloro.com';
const PROJECT = 'project-g';

// ---------------------------------------------------------------------------
// Recorded database
// ---------------------------------------------------------------------------

let tables = {};
const queried = [];

/** Column names as the stand-in rows carry them: no table prefix, and a post type's slug is `type_slug`. */
function columnOf(table, column) {
  if (/^(post_types|pt)\.slug$/.test(column) && table !== 'post_types') return 'type_slug';
  return column.replace(/^[a-z_]+\./, '');
}

function rowsOf(table) {
  const rows = tables[table] || [];
  if (table === 'posts') {
    const types = new Map((tables.post_types || []).map((type) => [type.id, type.slug]));
    return rows.map((row) => ({ ...row, type_slug: types.get(row.post_type_id), post_type_slug: types.get(row.post_type_id) }));
  }
  if (table === 'site_post_access') {
    // The gate's own query joins the post and its type for the address parts.
    const posts = new Map(rowsOf('posts').map((post) => [post.id, post]));
    return rows
      .filter((row) => posts.has(row.post_id))
      .map((row) => ({ ...row, access_id: row.id, post_slug: posts.get(row.post_id).slug, type_slug: posts.get(row.post_id).type_slug }));
  }
  return rows.map((row) => ({ ...row }));
}

function fakeDb(tableExpression) {
  const table = String(tableExpression).replace(/^website_builder\./, '').replace(/ as \w+$/, '');
  let rows = rowsOf(table);
  let countAs = null;
  let limit = null;
  let offset = 0;

  const equal = (column, value) => {
    const key = columnOf(table, column);
    rows = rows.filter((row) => !(key in row) || row[key] === value);
  };
  const run = () => {
    queried.push(table);
    if (countAs) return [{ [countAs]: String(rows.length) }];
    const sliced = rows.slice(offset);
    return limit === null ? sliced : sliced.slice(0, limit);
  };

  const chain = {
    where: (column, ...rest) => {
      if (column && typeof column === 'object') for (const [key, value] of Object.entries(column)) equal(key, value);
      else if (typeof column === 'string' && rest.length === 1) equal(column, rest[0]);
      // where(fn) and where(column, operator, value) are not needed by these paths' fixtures.
      return chain;
    },
    whereIn: (column, values) => {
      const key = columnOf(table, column);
      rows = rows.filter((row) => !(key in row) || values.includes(row[key]));
      return chain;
    },
    whereNotIn: (column, values) => {
      const key = columnOf(table, column);
      rows = rows.filter((row) => !values.includes(row[key]));
      return chain;
    },
    whereNull: () => chain,
    whereNotNull: (column) => {
      const key = columnOf(table, column);
      rows = rows.filter((row) => row[key] !== null && row[key] !== undefined);
      return chain;
    },
    whereExists: () => chain,
    whereRaw: () => chain,
    join: () => chain,
    leftJoin: () => chain,
    select: () => chain,
    distinct: () => chain,
    orderBy: () => chain,
    orderByRaw: () => chain,
    limit: (value) => { limit = value; return chain; },
    offset: (value) => { offset = value; return chain; },
    count: (expression) => { countAs = String(expression).split(' as ')[1]; return chain; },
    first: async () => run()[0],
    then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
  };
  for (const method of ['insert', 'update', 'del', 'delete', 'truncate']) {
    chain[method] = () => { throw new Error(`The renderer must never ${method} here.`); };
  }
  return chain;
}
fakeDb.raw = (sql) => sql;
fakeDb.fn = { now: () => 'now()' };

// ---------------------------------------------------------------------------
// Recorded Redis
// ---------------------------------------------------------------------------

const store = new Map();
const redisOps = [];
const fakeRedis = {
  get: async (key) => { redisOps.push(['get', key]); return store.has(key) ? store.get(key) : null; },
  set: async (key, value) => { redisOps.push(['set', key]); store.set(key, value); return 'OK'; },
  del: async (key) => { redisOps.push(['del', key]); return store.delete(key) ? 1 : 0; },
  scan: async (_cursor, _match, pattern) => {
    const matcher = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return ['0', [...store.keys()].filter((key) => matcher.test(key))];
  },
};
const keysOf = (op, prefix) => redisOps.filter(([kind, key]) => kind === op && key.startsWith(prefix)).map(([, key]) => key);

database.getDb = () => fakeDb;
redisLib.getRedis = () => fakeRedis;
GenerationRenderModel.publishedRunIds = async () => [];

const access = require('../dist/services/member-access.service');
const { removeGatedPostSitemapEntries, removeGatedSitemapEntries } = require('../dist/services/sitemap.service');
const { extractSubdomain } = require('../dist/middleware/subdomain');
const { apiRouter } = require('../dist/routes/api');
const { siteRoute } = require('../dist/routes/site');

let server;
before(async () => {
  const app = express();
  // The same order as src/index.ts: the JSON feed first, then the site.
  app.use(apiRouter);
  app.use(extractSubdomain);
  app.get('*', (req, res, next) => { siteRoute(req, res).catch(next); });
  app.use((error, _req, res, _next) => { res.status(500).send(`Renderer failure: ${error && error.message}`); });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

after(() => {
  server.close();
  database.getDb = original.getDb;
  redisLib.getRedis = original.getRedis;
  GenerationRenderModel.publishedRunIds = original.publishedRunIds;
});

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'GET', path, headers: { host: HOST, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const MEMBER = { cookie: `alloro_member=${TOKEN}` };

function post(id, slug, marker, overrides = {}) {
  return {
    id, project_id: PROJECT, post_type_id: 'pt-lessons', slug, status: 'published', sort_order: 0,
    title: `${marker}_TITLE`, content: `<p>${marker}_BODY</p>`, excerpt: `${marker}_EXCERPT`, featured_image: null,
    custom_fields: {}, seo_data: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z', published_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

function page(path, content) {
  return {
    id: `page-${path}`, project_id: PROJECT, path, version: 1, status: 'published', generation_status: 'ready',
    page_type: 'sections', artifact_s3_prefix: null, seo_data: null, updated_at: '2026-11-02T00:00:00Z',
    sections: [{ name: 'main', content }],
  };
}

/** Two open lessons and two members-only ones; the second is limited to the group g-adc. */
function site({ membersEnabled = true, gated = true } = {}) {
  return {
    projects: [{
      id: PROJECT, generated_hostname: 'demo', custom_domain: null, custom_domain_alt: null, archived_at: null,
      organization_id: null, template_id: 'tpl-1', members_enabled: membersEnabled, single_layouts: null,
      wrapper: '<html><head><title>T</title></head><body>{{slot}}</body></html>', header: '', footer: '',
    }],
    pages: [
      page('/', `<main>{{ post_block id='lesson-list' items='lessons' }}</main><footer>{{ menu id='main' }}</footer>`),
      page('/paged', `<main>{{ post_block id='lesson-list' items='lessons' paginate='numbered' per_page='1' }}</main>`),
    ],
    post_types: [{ id: 'pt-lessons', template_id: 'tpl-1', slug: 'lessons', name: 'Lessons', single_template: [] }],
    posts: [
      post('p-open-1', 'welcome', 'OPEN_ONE'),
      post('p-open-2', 'basics', 'OPEN_TWO'),
      post('p-gated-1', 'secret-one', 'GATED_ONE'),
      post('p-gated-2', 'secret-two', 'GATED_TWO'),
    ],
    post_blocks: [{
      template_id: 'tpl-1', slug: 'lesson-list', post_type_slug: 'lessons',
      sections: [{ name: 'list', content: '<ul>{{start_post_loop}}<li>{{post.title}} {{post.url}}</li>{{end_post_loop}}</ul>' }],
    }],
    menus: [{ id: 'menu-1', project_id: PROJECT, slug: 'main' }],
    menu_items: [{
      id: 'mi-1', menu_id: 'menu-1', parent_id: null, label: 'Lessons', url: '', target: '_self', order_index: 0,
      item_type: 'post_autofill', autofill_post_type_id: 'pt-lessons', autofill_order: null, autofill_limit: null,
    }],
    header_footer_code: [], website_integrations: [], redirects: [],
    post_category_assignments: [], post_tag_assignments: [],
    site_page_access: [], site_page_access_groups: [],
    site_post_access: gated ? [
      { id: 'pa-1', project_id: PROJECT, post_id: 'p-gated-1' },
      { id: 'pa-2', project_id: PROJECT, post_id: 'p-gated-2' },
    ] : [],
    site_post_access_groups: gated ? [{ post_access_id: 'pa-2', project_id: PROJECT, group_id: 'g-adc' }] : [],
    site_member_sessions: [],
  };
}

beforeEach(() => {
  tables = site();
  queried.length = 0;
  redisOps.length = 0;
  store.clear();
  access.resetMemberAccessMemo();
});

function assertNoGatedPost(text, where) {
  for (const marker of ['GATED_ONE', 'GATED_TWO', 'secret-one', 'secret-two', 'p-gated-1', 'p-gated-2']) {
    assert.equal(text.includes(marker), false, `${where} must not carry ${marker}`);
  }
}

// ---------------------------------------------------------------------------
// The pure pieces
// ---------------------------------------------------------------------------

test('pure: a list keeps its identity with no members-only posts, and loses exactly those posts otherwise', () => {
  const posts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(access.excludeGatedPosts(posts, []), posts, 'the same array, untouched');
  assert.deepEqual(access.excludeGatedPosts(posts, ['b', 'zzz']), [{ id: 'a' }, { id: 'c' }]);
  assert.deepEqual(access.excludeGatedPosts(posts, ['a', 'b', 'c']), []);
});

test('pure: the cache tag is empty with no members-only posts and names the set otherwise', () => {
  assert.equal(access.postGateCacheTag([]), '');
  const tag = access.postGateCacheTag(['b', 'a']);
  assert.match(tag, /^:g[0-9a-f]{12}$/);
  assert.equal(access.postGateCacheTag(['a', 'b', 'a']), tag, 'order and duplicates do not matter');
  assert.notEqual(access.postGateCacheTag(['a']), tag, 'a different set is a different key');
  assert.notEqual(access.postGateCacheTag(['a', 'b', 'c']), tag);
});

test('pure: a post address matches exactly on both parts', () => {
  const gated = [{ accessId: 'x', postId: 'p1', typeSlug: 'lessons', postSlug: 'intro' }];
  assert.equal(access.findGatedPost(gated, 'lessons', 'intro').postId, 'p1');
  for (const [type, slug] of [['lessons', 'intro-2'], ['lessons', 'Intro'], ['articles', 'intro'], ['lessons', ''], ['', 'intro']]) {
    assert.equal(access.findGatedPost(gated, type, slug), null, `${type}/${slug}`);
  }
  assert.equal(access.gatedPostPath(gated[0]), '/lessons/intro');
});

test('pure: the sitemap drops a members-only post exactly, never a longer or sibling address', () => {
  const entry = (path) => `  <url>\n    <loc>https://${PUBLIC_HOST}${path}</loc>\n    <lastmod>2026-11-02</lastmod>\n  </url>\n`;
  const xml = `<urlset>\n${entry('/')}${entry('/lessons/intro')}${entry('/lessons/intro-2')}${entry('/lessons/intro/more')}</urlset>\n`;
  assert.equal(removeGatedPostSitemapEntries(xml, PUBLIC_HOST, []), xml, 'no members-only posts: the same string');
  const filtered = removeGatedPostSitemapEntries(xml, PUBLIC_HOST, ['/lessons/intro']);
  assert.equal(filtered, `<urlset>\n${entry('/')}${entry('/lessons/intro-2')}${entry('/lessons/intro/more')}</urlset>\n`);
  // The path filter (members-only pages) is unchanged: it still works as a prefix.
  assert.equal(removeGatedSitemapEntries(xml, PUBLIC_HOST, ['/lessons/intro']), `<urlset>\n${entry('/')}${entry('/lessons/intro-2')}</urlset>\n`);
});

// ---------------------------------------------------------------------------
// The gate function
// ---------------------------------------------------------------------------

function tokenReader(token) {
  const reader = () => { reader.reads += 1; return token; };
  reader.reads = 0;
  return reader;
}

test('gate: open post does no cookie work; members-only post asks for a session, then the group', async () => {
  const project = { id: PROJECT, members_enabled: true };

  const open = tokenReader(TOKEN);
  const openResult = await access.resolvePostGate(project, 'lessons', 'welcome', open);
  assert.equal(openResult.decision, 'open');
  assert.equal(openResult.access, null);
  assert.deepEqual(openResult.gatedPostIds, ['p-gated-1', 'p-gated-2']);
  assert.equal(open.reads, 0);
  assert.deepEqual(queried, ['site_post_access'], 'one query for the whole site, nothing else');

  queried.length = 0;
  assert.equal((await access.resolvePostGate(project, 'lessons', 'secret-one', tokenReader(null))).decision, 'sign-in');
  assert.equal(queried.includes('site_member_sessions'), false, 'no cookie, no session query');

  // Every active member opens a members-only post that lists no groups.
  tables.site_member_sessions = [{ member_id: 'm1', group_id: null }];
  const allowed = await access.resolvePostGate(project, 'lessons', 'secret-one', tokenReader(TOKEN));
  assert.deepEqual({ decision: allowed.decision, access: allowed.access }, { decision: 'allow', access: { postId: 'p-gated-1', groupIds: [] } });

  // A post limited to a group: outside it is forbidden, inside it is allowed.
  assert.equal((await access.resolvePostGate(project, 'lessons', 'secret-two', tokenReader(TOKEN))).decision, 'forbidden');
  tables.site_member_sessions = [{ member_id: 'm1', group_id: 'g-other' }, { member_id: 'm1', group_id: 'g-adc' }];
  const inGroup = await access.resolvePostGate(project, 'lessons', 'secret-two', tokenReader(TOKEN));
  assert.deepEqual(inGroup.access, { postId: 'p-gated-2', groupIds: ['g-adc'] });
  assert.equal(inGroup.decision, 'allow');

  // A session that matches no live member: sign-in again.
  tables.site_member_sessions = [];
  assert.equal((await access.resolvePostGate(project, 'lessons', 'secret-two', tokenReader(TOKEN))).decision, 'sign-in');
});

test('gate, members switch off: a members-only post fails closed (not-found) with no cookie read', async () => {
  const reader = tokenReader(TOKEN);
  const result = await access.resolvePostGate({ id: PROJECT, members_enabled: false }, 'lessons', 'secret-one', reader);
  assert.equal(result.decision, 'not-found');
  assert.equal(reader.reads, 0);
  assert.equal(queried.includes('site_member_sessions'), false);
  assert.deepEqual(await access.listGatedPostIds({ id: PROJECT, members_enabled: false }), ['p-gated-1', 'p-gated-2'], 'lists still leave it out');
  assert.equal((await access.resolvePostGate({ id: PROJECT }, 'lessons', 'welcome', reader)).decision, 'open');
});

test('gate, no access rows + switch off: one probe a minute, then no query at all', async () => {
  tables = site({ membersEnabled: false, gated: false });
  const project = { id: PROJECT, members_enabled: false };
  assert.deepEqual(await access.listGatedPostIds(project), []);
  assert.deepEqual(queried, ['site_post_access']);
  queried.length = 0;
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(await access.listGatedPosts(project), []);
    assert.equal((await access.resolvePostGate(project, 'lessons', 'welcome', tokenReader(TOKEN))).decision, 'open');
  }
  assert.deepEqual(queried, [], 'nothing while the 60-second memo holds');

  const now = 5_000_000;
  assert.equal(await access.hasAnyPostAccess('other-site', now), false);
  tables.site_post_access = [{ id: 'x', project_id: 'other-site', post_id: 'p-open-1' }];
  assert.equal(await access.hasAnyPostAccess('other-site', now + 59_999), false);
  assert.equal(await access.hasAnyPostAccess('other-site', now + 60_000), true);
});

test('gate: tables not deployed yet (42P01) means nothing is members-only, not a failure', async () => {
  const savedDb = database.getDb;
  database.getDb = () => () => {
    const chain = { join: () => chain, where: () => chain, select: () => chain, first: async () => { throw Object.assign(new Error('missing'), { code: '42P01' }); },
      then: (_resolve, reject) => reject(Object.assign(new Error('missing'), { code: '42P01' })) };
    return chain;
  };
  try {
    assert.deepEqual(await access.listGatedPostIds({ id: PROJECT, members_enabled: true }), []);
    assert.equal((await access.resolvePostGate({ id: PROJECT, members_enabled: true }, 'lessons', 'secret-one', tokenReader(null))).decision, 'open');
    // Any other database failure is NOT swallowed: the request fails rather than opening a post.
    database.getDb = () => () => {
      const chain = { join: () => chain, where: () => chain, select: () => chain, then: (_resolve, reject) => reject(new Error('connection lost')) };
      return chain;
    };
    await assert.rejects(access.listGatedPostIds({ id: PROJECT, members_enabled: true }), /connection lost/);
  } finally {
    database.getDb = savedDb;
  }
});

// ---------------------------------------------------------------------------
// Leak point 1: the single post page and its shared cache (A1, A2)
// ---------------------------------------------------------------------------

test('single post, signed out: redirect to sign-in, private + no-store + noindex, shared cache untouched', async () => {
  const res = await get('/lessons/secret-one?ref=mail');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/member-login?next=%2Flessons%2Fsecret-one%3Fref%3Dmail');
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
  assert.match(res.headers.vary, /Cookie/);
  assertNoGatedPost(res.text.replace(/secret-one/g, ''), 'the redirect body');
  assert.equal(res.text.includes('GATED_ONE'), false);
  assert.deepEqual(keysOf('get', 'sp:'), [], 'the single post cache is not read for a members-only post');
  assert.deepEqual(keysOf('set', 'sp:'), [], 'and not written');
  assert.equal(queried.includes('posts'), false, 'the post itself is never loaded');
});

test('single post, signed in but outside the group: the other-group page, no post content', async () => {
  tables.site_member_sessions = [{ member_id: 'm1', group_id: 'g-other' }];
  const res = await get('/lessons/secret-two', MEMBER);
  assert.equal(res.status, 403);
  assert.match(res.text, /This page is for another group\./);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
  assertNoGatedPost(res.text, 'the other-group page');
  assert.deepEqual(keysOf('get', 'sp:').concat(keysOf('set', 'sp:')), []);
  assert.equal(queried.includes('posts'), false);
});

test('single post, allowed member: the post renders, private + noindex, never through the shared cache', async () => {
  tables.site_member_sessions = [{ member_id: 'm1', group_id: 'g-adc' }];
  for (const [path, marker] of [['/lessons/secret-one', 'GATED_ONE'], ['/lessons/secret-two', 'GATED_TWO']]) {
    const res = await get(path, MEMBER);
    assert.equal(res.status, 200, path);
    assert.match(res.text, new RegExp(`${marker}_BODY`));
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.match(res.text, /<meta name="robots" content="noindex, nofollow">/);
  }
  assert.deepEqual(keysOf('get', 'sp:').concat(keysOf('set', 'sp:')), [], 'a members-only post is never read from or written to sp:');
  for (const [, value] of store) assert.equal(/GATED_(ONE|TWO)/.test(value), false, 'no shared cache entry holds the post');
});

test('single post: a post that was cached while public is not served once it is members-only', async () => {
  tables.site_post_access = [];
  tables.site_post_access_groups = [];
  const before = await get('/lessons/secret-one');
  assert.equal(before.status, 200);
  assert.match(before.text, /GATED_ONE_BODY/);
  assert.deepEqual(keysOf('set', 'sp:'), [`sp:${PROJECT}:lessons:secret-one`], 'cached while it was public, as today');

  tables.site_post_access = [{ id: 'pa-1', project_id: PROJECT, post_id: 'p-gated-1' }];
  const afterChange = await get('/lessons/secret-one');
  assert.equal(afterChange.status, 302, 'the very next request is gated, with the old entry still in the cache');
  assert.equal(afterChange.text.includes('GATED_ONE'), false);
});

test('single post: a stale cached entry that is a members-only post under another address is a 404, never content', async () => {
  // The cache says /lessons/welcome is post p-gated-1 (its address changed while the entry was live).
  store.set(`sp:${PROJECT}:lessons:welcome`, JSON.stringify({
    postType: { id: 'pt-lessons', slug: 'lessons', name: 'Lessons', single_template: [] },
    post: { ...post('p-gated-1', 'welcome', 'GATED_ONE'), categories: '', tags: '' },
  }));
  const res = await get('/lessons/welcome');
  assert.equal(res.status, 404);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(res.text.includes('GATED_ONE'), false);
});

test('single post, members switch off: a members-only post is a 404 for everyone; a public post still renders', async () => {
  tables.projects[0].members_enabled = false;
  tables.site_member_sessions = [{ member_id: 'm1', group_id: 'g-adc' }];
  const gatedRes = await get('/lessons/secret-one', MEMBER);
  assert.equal(gatedRes.status, 404);
  assert.equal(gatedRes.text.includes('GATED_ONE'), false);
  assert.deepEqual(keysOf('get', 'sp:'), []);
  const openRes = await get('/lessons/welcome');
  assert.equal(openRes.status, 200);
  assert.match(openRes.text, /OPEN_ONE_BODY/);
});

// ---------------------------------------------------------------------------
// Leak point 2: the public feed (A3, A6)
// ---------------------------------------------------------------------------

test('public feed: members-only posts are absent cold and warm, and the count drops by exactly their number', async () => {
  const cold = await get('/api/posts/demo/lessons');
  assert.equal(cold.status, 200);
  assert.deepEqual(cold.json.posts.map((item) => item.slug), ['welcome', 'basics']);
  assert.equal(cold.json.total, 2, '4 published posts, 2 of them members-only');
  assertNoGatedPost(cold.text, 'the cold feed');

  const written = keysOf('set', 'api:posts:');
  assert.equal(written.length, 1);
  assert.match(written[0], new RegExp(`^api:posts:${PROJECT}:lessons:[0-9a-f]{12}:g[0-9a-f]{12}$`));
  assertNoGatedPost(store.get(written[0]), 'the shared feed cache');

  queried.length = 0;
  const warm = await get('/api/posts/demo/lessons');
  assert.deepEqual(warm.json, cold.json);
  assert.equal(queried.includes('posts'), false, 'served from the cache');
  assertNoGatedPost(warm.text, 'the warm feed');

  // Asking for a members-only post by slug, or signed in as a member, changes nothing.
  tables.site_member_sessions = [{ member_id: 'm1', group_id: 'g-adc' }];
  const byId = await get('/api/posts/demo/lessons?ids=secret-one,welcome', MEMBER);
  assert.deepEqual(byId.json.posts.map((item) => item.slug), ['welcome']);
  assert.equal(byId.json.total, 1);
});

test('public feed: an access change applies on the next request, with the old entry still cached', async () => {
  tables.site_post_access = [];
  tables.site_post_access_groups = [];
  const allPublic = await get('/api/posts/demo/lessons');
  assert.equal(allPublic.json.total, 4);
  assert.match(keysOf('set', 'api:posts:')[0], new RegExp(`^api:posts:${PROJECT}:lessons:[0-9a-f]{12}$`), 'no members-only posts: the key is what it always was');

  tables.site_post_access = [{ id: 'pa-1', project_id: PROJECT, post_id: 'p-gated-1' }];
  const afterGate = await get('/api/posts/demo/lessons');
  assert.equal(afterGate.json.total, 3);
  assert.equal(afterGate.text.includes('GATED_ONE'), false, 'gone at once, no flush and no cache lifetime');

  tables.site_post_access = [];
  assert.equal((await get('/api/posts/demo/lessons')).json.total, 4, 'and back at once when it is public again');
});

// ---------------------------------------------------------------------------
// Leak point 3: {{ post_block }} lists and their count (A4, A6)
// ---------------------------------------------------------------------------

test('post list on a public page: members-only posts are not in the HTML, cold, warm, or for a signed-in member', async () => {
  const cold = await get('/');
  assert.equal(cold.status, 200);
  assert.match(cold.text, /OPEN_ONE_TITLE \/lessons\/welcome/);
  assert.match(cold.text, /OPEN_TWO_TITLE \/lessons\/basics/);
  assertNoGatedPost(cold.text, 'the page');

  const written = keysOf('set', 'posts:');
  assert.equal(written.length, 1);
  assert.match(written[0], new RegExp(`^posts:${PROJECT}:lessons:[0-9a-f]{12}:g[0-9a-f]{12}$`));
  assertNoGatedPost(store.get(written[0]), 'the shared list cache');

  const warm = await get('/');
  assertNoGatedPost(warm.text, 'the warm page');
  tables.site_member_sessions = [{ member_id: 'm1', group_id: 'g-adc' }];
  assertNoGatedPost((await get('/', MEMBER)).text, 'the page for a signed-in member');
});

test('post list: the paginated count leaves members-only posts out too', async () => {
  const res = await get('/paged');
  assert.equal(res.status, 200);
  assert.match(res.text, /data-total-posts="2"/);
  assert.match(res.text, /data-total-pages="2"/);
  assertNoGatedPost(res.text, 'the paginated page');
  assert.match(keysOf('set', 'posts-count:')[0], /:g[0-9a-f]{12}$/);
});

test('post list: an access change applies on the next request', async () => {
  tables.site_post_access = [];
  tables.site_post_access_groups = [];
  assert.match((await get('/')).text, /GATED_ONE_TITLE/);
  tables.site_post_access = [{ id: 'pa-1', project_id: PROJECT, post_id: 'p-gated-1' }];
  const afterGate = await get('/');
  assert.equal(afterGate.text.includes('GATED_ONE'), false);
  assert.match(afterGate.text, /GATED_TWO_TITLE/, 'only the post that changed is hidden');
});

// ---------------------------------------------------------------------------
// Leak point 4: menu auto-fill (A5)
// ---------------------------------------------------------------------------

test('auto-filled menu: no members-only post in the nav or in its shared cache', async () => {
  const res = await get('/');
  assert.match(res.text, /href="\/lessons\/welcome"/);
  assert.match(res.text, /href="\/lessons\/basics"/);
  assert.equal(/href="\/lessons\/secret-(one|two)"/.test(res.text), false);

  const written = keysOf('set', 'menuposts:');
  assert.equal(written.length, 1);
  assert.match(written[0], new RegExp(`^menuposts:${PROJECT}:pt-lessons:g[0-9a-f]{12}$`));
  assertNoGatedPost(store.get(written[0]), 'the shared menu cache');
});

test('auto-filled menu: a cached list that still holds a members-only post is filtered on the way out', async () => {
  const { expandAutofillItems } = require('../dist/services/menu-autofill.service');
  const project = { id: PROJECT, members_enabled: true };
  const key = `menuposts:${PROJECT}:pt-lessons${access.postGateCacheTag(['p-gated-1', 'p-gated-2'])}`;
  store.set(key, JSON.stringify(tables.posts.map((row) => ({ ...row, post_type_slug: 'lessons', ordered_at: row.published_at }))));
  const items = await expandAutofillItems(project, tables.menu_items);
  assert.deepEqual(items.map((item) => item.url).sort(), ['/lessons/basics', '/lessons/welcome']);
});

// ---------------------------------------------------------------------------
// Leak point 5: the sitemap (A5, A6)
// ---------------------------------------------------------------------------

test('sitemap: no members-only post address, cold, warm, or from a sitemap cached before the post was gated', async () => {
  const cold = await get('/sitemap.xml');
  assert.equal(cold.status, 200);
  assert.match(cold.text, new RegExp(`<loc>https://${PUBLIC_HOST}/lessons/welcome</loc>`));
  assert.match(cold.text, new RegExp(`<loc>https://${PUBLIC_HOST}/lessons/basics</loc>`));
  assertNoGatedPost(cold.text, 'the sitemap');
  assert.deepEqual(keysOf('set', 'sitemap:'), [`sitemap:${PROJECT}`], 'the key the app clears is unchanged');
  assertNoGatedPost(store.get(`sitemap:${PROJECT}`), 'the shared sitemap cache');
  assertNoGatedPost((await get('/sitemap.xml')).text, 'the warm sitemap');

  // A sitemap cached while every post was public, then one post is gated: gone on the next request.
  store.clear();
  tables.site_post_access = [];
  tables.site_post_access_groups = [];
  assert.match((await get('/sitemap.xml')).text, /\/lessons\/secret-one<\/loc>/);
  tables.site_post_access = [{ id: 'pa-1', project_id: PROJECT, post_id: 'p-gated-1' }];
  const afterGate = await get('/sitemap.xml');
  assert.equal(afterGate.text.includes('secret-one'), false);
  assert.match(afterGate.text, /\/lessons\/secret-two<\/loc>/);
});

// ---------------------------------------------------------------------------
// Members switch off: lists still leave members-only posts out (fail closed)
// ---------------------------------------------------------------------------

test('members switch off with access rows: feed, list, menu and sitemap still leave the posts out', async () => {
  tables.projects[0].members_enabled = false;
  const feed = await get('/api/posts/demo/lessons');
  assert.equal(feed.json.total, 2);
  assertNoGatedPost(feed.text, 'the feed');
  assertNoGatedPost((await get('/')).text, 'the page and its menu');
  assertNoGatedPost((await get('/sitemap.xml')).text, 'the sitemap');
});

// ---------------------------------------------------------------------------
// Blast radius: a site with NO access rows is exactly as before
// ---------------------------------------------------------------------------

for (const membersEnabled of [false, true]) {
  test(`no access rows (members switch ${membersEnabled ? 'on' : 'off'}): every post shows and every cache key is the old one`, async () => {
    tables = site({ membersEnabled, gated: false });

    const feed = await get('/api/posts/demo/lessons');
    assert.equal(feed.json.total, 4);
    assert.deepEqual(feed.json.posts.map((item) => item.slug), ['welcome', 'basics', 'secret-one', 'secret-two']);
    assert.deepEqual(Object.keys(feed.json).sort(), ['page', 'per_page', 'posts', 'total', 'total_pages']);
    assert.equal(feed.headers['cache-control'], undefined, 'the feed carries no new header');

    const home = await get('/');
    for (const slug of ['welcome', 'basics', 'secret-one', 'secret-two']) {
      assert.match(home.text, new RegExp(`_TITLE /lessons/${slug}</li>`), `list: ${slug}`);
      assert.match(home.text, new RegExp(`href="/lessons/${slug}"`), `menu: ${slug}`);
    }
    assert.match((await get('/paged')).text, /data-total-posts="4"/);

    const sitemap = await get('/sitemap.xml');
    for (const slug of ['welcome', 'basics', 'secret-one', 'secret-two']) assert.match(sitemap.text, new RegExp(`/lessons/${slug}</loc>`));

    const single = await get('/lessons/secret-one');
    assert.equal(single.status, 200);
    assert.match(single.text, /GATED_ONE_BODY/);
    assert.equal(single.headers['cache-control'], undefined, 'a public post is not marked private');
    assert.equal(single.headers['x-robots-tag'], undefined);
    assert.equal(/noindex/.test(single.text), false);

    // Every shared key is byte-for-byte the old shape: no members-only suffix anywhere.
    const written = redisOps.filter(([kind]) => kind === 'set').map(([, key]) => key);
    const shapes = [
      new RegExp(`^api:posts:${PROJECT}:lessons:[0-9a-f]{12}$`),
      new RegExp(`^posts:${PROJECT}:lessons:[0-9a-f]{12}$`),
      new RegExp(`^posts-count:${PROJECT}:lessons:[0-9a-f]{12}$`),
      new RegExp(`^menuposts:${PROJECT}:pt-lessons$`),
      new RegExp(`^sitemap:${PROJECT}$`),
      new RegExp(`^sp:${PROJECT}:lessons:secret-one$`),
    ];
    for (const shape of shapes) assert.equal(written.some((key) => shape.test(key)), true, `a key like ${shape} is written`);
    assert.equal(written.some((key) => /:g[0-9a-f]{12}$/.test(key)), false, 'no key carries a members-only suffix');

    // The single post is served from the shared cache the second time, as before.
    queried.length = 0;
    assert.equal((await get('/lessons/secret-one')).status, 200);
    assert.equal(queried.includes('posts'), false);

    if (!membersEnabled) {
      assert.equal(queried.filter((name) => name === 'site_post_access').length, 0, 'switch off: the one probe already happened, nothing more for a minute');
    }
    assert.equal(queried.includes('site_post_access_groups'), false);
    assert.equal(queried.includes('site_member_sessions'), false, 'no session lookup on a site with nothing gated');
  });
}

// ---------------------------------------------------------------------------
// ?nocache=1 flush
// ---------------------------------------------------------------------------

test('?nocache=1 clears the post feed, post counts and menu auto-fill lists along with the rest', async () => {
  const keys = [
    `api:posts:${PROJECT}:lessons:abc`, `menuposts:${PROJECT}:pt-lessons`, `posts-count:${PROJECT}:lessons:abc`,
    `posts:${PROJECT}:lessons:abc`, `sp:${PROJECT}:lessons:welcome`, `sitemap:${PROJECT}`,
    `posts:${PROJECT}:lessons:abc:g0123456789ab`, `menuposts:${PROJECT}:pt-lessons:g0123456789ab`,
  ];
  for (const key of keys) store.set(key, '[]');
  store.set('unrelated:key', 'stays');
  assert.equal((await get('/sitemap.xml?nocache=1')).status, 200);
  const deleted = keysOf('del', '');
  for (const key of keys) assert.equal(deleted.includes(key), true, `${key} is cleared`);
  assert.equal(store.get('unrelated:key'), 'stays');
});
