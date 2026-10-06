const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { after, before, beforeEach, test } = require('node:test');
const express = require('express');

// Follow the shortcode test's provider seams, but apply the actual query filters:
// ignoring a status or project filter would make these privacy tests meaningless.
const database = require('../dist/lib/db');
const redis = require('../dist/lib/redis');
const artifacts = require('../dist/services/artifact.service');
const originals = {
  getDb: database.getDb,
  getRedis: redis.getRedis,
  fetchArtifactIndexHtml: artifacts.fetchArtifactIndexHtml,
  fetchArtifactAsset: artifacts.fetchArtifactAsset,
};
const rows = {};
const artifactReads = [];
const PROJECT_ID = 'synthetic-project';
const HOSTS = ['practice.test', 'practice.sites.getalloro.com', 'practice.sites.localhost'];
const DRAFT_MARKER = 'UNAPPROVED_DRAFT_CONTENT';
const PUBLISHED_MARKER = 'APPROVED_PUBLIC_CONTENT';

function matches(column, value) {
  const criteria = typeof column === 'string' ? { [column]: value } : column;
  return (row) => Object.entries(criteria).every(([key, expected]) => row[key] === expected);
}

function query(table) {
  const name = table.replace(/^website_builder\./, '');
  assert.ok(Object.hasOwn(rows, name), `Unexpected query table: ${table}`);
  let result = rows[name];
  const chain = {
    where: (column, value) => {
      if (typeof column === 'function') {
        const conditions = [];
        const group = {
          where: (key, expected) => { conditions.push(matches(key, expected)); return group; },
          orWhere: (key, expected) => { conditions.push(matches(key, expected)); return group; },
        };
        column.call(group);
        result = result.filter((row) => conditions.some((condition) => condition(row)));
      } else {
        result = result.filter(matches(column, value));
      }
      return chain;
    },
    whereIn: (column, values) => {
      result = result.filter((row) => values.includes(row[column]));
      return chain;
    },
    whereNull: (column) => { result = result.filter((row) => row[column] == null); return chain; },
    whereNotNull: (column) => { result = result.filter((row) => row[column] != null); return chain; },
    select: () => chain,
    orderBy: () => chain,
    orderByRaw: (sql) => {
      assert.equal(sql, 'LENGTH(path) DESC');
      result = [...result].sort((left, right) => right.path.length - left.path.length);
      return chain;
    },
    first: async () => result[0],
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}
query.raw = () => '1';

database.getDb = () => query;
redis.getRedis = () => ({ get: async () => null, set: async () => undefined });
artifacts.fetchArtifactIndexHtml = async (prefix) => {
  artifactReads.push({ prefix, path: 'index.html' });
  return `<html><head></head><body>${prefix}</body></html>`;
};
artifacts.fetchArtifactAsset = async (prefix, path) => {
  artifactReads.push({ prefix, path });
  return { buffer: Buffer.from(`${prefix}:${path}`), contentType: 'application/javascript' };
};

const pages = require('../dist/services/page.service');
const { extractSubdomain } = require('../dist/middleware/subdomain');
const { siteRoute } = require('../dist/routes/site');
let server;

before(async () => {
  const app = express();
  app.use(extractSubdomain);
  app.get('*', (req, res, next) => { siteRoute(req, res).catch(next); });
  app.use((_error, _req, res, _next) => { res.status(500).send('Renderer failure'); });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

beforeEach(() => {
  rows.projects = [{
    id: PROJECT_ID,
    generated_hostname: 'practice',
    custom_domain: 'practice.test',
    custom_domain_alt: null,
    domain_verified_at: '2026-10-06',
    archived_at: null,
    // Even an old LIVE project flag must not expose draft content.
    status: 'LIVE',
    template_id: null,
    wrapper: '<html><head></head><body>{{slot}}</body></html>',
    header: '',
    footer: '',
  }];
  rows.pages = [];
  rows.header_footer_code = [];
  rows.website_integrations = [];
  rows.redirects = [];
  artifactReads.length = 0;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.getDb = originals.getDb;
  redis.getRedis = originals.getRedis;
  artifacts.fetchArtifactIndexHtml = originals.fetchArtifactIndexHtml;
  artifacts.fetchArtifactAsset = originals.fetchArtifactAsset;
});

function page(path, status = 'draft', extra = {}) {
  return {
    id: `${status}:${path}`,
    project_id: PROJECT_ID,
    path,
    status,
    page_type: 'sections',
    sections: [{ name: 'content', content: status === 'published' ? PUBLISHED_MARKER : DRAFT_MARKER }],
    seo_data: null,
    ...extra,
  };
}

async function request(host, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, headers: { host } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
  });
}

function assertPrivate(response) {
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.body, new RegExp(DRAFT_MARKER));
}

