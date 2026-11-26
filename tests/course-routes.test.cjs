const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { after, before, beforeEach, test } = require('node:test');
const express = require('express');

// Member courses over HTTP (getAlloro/alloro plans/11192026-site-courses-library, T6): the
// same-origin /_members/courses and /_members/lessons routes against a stand-in for the Alloro
// app. The app decides everything; these routes check the address's shape, forward the session
// cookie's token with the secret, and pass the answer through, private and uncached.
// Nothing here connects to a real database, Redis or app.

const TOKEN = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG0';
const SECRET = 'test-renderer-secret';
const SITE = 'www.members.test';
const POST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const upstreamCalls = [];
let upstreamAnswer = () => ({ status: 200, body: { success: true, data: {}, error: null } });
let appServer;
let server;

before(async () => {
  appServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      upstreamCalls.push(call);
      const answer = upstreamAnswer(call);
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  process.env.API_BASE_URL = `http://127.0.0.1:${appServer.address().port}`;

  const { extractSubdomain } = require('../dist/middleware/subdomain');
  const { membersRouter } = require('../dist/routes/members');
  const app = express();
  app.use(extractSubdomain);
  app.use(membersRouter);
  app.use((_req, res) => { res.status(599).send('fell through to the site route'); });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

after(() => {
  server.close();
  appServer.closeAllConnections();
  appServer.close();
});

beforeEach(() => {
  upstreamCalls.length = 0;
  upstreamAnswer = () => ({ status: 200, body: { success: true, data: {}, error: null } });
  process.env.SITE_MEMBERS_RENDERER_SECRET = SECRET;
});

function request(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    // A browser sends a length with every body; without one Node's client chunks a DELETE body.
    const length = payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) };
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers: { host: SITE, ...length, ...headers } }, (res) => {
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
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const COOKIE = { cookie: `alloro_member=${TOKEN}` };
const JSON_WRITE = { ...COOKIE, 'content-type': 'application/json', origin: `https://${SITE}` };

function assertPrivate(res, where) {
  assert.equal(res.headers['cache-control'], 'private, no-store', where);
  assert.match(String(res.headers.vary || ''), /Cookie/i, where);
}

test('each route asks the app once, with the secret, the site host and the session token, never a member id', async () => {
  const cases = [
    ['GET', '/_members/courses', '/api/site-members-public/courses/list', {}],
    ['GET', '/_members/courses/first-aid', '/api/site-members-public/courses/outline', { slug: 'first-aid' }],
    ['GET', `/_members/lessons/${POST_ID}`, '/api/site-members-public/lessons/state', { postId: POST_ID }],
    ['POST', `/_members/lessons/${POST_ID}/done`, '/api/site-members-public/lessons/done', { postId: POST_ID }],
    ['DELETE', `/_members/lessons/${POST_ID}/done`, '/api/site-members-public/lessons/undo', { postId: POST_ID }],
  ];
  for (const [method, path, upstreamPath, upstreamBody] of cases) {
    upstreamCalls.length = 0;
    const isWrite = method !== 'GET';
    const res = await request(method, path, {
      headers: isWrite ? JSON_WRITE : COOKIE,
      body: isWrite ? { memberId: 'someone-else', postId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } : undefined,
    });
    assert.equal(res.status, 200, path);
    assertPrivate(res, path);
    assert.equal(upstreamCalls.length, 1, path);
    const call = upstreamCalls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, upstreamPath);
    assert.equal(call.headers['x-alloro-renderer-secret'], SECRET);
    assert.equal(call.headers['x-alloro-site-host'], SITE);
    assert.equal(call.headers['x-alloro-member-token'], TOKEN);
    assert.deepEqual(call.body, upstreamBody, `${path}: only the id from the address is forwarded`);
  }
});

test('a post id is read case-blind from the address', async () => {
  await request('GET', `/_members/lessons/${POST_ID.toUpperCase()}`, { headers: COOKIE });
  assert.deepEqual(upstreamCalls[0].body, { postId: POST_ID });
});

test('the app is asked without a cookie too, so courses off answers 404 the same for everyone', async () => {
  upstreamAnswer = () => ({ status: 404, body: { success: false, data: null, error: { code: 'SITE_MEMBERS_COURSES_NOT_FOUND', message: 'Courses are not available on this website.' } } });
  const res = await request('GET', '/_members/courses');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'SITE_MEMBERS_COURSES_NOT_FOUND');
  assert.equal(upstreamCalls[0].headers['x-alloro-member-token'], undefined);
});

test('refusals pass through with their status', async () => {
  for (const status of [401, 404, 429]) {
    upstreamAnswer = () => ({ status, body: { success: false, data: null, error: { code: 'X', message: 'Refused.' } } });
    const res = await request('POST', `/_members/lessons/${POST_ID}/done`, { headers: JSON_WRITE, body: {} });
    assert.equal(res.status, status);
    assert.equal(res.json.success, false);
    assertPrivate(res, String(status));
  }
});

test('a slug or post id that is not one is a 404 here, and the app is never asked', async () => {
  const bad = [
    ['GET', '/_members/courses/Not_A_Slug'],
    ['GET', `/_members/courses/${'a'.repeat(121)}`],
    ['GET', '/_members/courses/a--b'],
    ['GET', '/_members/lessons/not-a-post'],
    ['POST', '/_members/lessons/not-a-post/done'],
    ['DELETE', '/_members/lessons/123/done'],
  ];
  for (const [method, path] of bad) {
    const res = await request(method, path, { headers: method === 'GET' ? COOKIE : JSON_WRITE, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 404, path);
    assert.equal(res.json.success, false, path);
  }
  assert.equal(upstreamCalls.length, 0);
});

test('a cross-site done or undo is refused before the app is asked', async () => {
  const attempts = [
    { ...COOKIE, 'content-type': 'application/json', origin: 'https://evil.test' },
    { ...COOKIE, 'content-type': 'text/plain', origin: `https://${SITE}` },
    { ...COOKIE },
  ];
  for (const method of ['POST', 'DELETE']) {
    for (const headers of attempts) {
      const res = await request(method, `/_members/lessons/${POST_ID}/done`, { headers, body: '{}' });
      assert.equal(res.status, 403, `${method} ${JSON.stringify(headers)}`);
    }
  }
  assert.equal(upstreamCalls.length, 0);
});

test('no secret configured: 503 and the app is never asked', async () => {
  delete process.env.SITE_MEMBERS_RENDERER_SECRET;
  const res = await request('GET', '/_members/courses', { headers: COOKIE });
  assert.equal(res.status, 503);
  assert.equal(upstreamCalls.length, 0);
});

test('a GET on the done address, or any other courses path, is not a page', async () => {
  for (const path of [`/_members/lessons/${POST_ID}/done`, '/_members/courses/first-aid/extra']) {
    const res = await request('GET', path, { headers: COOKIE });
    assert.equal(res.status, 404, path);
    assert.equal(res.json.success, false);
  }
  assert.equal(upstreamCalls.length, 0);
});
