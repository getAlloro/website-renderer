const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');
const express = require('express');

const APP = 'https://app.getalloro.com';
process.env.API_BASE_URL = APP;

const redis = require('../dist/lib/redis');
const { localizeVersionedImports, VERSIONED_IMPORT_PATH } = require('../dist/utils/versionedImports');
const { importsRouter } = require('../dist/routes/imports');

// ---------------------------------------------------------------------------
// HTML rewrite
// ---------------------------------------------------------------------------

test("rewrites the app's versioned imports onto the site origin and nothing else", () => {
  const html = [
    `<link rel="stylesheet" href="${APP}/api/imports/custom-styles.css/v/8" />`,
    `<script src='${APP}/api/imports/custom-scripts.js/v/6'></script>`,
    `<script src="${APP}/api/imports/alloro-template.js"></script>`,
    `<link rel="stylesheet" href="https://cdn.example.com/api/imports/other.css/v/2" />`,
    `<a href="${APP}/api/imports/custom-styles.css/v/80">v80</a>`,
  ].join('\n');

  const out = localizeVersionedImports(html, APP);

  assert.match(out, /href="\/api\/imports\/custom-styles\.css\/v\/8"/);
  assert.match(out, /src='\/api\/imports\/custom-scripts\.js\/v\/6'/);
  assert.match(out, /href="\/api\/imports\/custom-styles\.css\/v\/80"/);
  // The unversioned form stays on the app origin.
  assert.ok(out.includes(`src="${APP}/api/imports/alloro-template.js"`));
  // Other origins are untouched.
  assert.ok(out.includes('href="https://cdn.example.com/api/imports/other.css/v/2"'));
});

test('a trailing slash on the base and a query string on the reference still match', () => {
  const html = `<link href="${APP}/api/imports/custom-styles.css/v/8?x=1">`;
  assert.equal(localizeVersionedImports(html, `${APP}/`), '<link href="/api/imports/custom-styles.css/v/8?x=1">');
});

test('HTML without a reference, including $ patterns, comes back byte for byte', () => {
  const html = `<p>$$ $& $' $1 ${APP}/api/forms</p>`;
  assert.equal(localizeVersionedImports(html, APP), html);
  assert.equal(localizeVersionedImports(html, ''), html);
});

test('the site-origin path grammar', () => {
  assert.ok(VERSIONED_IMPORT_PATH.test('/api/imports/custom-styles.css/v/8'));
  assert.ok(VERSIONED_IMPORT_PATH.test('/api/imports/v6-additions.js/v/12'));
  for (const bad of [
    '/api/imports/alloro-template.js',
    '/api/imports/custom-styles.css',
    '/api/imports/custom-styles.css/v/0',
    '/api/imports/custom-styles.css/v/8/extra',
    '/api/imports/.env/v/1',
    '/api/imports/a%2Fb/v/1',
    '/api/imports/../x/v/1',
    '/api/imports//v/1',
  ]) {
    assert.ok(!VERSIONED_IMPORT_PATH.test(bad), bad);
  }
});

// ---------------------------------------------------------------------------
// Route: fetched from the app once, kept in Redis, errors passed through
// ---------------------------------------------------------------------------

const store = new Map();
const fetches = [];
let upstream = () =>
  new Response('body{color:#000}', {
    status: 200,
    headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });

const originalRedis = redis.getRedis;
const originalFetch = global.fetch;
redis.getRedis = () => ({
  get: async (key) => store.get(key) ?? null,
  set: async (key, value) => {
    store.set(key, value);
  },
});
global.fetch = async (url) => {
  fetches.push(String(url));
  return upstream(url);
};

const app = express();
app.use(importsRouter);
app.use((_req, res) => res.status(404).type('text/plain').send('fell through'));

let server;
let port;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;
});
after(() => {
  server.close();
  redis.getRedis = originalRedis;
  global.fetch = originalFetch;
});

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

test('serves a versioned import from the app once, then from Redis', async () => {
  const first = await get('/api/imports/custom-styles.css/v/8');
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(first.headers['cache-control'], 'public, max-age=3600');
  assert.equal(first.body.toString(), 'body{color:#000}');

  const second = await get('/api/imports/custom-styles.css/v/8');
  assert.equal(second.status, 200);
  assert.equal(second.body.toString(), 'body{color:#000}');

  assert.deepEqual(fetches, [`${APP}/api/imports/custom-styles.css/v/8`]);
  assert.ok(store.has('imp:custom-styles.css:8'));
});

test("the app's 410 for a deprecated version is passed through and not cached as content", async () => {
  upstream = () =>
    new Response('{"error":"DEPRECATED"}', { status: 410, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const res = await get('/api/imports/custom-styles.css/v/1');
  assert.equal(res.status, 410);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.toString(), '{"error":"DEPRECATED"}');
});

test('the unversioned form is not handled here and never reaches the app', async () => {
  const res = await get('/api/imports/alloro-template.js');
  assert.equal(res.status, 404);
  assert.equal(res.body.toString(), 'fell through');
  assert.equal(fetches.filter((url) => url.endsWith('alloro-template.js')).length, 0);
});

test('an unreachable app is a 502, not a hang or a crash', async () => {
  upstream = () => {
    throw new Error('connect ECONNREFUSED');
  };
  const res = await get('/api/imports/custom-styles.css/v/9');
  assert.equal(res.status, 502);
  assert.equal(res.headers['cache-control'], 'no-store');
});