test('page selection requires a published version of the exact project and path', async () => {
  rows.pages = [
    page('/private'),
    page('/retired', 'inactive'),
    page('/private', 'published', { project_id: 'another-project' }),
  ];
  assert.equal(await pages.getPageToRender(PROJECT_ID, '/private'), null);
  assert.equal(await pages.getPageToRender(PROJECT_ID, '/retired'), null);
  assert.equal(await pages.hasPublishedPages(PROJECT_ID), false);
  const published = page('/private', 'published');
  rows.pages.push(published);
  assert.equal(await pages.getPageToRender(PROJECT_ID, '/private'), published);
});

test('artifact path and asset lookup exclude draft/inactive and other-project bundles', async () => {
  rows.pages = [
    page('/private-tool', 'draft', { page_type: 'artifact', artifact_s3_prefix: DRAFT_MARKER }),
    page('/retired-tool', 'inactive', { page_type: 'artifact', artifact_s3_prefix: DRAFT_MARKER }),
    page('/other-tool', 'published', { project_id: 'another-project', page_type: 'artifact' }),
  ];
  for (const path of ['/private-tool', '/private-tool/', '/private-tool/assets/app.js', '/retired-tool/assets/app.js', '/other-tool/assets/app.js']) {
    assert.equal(await pages.isArtifactPath(PROJECT_ID, path), false);
    assert.equal(await pages.getArtifactPageByPrefix(PROJECT_ID, path), null);
  }
});

test('published artifact selection retains longest-prefix and path-boundary behavior', async () => {
  const nested = page('/tools/calculator', 'published', { page_type: 'artifact', artifact_s3_prefix: 'approved-calculator' });
  rows.pages = [page('/tools', 'published', { page_type: 'artifact' }), nested];
  assert.equal(await pages.isArtifactPath(PROJECT_ID, '/tools/calculator/'), true);
  assert.equal(await pages.isArtifactPath(PROJECT_ID, '/toolsmith'), false);
  assert.deepEqual(await pages.getArtifactPageByPrefix(PROJECT_ID, '/tools/calculator/assets/app.js'), {
    page: nested,
    subPath: 'assets/app.js',
  });
  assert.equal(await pages.getArtifactPageByPrefix(PROJECT_ID, '/toolsmith/assets/app.js'), null);
});

test('draft-only projects return 404 without content or artifact reads on every public host', async () => {
  rows.pages = [
    page('/'),
    page('/private-tool', 'draft', { page_type: 'artifact', artifact_s3_prefix: DRAFT_MARKER }),
  ];
  for (const host of HOSTS) {
    for (const path of ['/', '/private-tool', '/private-tool/assets/app.js']) {
      assertPrivate(await request(host, path));
    }
  }
  assert.deepEqual(artifactReads, []);
});

test('a published sibling never exposes draft pages or artifact HTML/assets', async () => {
  rows.pages = [
    page('/', 'published'),
    page('/private'),
    page('/retired', 'inactive'),
    page('/private-tool', 'draft', { page_type: 'artifact', artifact_s3_prefix: DRAFT_MARKER }),
  ];
  for (const host of HOSTS) {
    for (const path of ['/private', '/retired', '/private-tool', '/private-tool/assets/app.js']) {
      assertPrivate(await request(host, path));
    }
    const published = await request(host, '/');
    assert.equal(published.status, 200);
    assert.match(published.body, new RegExp(PUBLISHED_MARKER));
    assert.doesNotMatch(published.body, new RegExp(DRAFT_MARKER));
  }
  assert.deepEqual(artifactReads, []);
});

test('a newer draft cannot replace the published version returned over HTTP', async () => {
  rows.pages = [page('/same-address'), page('/same-address', 'published')];
  for (const host of HOSTS) {
    const response = await request(host, '/same-address');
    assert.equal(response.status, 200);
    assert.match(response.body, new RegExp(PUBLISHED_MARKER));
    assert.doesNotMatch(response.body, new RegExp(DRAFT_MARKER));
  }
});

test('published artifacts still serve HTML and immutable assets on every public host', async () => {
  rows.pages = [page('/calculator', 'published', { page_type: 'artifact', artifact_s3_prefix: 'approved-bundle' })];
  for (const host of HOSTS) {
    const html = await request(host, '/calculator');
    assert.equal(html.status, 200);
    assert.match(html.body, /approved-bundle/);
    const asset = await request(host, '/calculator/assets/app.js');
    assert.equal(asset.status, 200);
    assert.equal(asset.body, 'approved-bundle:assets/app.js');
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(asset.headers['content-type'], /application\/javascript/);
  }
  assert.equal(artifactReads.length, HOSTS.length * 2);
  assert.ok(artifactReads.every((read) => read.prefix === 'approved-bundle'));
});

test('draft artifacts cannot opt out of the public trailing-slash redirect', async () => {
  rows.pages = [page('/', 'published'), page('/private-tool', 'draft', { page_type: 'artifact', artifact_s3_prefix: DRAFT_MARKER })];
  const response = await request(HOSTS[0], '/private-tool/');
  assert.equal(response.status, 301);
  assert.equal(response.headers.location, '/private-tool');
  assertPrivate(await request(HOSTS[0], response.headers.location));
  assert.deepEqual(artifactReads, []);
});
