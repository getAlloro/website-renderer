const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { after, before, beforeEach, test } = require('node:test');
const express = require('express');

// Site members over HTTP: the /_members/* passthrough routes against a stand-in for
// the Alloro app, and the members-only gate inside the real siteRoute.
const database = require('../dist/lib/db');
const redis = require('../dist/lib/redis');
const artifacts = require('../dist/services/artifact.service');

const TOKEN = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG0';
const SECRET = 'test-renderer-secret';
const SITE = 'www.members.test';

// ---------------------------------------------------------------------------
// Stand-in app
// ---------------------------------------------------------------------------

const upstreamCalls = [];
let upstreamAnswer = () => ({ status: 200, body: { success: true, data: {}, error: null } });
let appServer;

before(async () => {
  appServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      upstreamCalls.push(call);
      const answer = upstreamAnswer(call);
      if (answer.hang) return; // never answers: the renderer must give up on its own
      res.writeHead(answer.status, { 'content-type': answer.contentType || 'application/json' });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  });
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  process.env.API_BASE_URL = `http://127.0.0.1:${appServer.address().port}`;
});

// ---------------------------------------------------------------------------
// Recorded database for siteRoute
// ---------------------------------------------------------------------------

let tables = {};
const queried = [];

function fakeDb(table) {
  const name = String(table).replace(/^website_builder\./, '').replace(/ as \w+$/, '');
  let rows = tables[name] || [];
  const chain = {
    where: (column, value) => {
      // Enough filtering for the page lookups; member tables return what the test set.
      if (name === 'pages' && column && typeof column === 'object') {
        rows = rows.filter((row) => Object.entries(column).every(([key, expected]) => row[key] === expected));
      } else if (name === 'pages' && typeof column === 'string' && arguments.length === 2) {
        rows = rows.filter((row) => row[column] === value);
      }
      return chain;
    },
    whereNull: () => chain,
    whereNotNull: () => chain,
    whereIn: () => chain,
    join: () => chain,
    leftJoin: () => chain,
    select: () => chain,
    orderBy: () => chain,
    orderByRaw: () => chain,
    first: async () => { queried.push(name); return rows[0]; },
    then: (resolve, reject) => { queried.push(name); return Promise.resolve(rows).then(resolve, reject); },
  };
  return chain;
}
fakeDb.raw = () => '1';
fakeDb.fn = { now: () => 'now()' };
database.getDb = () => fakeDb;
redis.getRedis = () => ({ get: async () => null, set: async () => undefined });
artifacts.fetchArtifactIndexHtml = async () => '<html><head><title>App</title></head><body>MEMBER_APP</body></html>';
artifacts.fetchArtifactAsset = async () => ({ buffer: Buffer.from('console.log("MEMBER_ASSET")'), contentType: 'application/javascript' });

const access = require('../dist/services/member-access.service');
const { extractSubdomain } = require('../dist/middleware/subdomain');
const { membersRouter } = require('../dist/routes/members');
const { siteRoute } = require('../dist/routes/site');

