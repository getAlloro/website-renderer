const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { after, before, beforeEach, test } = require('node:test');
const express = require('express');

// Domain switch: a live site keeps its verified domain while a new one is PENDING
// (served as-is), and after promotion its old domain lives in
// project_domain_redirects and 301s to the new serving host. These tests pin the
// fallback order: the verified lookup runs first and is unchanged; pending and
// redirect lookups run only on a miss; a missing table/column means "no match".
const database = require('../dist/lib/db');
const redis = require('../dist/lib/redis');
const originals = { getDb: database.getDb, getRedis: redis.getRedis };

const rows = {};
const queried = [];
// failures(table, referencedColumns) -> error to throw, or null.
let failures = () => null;
const PUBLISHED_MARKER = 'APPROVED_PUBLIC_CONTENT';

function matches(column, value) {
  const criteria = typeof column === 'string' ? { [column]: value } : column;
  return (row) => Object.entries(criteria).every(([key, expected]) => row[key] === expected);
}

function query(table) {
  const name = table.replace(/^website_builder\./, '');
  assert.ok(Object.hasOwn(rows, name), `Unexpected query table: ${table}`);
  const columns = new Set();
  let result = rows[name];
  const track = (column) => {
    if (typeof column === 'string') columns.add(column);
    else if (column && typeof column === 'object') Object.keys(column).forEach((key) => columns.add(key));
  };
  const settle = () => {
    queried.push({ table: name, columns: [...columns] });
    const error = failures(name, columns);
    if (error) throw error;
  };
  const chain = {
    where: (column, value) => {
      if (typeof column === 'function') {
        const conditions = [];
        const group = {
          where: (key, expected) => { track(key); conditions.push(matches(key, expected)); return group; },
          orWhere: (key, expected) => { track(key); conditions.push(matches(key, expected)); return group; },
        };
        column.call(group);
        result = result.filter((row) => conditions.some((condition) => condition(row)));
      } else {
        track(column);
        result = result.filter(matches(column, value));
      }
      return chain;
    },
    whereIn: (column, values) => { track(column); result = result.filter((row) => values.includes(row[column])); return chain; },
    whereNull: (column) => { track(column); result = result.filter((row) => row[column] == null); return chain; },
    whereNotNull: (column) => { track(column); result = result.filter((row) => row[column] != null); return chain; },
    select: () => chain,
    orderBy: () => chain,
    orderByRaw: () => chain,
    first: async () => { settle(); return result[0]; },
    then: (resolve, reject) => {
      try { settle(); } catch (error) { return Promise.reject(error).then(resolve, reject); }
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return chain;
}
query.raw = () => '1';

database.getDb = () => query;
redis.getRedis = () => ({ get: async () => null, set: async () => undefined });

const projects = require('../dist/services/project.service');
const { extractSubdomain } = require('../dist/middleware/subdomain');
const { siteRoute } = require('../dist/routes/site');
const { verifyDomainRoute } = require('../dist/routes/verify-domain');
let server;

before(async () => {
  const app = express();
  app.get('/verify-domain', (req, res, next) => { verifyDomainRoute(req, res).catch(next); });
  app.use(extractSubdomain);
  app.get('*', (req, res, next) => { siteRoute(req, res).catch(next); });
  app.use((_error, _req, res, _next) => { res.status(500).send('Renderer failure'); });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

function project(overrides = {}) {
  return {
    id: 'project-a',
    generated_hostname: 'practice-a',
    custom_domain: 'new.test',
    custom_domain_alt: 'www.new.test',
    domain_verified_at: '2026-10-26',
    pending_custom_domain: null,
    pending_custom_domain_alt: null,
    archived_at: null,
    status: 'LIVE',
    template_id: null,
    wrapper: '<html><head></head><body>{{slot}}</body></html>',
    header: '',
    footer: '',
    ...overrides,
  };
}

beforeEach(() => {
  rows.projects = [project()];
  rows.project_domain_redirects = [];
  rows.pages = ['/', '/about'].map((path) => ({
    id: `page:${path}`,
    project_id: 'project-a',
    path,
    status: 'published',
    page_type: 'sections',
    sections: [{ name: 'content', content: PUBLISHED_MARKER }],
    seo_data: null,
  }));
  rows.header_footer_code = [];
  rows.website_integrations = [];
  rows.redirects = [];
  queried.length = 0;
  failures = () => null;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.getDb = originals.getDb;
  redis.getRedis = originals.getRedis;
});

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

function schemaError(code) {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

function touchedDomainSwitchSchema() {
  return queried.some(
    (entry) =>
      entry.table === 'project_domain_redirects' ||
      entry.columns.includes('pending_custom_domain') ||
      entry.columns.includes('pending_custom_domain_alt')
  );
}

test('a verified domain resolves exactly as before and never reaches the fallbacks', async () => {
  // Another project holding this host as its pending domain must not shadow it.
  rows.projects.push(project({ id: 'project-b', custom_domain: 'other.test', custom_domain_alt: null, pending_custom_domain: 'www.new.test' }));
  rows.project_domain_redirects = [{ id: 'r1', project_id: 'project-b', from_domain: 'www.new.test' }];

  const served = await request('www.new.test', '/about');
  assert.equal(served.status, 200);
  assert.match(served.body, new RegExp(PUBLISHED_MARKER));
  assert.equal(touchedDomainSwitchSchema(), false);

  const verified = await projects.getProjectByCustomDomain('new.test');
  assert.equal(verified.id, 'project-a');
});

test('the www-unification 301 on a verified domain is unchanged', async () => {
  const response = await request('new.test', '/about?x=1');
  assert.equal(response.status, 301);
  assert.equal(response.headers.location, 'https://www.new.test/about?x=1');
  assert.equal(response.headers['cache-control'], undefined);
  assert.equal(touchedDomainSwitchSchema(), false);
});

test('a pending domain (and its alt) serves the live site without bouncing to the current host', async () => {
  rows.projects = [project({ custom_domain: 'old.test', custom_domain_alt: 'www.old.test', pending_custom_domain: 'new.test', pending_custom_domain_alt: 'www.new.test' })];
  for (const host of ['new.test', 'www.new.test']) {
    const response = await request(host, '/about');
    assert.equal(response.status, 200, host);
    assert.match(response.body, new RegExp(PUBLISHED_MARKER));
    // Canonical stays on the current verified host until promotion.
    assert.match(response.body, /https:\/\/www\.old\.test\/about/);
  }
});

test('a pending domain on a project with no verified domain, or an archived one, is not served', async () => {
  rows.projects = [project({ custom_domain: 'old.test', domain_verified_at: null, pending_custom_domain: 'new.test' })];
  assert.equal((await request('new.test', '/')).status, 404);
  assert.equal(await projects.getProjectByPendingDomain('new.test'), null);

  rows.projects = [project({ custom_domain: 'old.test', archived_at: '2026-10-01', pending_custom_domain: 'new.test' })];
  assert.equal(await projects.getProjectByPendingDomain('new.test'), null);
});

test('an old domain 301s to the serving host with path and query preserved', async () => {
  rows.project_domain_redirects = [
    { id: 'r1', project_id: 'project-a', from_domain: 'old.test' },
    { id: 'r2', project_id: 'project-a', from_domain: 'www.old.test' },
  ];
  for (const host of ['old.test', 'www.old.test']) {
    const response = await request(host, '/about?utm_source=card&x=1');
    assert.equal(response.status, 301, host);
    // www twin configured -> www serving host, same rule as the sitemap.
    assert.equal(response.headers.location, 'https://www.new.test/about?utm_source=card&x=1');
    assert.equal(response.headers['cache-control'], 'public, max-age=86400');
  }
});

test('an old domain redirects to the bare host when the project has no www twin', async () => {
  rows.projects = [project({ custom_domain_alt: 'shop.new.test' })];
  rows.project_domain_redirects = [{ id: 'r1', project_id: 'project-a', from_domain: 'old.test' }];
  const response = await request('old.test', '/');
  assert.equal(response.status, 301);
  assert.equal(response.headers.location, 'https://new.test/');
});

test('a redirect row for an archived or unverified project is not honored', async () => {
  rows.project_domain_redirects = [{ id: 'r1', project_id: 'project-a', from_domain: 'old.test' }];

  rows.projects = [project({ archived_at: '2026-10-20' })];
  assert.equal((await request('old.test', '/about')).status, 404);
  assert.equal(await projects.getDomainRedirectTarget('old.test'), null);

  rows.projects = [project({ domain_verified_at: null })];
  assert.equal((await request('old.test', '/about')).status, 404);
});

test('a missing domain-switch table or column means no match, not a 500', async () => {
  rows.project_domain_redirects = [{ id: 'r1', project_id: 'project-a', from_domain: 'old.test' }];
  rows.projects.push(project({ id: 'project-b', custom_domain: 'other.test', pending_custom_domain: 'pending.test' }));
  failures = (table, columns) => {
    if (table === 'project_domain_redirects') return schemaError('42P01');
    if (columns.has('pending_custom_domain')) return schemaError('42703');
    return null;
  };

  assert.equal(await projects.getProjectByPendingDomain('pending.test'), null);
  assert.equal(await projects.getDomainRedirectTarget('old.test'), null);
  assert.equal((await request('old.test', '/')).status, 404);
  assert.equal((await request('pending.test', '/')).status, 404);
  // The verified path is untouched by the missing schema.
  assert.equal((await request('www.new.test', '/')).status, 200);
});

test('any other database error from a fallback still surfaces', async () => {
  failures = (table) => (table === 'project_domain_redirects' ? schemaError('57P01') : null);
  await assert.rejects(projects.getDomainRedirectTarget('old.test'), /57P01/);
  assert.equal((await request('old.test', '/')).status, 500);
});

test('the TLS ask allows pending and redirect domains, existence only', async () => {
  rows.projects = [project({ custom_domain: 'old.test', custom_domain_alt: 'www.old.test', pending_custom_domain: 'new.test', pending_custom_domain_alt: 'www.new.test' })];
  rows.project_domain_redirects = [{ id: 'r1', project_id: 'project-z', from_domain: 'former.test' }];

  for (const domain of ['old.test', 'www.old.test', 'new.test', 'www.new.test', 'former.test']) {
    const response = await request('renderer.internal', `/verify-domain?domain=${domain}`);
    assert.equal(response.status, 200, domain);
  }
  assert.equal((await request('renderer.internal', '/verify-domain?domain=unknown.test')).status, 404);
});

test('the TLS ask treats a missing domain-switch schema as no match', async () => {
  failures = (table, columns) =>
    table === 'project_domain_redirects' || columns.has('pending_custom_domain') ? schemaError('42P01') : null;
  assert.equal((await request('renderer.internal', '/verify-domain?domain=new.test')).status, 200);
  assert.equal((await request('renderer.internal', '/verify-domain?domain=unknown.test')).status, 404);
});