let server;
before(async () => {
  const app = express();
  // The same order as src/index.ts.
  app.use(extractSubdomain);
  app.use(membersRouter);
  app.get('*', (req, res, next) => { siteRoute(req, res).catch(next); });
  app.use((_error, _req, res, _next) => { res.status(500).send('Renderer failure'); });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

after(() => {
  server.close();
  appServer.closeAllConnections();
  appServer.close();
});

function page(path, overrides = {}) {
  return {
    id: `page-${path}`, project_id: 'project-m', path, version: 1, status: 'published', generation_status: 'ready',
    page_type: 'sections', artifact_s3_prefix: null, seo_data: { robots: 'index, follow' },
    sections: [{ name: 'main', content: `<p>CONTENT_OF_${path}</p>` }], ...overrides,
  };
}

beforeEach(() => {
  upstreamCalls.length = 0;
  queried.length = 0;
  upstreamAnswer = () => ({ status: 200, body: { success: true, data: {}, error: null } });
  process.env.SITE_MEMBERS_RENDERER_SECRET = SECRET;
  access.resetMemberAccessMemo();
  tables = {
    projects: [{
      id: 'project-m', generated_hostname: 'members', custom_domain: 'members.test', custom_domain_alt: SITE,
      domain_verified_at: '2026-11-01', archived_at: null, template_id: null, members_enabled: true,
      wrapper: '<html><head><title>T</title></head><body>{{slot}}</body></html>', header: '', footer: '',
    }],
    pages: [
      page('/'), page('/about'), page('/base-camp'), page('/base-camp/adc'),
      page('/portal', { page_type: 'artifact', artifact_s3_prefix: 'bundle' }),
    ],
    header_footer_code: [], website_integrations: [], redirects: [],
    site_page_access: [{ id: 'a1', path: '/base-camp' }, { id: 'a2', path: '/portal' }],
    site_page_access_groups: [],
    site_member_sessions: [],
  };
});

function request(method, path, { headers = {}, body, host = SITE } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path, headers: { host, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const JSON_POST = { 'content-type': 'application/json', origin: `https://${SITE}` };
const UNAVAILABLE = {
  success: false,
  data: null,
  error: { code: 'MEMBERS_UNAVAILABLE', message: 'Sign-in is not available right now. Please try again.' },
};

// ---------------------------------------------------------------------------
// /_members/*
// ---------------------------------------------------------------------------

test('/_members/code forwards the email with the secret, the site host and the visitor address', async () => {
  upstreamAnswer = () => ({ status: 200, body: { success: true, data: { message: 'If this email can sign in here, we sent a code.' }, error: null } });
  const res = await request('POST', '/_members/code', {
    headers: { ...JSON_POST, 'x-forwarded-for': '9.9.9.9, 203.0.113.7' },
    body: { email: 'member@example.com', project_id: 'someone-elses-site' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json, { success: true, data: { message: 'If this email can sign in here, we sent a code.' }, error: null });

  assert.equal(upstreamCalls.length, 1);
  const call = upstreamCalls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, '/api/site-members-public/code');
  assert.equal(call.headers['x-alloro-renderer-secret'], SECRET);
  assert.equal(call.headers['x-alloro-site-host'], SITE);
  assert.equal(call.headers['x-alloro-visitor-ip'], '203.0.113.7');
  assert.match(call.headers['content-type'], /^application\/json/);
  assert.deepEqual(call.body, { email: 'member@example.com' }, 'only the agreed fields are forwarded');
});

test('/_members/code passes a refusal through with its status', async () => {
  upstreamAnswer = () => ({ status: 429, body: { success: false, data: null, error: { code: 'RATE_LIMITED', message: 'Too many tries. Wait a while.' } } });
  const limited = await request('POST', '/_members/code', { headers: JSON_POST, body: { email: 'member@example.com' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'RATE_LIMITED');

  upstreamAnswer = () => ({ status: 404, body: { success: false, data: null, error: { code: 'NOT_FOUND', message: 'Not found.' } } });
  assert.equal((await request('POST', '/_members/code', { headers: JSON_POST, body: { email: 'member@example.com' } })).status, 404);
});

test('/_members/verify sets the host-only cookie and never returns the token', async () => {
  upstreamAnswer = () => ({ status: 200, body: { success: true, data: { token: TOKEN, expiresAt: '2026-12-15T00:00:00.000Z', next: '/base-camp' }, error: null } });
  const res = await request('POST', '/_members/verify', { headers: JSON_POST, body: { email: 'member@example.com', code: 'ABCDEFGHJK', next: '/base-camp' } });

  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { success: true, data: { next: '/base-camp' }, error: null });
  assert.equal(res.text.includes(TOKEN), false, 'the token must not reach page script');
  assert.deepEqual(res.headers['set-cookie'], [`alloro_member=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`]);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(upstreamCalls[0].body, { email: 'member@example.com', code: 'ABCDEFGHJK', next: '/base-camp' });
});

test('/_members/verify: an off-site next from the browser or the app becomes the home page', async () => {
  upstreamAnswer = () => ({ status: 200, body: { success: true, data: { token: TOKEN, next: 'https://evil.test/' }, error: null } });
  const res = await request('POST', '/_members/verify', { headers: JSON_POST, body: { email: 'member@example.com', code: 'ABCDEFGHJK', next: '//evil.test' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.data, { next: '/' });
  assert.equal(upstreamCalls[0].body.next, '/');
});

test('/_members/verify on a local host leaves Secure off (the local runtime is plain http)', async () => {
  upstreamAnswer = () => ({ status: 200, body: { success: true, data: { token: TOKEN, next: '/' }, error: null } });
  const host = 'alloro-test-0123456789ab-01234567.localhost:5555';
  const res = await request('POST', '/_members/verify', {
    host, headers: { 'content-type': 'application/json', origin: `http://${host}` }, body: { email: 'member@example.com', code: 'ABCDEFGHJK' },
  });
  assert.deepEqual(res.headers['set-cookie'], [`alloro_member=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`]);
  assert.equal(upstreamCalls[0].headers['x-alloro-site-host'], 'alloro-test-0123456789ab-01234567.localhost');
});

test('/_members/verify: a wrong code sets no cookie and leaks nothing extra', async () => {
  upstreamAnswer = () => ({ status: 401, body: { success: false, data: { token: TOKEN }, error: { code: 'INVALID_CODE', message: 'That code did not work.' } } });
  const res = await request('POST', '/_members/verify', { headers: JSON_POST, body: { email: 'member@example.com', code: 'WRONGWRONG' } });
  assert.equal(res.status, 401);
  assert.deepEqual(res.json, { success: false, data: null, error: { code: 'INVALID_CODE', message: 'That code did not work.' } });
  assert.equal(res.headers['set-cookie'], undefined);
});

test('/_members/verify: a 200 without a usable token is "not available", with no cookie', async () => {
  for (const data of [{}, { token: 'short' }, { token: `${TOKEN}; Domain=evil.test` }, null]) {
    upstreamAnswer = () => ({ status: 200, body: { success: true, data, error: null } });
    const res = await request('POST', '/_members/verify', { headers: JSON_POST, body: { email: 'member@example.com', code: 'ABCDEFGHJK' } });
    assert.equal(res.status, 503);
    assert.deepEqual(res.json, UNAVAILABLE);
    assert.equal(res.headers['set-cookie'], undefined);
  }
});

test('no secret configured: 503 and the app is never called', async () => {
  delete process.env.SITE_MEMBERS_RENDERER_SECRET;
  for (const [path, body] of [['/_members/code', { email: 'member@example.com' }], ['/_members/verify', { email: 'member@example.com', code: 'ABCDEFGHJK' }]]) {
    const res = await request('POST', path, { headers: JSON_POST, body });
    assert.equal(res.status, 503, path);
    assert.deepEqual(res.json, UNAVAILABLE);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  const session = await request('GET', '/_members/session', { headers: { cookie: `alloro_member=${TOKEN}` } });
  assert.equal(session.status, 503);
  assert.equal(upstreamCalls.length, 0);
});

test('app down, or an answer that is not the agreed envelope: 503', async () => {
  upstreamAnswer = () => ({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' });
  assert.deepEqual((await request('POST', '/_members/code', { headers: JSON_POST, body: { email: 'member@example.com' } })).json, UNAVAILABLE);

  upstreamAnswer = () => ({ status: 200, body: { ok: true } });
  assert.equal((await request('POST', '/_members/code', { headers: JSON_POST, body: { email: 'member@example.com' } })).status, 503);

  const saved = process.env.API_BASE_URL;
  process.env.API_BASE_URL = 'http://127.0.0.1:1';
  try {
    const res = await request('POST', '/_members/code', { headers: JSON_POST, body: { email: 'member@example.com' } });
    assert.equal(res.status, 503);
    assert.deepEqual(res.json, UNAVAILABLE);
  } finally {
    process.env.API_BASE_URL = saved;
  }
});

test('cross-site POSTs are refused before the body is read or the app is called', async () => {
  const attempts = [
    { 'content-type': 'application/json', origin: 'https://evil.test' },
    { 'content-type': 'application/json', origin: 'null' },
    { 'content-type': 'application/json', origin: `http://${SITE}` },
    { 'content-type': 'text/plain', origin: `https://${SITE}` },
    { 'content-type': 'application/x-www-form-urlencoded' },
    {},
  ];
  for (const path of ['/_members/code', '/_members/verify', '/_members/signout']) {
    for (const headers of attempts) {
      const res = await request('POST', path, { headers, body: '{"email":"member@example.com","code":"ABCDEFGHJK"}' });
      assert.equal(res.status, 403, `${path} ${JSON.stringify(headers)}`);
      assert.equal(res.json.success, false);
      assert.equal(res.headers['set-cookie'], undefined);
      assert.equal(res.headers['cache-control'], 'no-store');
    }
  }
  assert.equal(upstreamCalls.length, 0);
});

test('bodies are capped at 8 KiB and must be JSON', async () => {
  const big = await request('POST', '/_members/code', { headers: JSON_POST, body: { email: 'a'.repeat(9000) } });
  assert.equal(big.status, 413);
  assert.equal(big.json.success, false);

  const broken = await request('POST', '/_members/code', { headers: JSON_POST, body: '{not json' });
  assert.equal(broken.status, 400);
  assert.equal(broken.json.error.code, 'INVALID_REQUEST');

  for (const body of [{}, { email: '' }, { email: 42 }, { email: 'a'.repeat(400) }]) {
    assert.equal((await request('POST', '/_members/code', { headers: JSON_POST, body })).status, 400);
  }
  assert.equal((await request('POST', '/_members/verify', { headers: JSON_POST, body: { email: 'member@example.com' } })).status, 400);
  assert.equal(upstreamCalls.length, 0);
});

test('/_members/session: no cookie is answered here; a cookie is forwarded as a header', async () => {
  const anonymous = await request('GET', '/_members/session');
  assert.equal(anonymous.status, 200);
  assert.deepEqual(anonymous.json, { success: true, data: { signedIn: false, firstName: null }, error: null });
  assert.equal(anonymous.headers['cache-control'], 'no-store');
  assert.equal(upstreamCalls.length, 0);

  upstreamAnswer = () => ({ status: 200, body: { success: true, data: { signedIn: true, firstName: 'Ali' }, error: null } });
  const member = await request('GET', '/_members/session', { headers: { cookie: `theme=dark; alloro_member=${TOKEN}` } });
  assert.deepEqual(member.json, { success: true, data: { signedIn: true, firstName: 'Ali' }, error: null });
  assert.equal(member.text.includes(TOKEN), false);
  assert.equal(upstreamCalls[0].method, 'GET');
  assert.equal(upstreamCalls[0].url, '/api/site-members-public/session');
  assert.equal(upstreamCalls[0].headers['x-alloro-member-token'], TOKEN);
  assert.equal(upstreamCalls[0].headers['x-alloro-renderer-secret'], SECRET);
});

test('/_members/signout revokes at the app and clears the cookie whatever the app says', async () => {
  const cleared = ['alloro_member=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure'];

  const ok = await request('POST', '/_members/signout', { headers: { ...JSON_POST, cookie: `alloro_member=${TOKEN}` }, body: {} });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.headers['set-cookie'], cleared);
  assert.equal(upstreamCalls[0].url, '/api/site-members-public/signout');
  assert.equal(upstreamCalls[0].headers['x-alloro-member-token'], TOKEN);

  upstreamAnswer = () => ({ status: 500, contentType: 'text/plain', body: 'boom' });
  const appFailed = await request('POST', '/_members/signout', { headers: { ...JSON_POST, cookie: `alloro_member=${TOKEN}` }, body: {} });
  assert.equal(appFailed.status, 200);
  assert.deepEqual(appFailed.headers['set-cookie'], cleared);

  delete process.env.SITE_MEMBERS_RENDERER_SECRET;
  const noSecret = await request('POST', '/_members/signout', { headers: { ...JSON_POST, cookie: `alloro_member=${TOKEN}` }, body: {} });
  assert.deepEqual(noSecret.headers['set-cookie'], cleared);

  upstreamCalls.length = 0;
  const noCookie = await request('POST', '/_members/signout', { headers: JSON_POST, body: {} });
  assert.deepEqual(noCookie.headers['set-cookie'], cleared);
  assert.equal(upstreamCalls.length, 0);
});

test('unknown /_members paths answer 404 JSON and are never rendered as a page', async () => {
  for (const [method, path] of [['GET', '/_members'], ['GET', '/_members/nope'], ['GET', '/_members/code'], ['DELETE', '/_members/session']]) {
    const res = await request(method, path);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.json.success, false);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  assert.equal(queried.length, 0, 'no database work for /_members');
});

// ---------------------------------------------------------------------------
// The gate inside siteRoute
// ---------------------------------------------------------------------------

const MEMBER_COOKIE = { cookie: `alloro_member=${TOKEN}` };

test('gate: a visitor with no session is sent to sign in, before anything is assembled', async () => {
  for (const [path, next] of [
    ['/base-camp', '%2Fbase-camp'],
    ['/base-camp/adc?tab=2', '%2Fbase-camp%2Fadc%3Ftab%3D2'],
    ['/portal', '%2Fportal'],
    ['/portal/assets/app.js', '%2Fportal%2Fassets%2Fapp.js'],
  ]) {
    queried.length = 0;
    const res = await request('GET', path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.location, `/member-login?next=${next}`);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers.vary, /Cookie/);
    assert.equal(res.text.includes('CONTENT_OF_'), false);
    assert.equal(res.text.includes('MEMBER_A'), false);
    assert.equal(queried.includes('header_footer_code'), false, 'no assembly query ran');
  }
});

test('gate: an unknown or expired cookie is treated as no session', async () => {
  tables.site_member_sessions = [];
  const res = await request('GET', '/base-camp', { headers: MEMBER_COOKIE });
  assert.equal(res.status, 302);
  assert.equal((await request('GET', '/base-camp', { headers: { cookie: 'alloro_member=garbage' } })).status, 302);
});

test('gate: a member is served, privately, uncached and noindex', async () => {
  tables.site_member_sessions = [{ member_id: 'm1', group_id: null }];

  const html = await request('GET', '/base-camp/adc', { headers: MEMBER_COOKIE });
  assert.equal(html.status, 200);
  assert.match(html.text, /CONTENT_OF_\/base-camp\/adc/);
  assert.equal(html.headers['cache-control'], 'private, no-store');
  assert.match(html.headers.vary, /Cookie/);
  assert.equal(html.headers['x-robots-tag'], 'noindex, nofollow');
  assert.match(html.text, /<meta name="robots" content="noindex, nofollow">/);
  assert.equal(html.text.includes('index, follow'), false);

  const artifact = await request('GET', '/portal', { headers: MEMBER_COOKIE });
  assert.equal(artifact.status, 200);
  assert.match(artifact.text, /MEMBER_APP/);
  assert.equal(artifact.headers['cache-control'], 'private, no-store');
  assert.match(artifact.text, /noindex, nofollow/);

  const asset = await request('GET', '/portal/assets/app.js', { headers: MEMBER_COOKIE });
  assert.equal(asset.status, 200);
  assert.match(asset.text, /MEMBER_ASSET/);
  assert.equal(asset.headers['cache-control'], 'private, no-store', 'a members-only file must not be cached as public');
  assert.match(asset.headers.vary, /Cookie/);
});

test('gate: a member outside the listed group gets the 403 page', async () => {
  tables.site_page_access_groups = [{ group_id: 'g-adc' }];
  tables.site_member_sessions = [{ member_id: 'm1', group_id: 'g-member' }];
  const res = await request('GET', '/base-camp', { headers: MEMBER_COOKIE });
  assert.equal(res.status, 403);
  assert.match(res.text, /This page is for another group\./);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.text.includes('CONTENT_OF_'), false);

  tables.site_member_sessions = [{ member_id: 'm1', group_id: 'g-adc' }];
  assert.equal((await request('GET', '/base-camp', { headers: MEMBER_COOKIE })).status, 200);
});

test('gate: members-only path with the switch off is a 404 for everyone', async () => {
  tables.projects[0].members_enabled = false;
  tables.site_member_sessions = [{ member_id: 'm1', group_id: null }];
  for (const path of ['/base-camp', '/base-camp/adc', '/portal', '/portal/assets/app.js']) {
    const res = await request('GET', path, { headers: MEMBER_COOKIE });
    assert.equal(res.status, 404, path);
    assert.match(res.text, /Page Not Found/);
    assert.equal(res.text.includes('CONTENT_OF_'), false);
    assert.equal(res.text.includes('MEMBER_A'), false);
  }
  assert.equal((await request('GET', '/about')).status, 200);
});

test('gate: public pages of a members-enabled site are served exactly as public pages', async () => {
  for (const path of ['/', '/about']) {
    const res = await request('GET', path, { headers: MEMBER_COOKIE });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers['cache-control'], undefined);
    assert.equal(res.headers['x-robots-tag'], undefined);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(/Cookie/.test(res.headers.vary || ''), false);
    assert.match(res.text, /index, follow/);
  }
  assert.equal(queried.includes('site_member_sessions'), false, 'no session lookup for a public page');
});

test('gate: a public artifact keeps its immutable public cache header', async () => {
  tables.site_page_access = [{ id: 'a1', path: '/base-camp' }];
  const asset = await request('GET', '/portal/assets/app.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(/Cookie/.test(asset.headers.vary || ''), false);
});

test('gate: an unknown path under a members-only path is still a plain 404', async () => {
  const res = await request('GET', '/base-camp/does-not-exist');
  assert.equal(res.status, 404);
});

test('sitemap leaves members-only pages out; robots.txt is untouched', async () => {
  const sitemap = await request('GET', '/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.text, /<loc>https:\/\/www\.members\.test\/about<\/loc>/);
  assert.equal(sitemap.text.includes('/base-camp'), false);
  assert.equal(sitemap.text.includes('/portal'), false);

  tables.site_page_access = [];
  const open = await request('GET', '/sitemap.xml');
  assert.match(open.text, /\/base-camp\/adc<\/loc>/);

  assert.match((await request('GET', '/robots.txt')).text, /Sitemap: https:\/\/www\.members\.test\/sitemap\.xml/);
});
