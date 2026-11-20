const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');

// Site members, renderer side: the pure pieces of the members-only gate, and the
// promise that a site with no members-only paths pays nothing for it.
const database = require('../dist/lib/db');
const {
  MEMBER_COOKIE_NAME,
  readMemberToken,
  buildMemberCookie,
  buildClearMemberCookie,
  isLocalHost,
  isSameSiteJsonPost,
  safeNextPath,
  buildSignInRedirect,
  resolveVisitorIp,
} = require('../dist/middleware/memberSession');
const access = require('../dist/services/member-access.service');
const { removeGatedSitemapEntries } = require('../dist/services/sitemap.service');
const { memberForbiddenPage } = require('../dist/templates/member-forbidden');

const TOKEN = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG0'; // 43 chars, base64url shape
const OTHER = 'b3RoZXItdG9rZW4tb3RoZXItdG9rZW4tb3RoZXItdG9rZW4';

// ---------------------------------------------------------------------------
// Cookie reader
// ---------------------------------------------------------------------------

test('cookie reader: accepts only a well-formed alloro_member value', () => {
  const cases = [
    [undefined, null],
    [null, null],
    ['', null],
    [`alloro_member=${TOKEN}`, TOKEN],
    [`a=1; alloro_member=${TOKEN}; b=2`, TOKEN],
    [`a=1;alloro_member=${TOKEN}`, TOKEN],
    [`  alloro_member = ${TOKEN}  `, TOKEN],
    [[`a=1`, `alloro_member=${TOKEN}`], TOKEN],
    // A cookie whose NAME merely ends with or contains ours is not ours.
    [`xalloro_member=${TOKEN}`, null],
    [`alloro_member_old=${TOKEN}`, null],
    [`ALLORO_MEMBER=${TOKEN}`, null],
    // Malformed values are skipped, never repaired.
    ['alloro_member=short', null],
    [`alloro_member="${TOKEN}"`, null],
    [`alloro_member=${TOKEN}%3D`, null],
    [`alloro_member=${'a'.repeat(201)}`, null],
    ['alloro_member=', null],
    ['alloro_member', null],
    [';;;=;==;', null],
    // The first well-formed value wins; a malformed duplicate before it is skipped.
    [`alloro_member=bad; alloro_member=${TOKEN}`, TOKEN],
    [`alloro_member=${TOKEN}; alloro_member=${OTHER}`, TOKEN],
    // Boundaries of the accepted length.
    [`alloro_member=${'a'.repeat(19)}`, null],
    [`alloro_member=${'a'.repeat(20)}`, 'a'.repeat(20)],
    [`alloro_member=${'a'.repeat(200)}`, 'a'.repeat(200)],
  ];
  for (const [header, expected] of cases) {
    assert.equal(readMemberToken(header), expected, JSON.stringify(header));
  }
});

// ---------------------------------------------------------------------------
// Cookie writer
// ---------------------------------------------------------------------------

test('cookie writer: host-only, httpOnly, Lax, 30 days, Secure except on a local host', () => {
  assert.equal(MEMBER_COOKIE_NAME, 'alloro_member');
  const base = `alloro_member=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
  const cases = [
    ['www.victorvalor.org', `${base}; Secure`],
    ['practice.sites.getalloro.com', `${base}; Secure`],
    ['www.victorvalor.org:443', `${base}; Secure`],
    ['notlocalhost', `${base}; Secure`],
    ['evil-localhost.com', `${base}; Secure`],
    [undefined, `${base}; Secure`],
    ['localhost', base],
    ['localhost:7777', base],
    ['127.0.0.1:7777', base],
    ['alloro-test-0123456789ab-01234567.localhost:54321', base],
    ['Alloro-Test.LOCALHOST', base],
  ];
  for (const [host, expected] of cases) {
    const cookie = buildMemberCookie(TOKEN, host);
    assert.equal(cookie, expected, String(host));
    assert.doesNotMatch(cookie, /domain=/i, 'the cookie must stay host-only');
  }
  assert.equal(isLocalHost('a.localhost'), true);
  assert.equal(isLocalHost('localhost.example.com'), false);
});

test('cookie writer: refuses a token that is not the expected shape', () => {
  for (const bad of ['', 'short', `${TOKEN}; Domain=evil.test`, `${TOKEN}\r\nSet-Cookie: x=1`, 'a b c d e f g h i j k l m n']) {
    assert.throws(() => buildMemberCookie(bad, 'site.test'), /Invalid member session token/);
  }
});

test('cookie writer: the clearing cookie carries the same attributes with Max-Age=0', () => {
  assert.equal(buildClearMemberCookie('www.site.test'), 'alloro_member=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
  assert.equal(buildClearMemberCookie('x.localhost:9000'), 'alloro_member=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
});

// ---------------------------------------------------------------------------
// Cross-site POST check
// ---------------------------------------------------------------------------

test('cross-site check: JSON content type required, Origin must be this host when present', () => {
  const json = 'application/json';
  const cases = [
    // [origin, host, contentType, allowed]
    ['https://www.site.test', 'www.site.test', json, true],
    ['https://www.site.test', 'www.site.test', 'application/json; charset=utf-8', true],
    ['https://WWW.SITE.TEST', 'www.site.test', 'Application/JSON', true],
    [undefined, 'www.site.test', json, true],
    ['', 'www.site.test', json, true],
    // Wrong or missing content type: the form-post shapes a cross-site page can send.
    ['https://www.site.test', 'www.site.test', undefined, false],
    ['https://www.site.test', 'www.site.test', 'text/plain', false],
    ['https://www.site.test', 'www.site.test', 'application/x-www-form-urlencoded', false],
    ['https://www.site.test', 'www.site.test', 'multipart/form-data; boundary=x', false],
    ['https://www.site.test', 'www.site.test', 'application/json-seq', false],
    ['https://www.site.test', 'www.site.test', 'text/plain; application/json', false],
    [undefined, 'www.site.test', 'text/plain', false],
    // Another origin.
    ['https://evil.test', 'www.site.test', json, false],
    ['https://site.test', 'www.site.test', json, false],
    ['https://www.site.test.evil.test', 'www.site.test', json, false],
    ['https://www.site.test:8443', 'www.site.test', json, false],
    ['null', 'www.site.test', json, false],
    ['not a url', 'www.site.test', json, false],
    ['https://www.site.test', '', json, false],
    ['https://www.site.test', undefined, json, false],
    // Plain http is this site only on a local host.
    ['http://www.site.test', 'www.site.test', json, false],
    ['http://x.localhost:7777', 'x.localhost:7777', json, true],
    ['http://x.localhost:7777', 'x.localhost:8888', json, false],
    ['http://127.0.0.1:7777', '127.0.0.1:7777', json, true],
  ];
  for (const [origin, host, contentType, allowed] of cases) {
    assert.equal(isSameSiteJsonPost({ origin, host, contentType }), allowed, JSON.stringify([origin, host, contentType]));
  }
});

// ---------------------------------------------------------------------------
// next
// ---------------------------------------------------------------------------

test('next: only a plain path on this site survives', () => {
  const cases = [
    ['/base-camp', '/base-camp'],
    ['/base-camp/adc?tab=2', '/base-camp/adc?tab=2'],
    ['/', '/'],
    [undefined, '/'],
    [null, '/'],
    [42, '/'],
    ['', '/'],
    ['base-camp', '/'],
    ['//evil.test', '/'],
    ['/\\evil.test', '/'],
    ['/a//b', '/'],
    ['https://evil.test/', '/'],
    ['/go?to=https://evil.test', '/'],
    ['/a%2f%2fevil.test', '/'],
    ['/a%5Cevil', '/'],
    ['/a b', '/'],
    ['/a\nb', '/'],
    ['/café', '/'],
    ['/' + 'a'.repeat(512), '/'],
    ['/' + 'a'.repeat(511), '/' + 'a'.repeat(511)],
  ];
  for (const [input, expected] of cases) assert.equal(safeNextPath(input), expected, JSON.stringify(input));
});

test('sign-in redirect: next is the encoded path and query, and never another host', () => {
  const cases = [
    ['/base-camp', '', '/member-login?next=%2Fbase-camp'],
    ['/base-camp/adc', '?tab=2&x=a%20b', '/member-login?next=%2Fbase-camp%2Fadc%3Ftab%3D2%26x%3Da%2520b'],
    ['/', '', '/member-login?next=%2F'],
    ['/base-camp/', '', '/member-login?next=%2Fbase-camp%2F'],
    // Leading slashes collapse, so the value cannot name a host.
    ['//evil.test/x', '', '/member-login?next=%2Fevil.test%2Fx'],
    // A query the app would refuse is dropped; the page is kept.
    ['/base-camp', '?r=%2F%2Fevil.test', '/member-login?next=%2Fbase-camp'],
    ['/base-camp', '?q=' + 'a'.repeat(600), '/member-login?next=%2Fbase-camp'],
    ['/base-camp', 'not-a-query', '/member-login?next=%2Fbase-camp'],
  ];
  for (const [path, search, expected] of cases) {
    const location = buildSignInRedirect(path, search);
    assert.equal(location, expected, JSON.stringify([path, search]));
    const next = new URL(location, 'https://site.test').searchParams.get('next');
    assert.equal(new URL(next, 'https://site.test').host, 'site.test');
  }
});

// ---------------------------------------------------------------------------
// Visitor address
// ---------------------------------------------------------------------------

test('visitor address: the proxy-appended entry only when the peer is loopback', () => {
  const cases = [
    ['127.0.0.1', '203.0.113.9', '203.0.113.9'],
    ['::1', '203.0.113.9', '203.0.113.9'],
    ['::ffff:127.0.0.1', '198.51.100.1, 203.0.113.9', '203.0.113.9'],
    // The left-most entries are client-supplied and never win.
    ['127.0.0.1', '1.1.1.1, 2.2.2.2 , 203.0.113.9', '203.0.113.9'],
    ['127.0.0.1', ['1.1.1.1', '203.0.113.9'], '203.0.113.9'],
    ['127.0.0.1', '2001:db8::1', '2001:db8::1'],
    ['127.0.0.1', undefined, '127.0.0.1'],
    ['127.0.0.1', 'garbage', '127.0.0.1'],
    ['127.0.0.1', '203.0.113.9, <script>', '127.0.0.1'],
    // A direct (non-loopback) peer is reported as itself; its header is ignored.
    ['203.0.113.50', '9.9.9.9', '203.0.113.50'],
    [undefined, '9.9.9.9', null],
    ['', undefined, null],
  ];
  for (const [socket, forwarded, expected] of cases) {
    assert.equal(resolveVisitorIp(socket, forwarded), expected, JSON.stringify([socket, forwarded]));
  }
});

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

test('path matching: exact path or a prefix at a "/" boundary, longest wins', () => {
  const gated = ['/base-camp', '/base-camp/adc', '/portal/', '/'];
  const cases = [
    ['/base-camp', '/base-camp'],
    ['/base-camp/', '/base-camp'],
    ['/base-camp/asset.js', '/base-camp'],
    ['/base-camp/assets/index-abc.js', '/base-camp'],
    ['/base-camp/adc', '/base-camp/adc'],
    ['/base-camp/adc/', '/base-camp/adc'],
    ['/base-camp/adc/file.pdf', '/base-camp/adc'],
    ['/base-camp/adcx', '/base-camp'],
    // Not a "/" boundary: a different page that merely starts with the same letters.
    ['/base-camp-news', null],
    ['/base-campus/x', null],
    ['/base', null],
    ['/Base-Camp', null],
    ['/other/base-camp', null],
    // A stored path with a trailing slash matches the same way.
    ['/portal', '/portal/'],
    ['/portal/x', '/portal/'],
    ['/portals', null],
    // A members-only home page covers the home page only, never the whole site.
    ['/', '/'],
    ['/about', null],
    // Never members-only, whatever the rows say.
    ['/member-login', null],
    ['/member-login/', null],
    ['/member-apply', null],
    ['/_members/session', null],
    ['/_members', null],
    ['/robots.txt', null],
    ['/sitemap.xml', null],
    ['/favicon.ico', null],
    ['/success', null],
  ];
  for (const [path, expected] of cases) assert.equal(access.matchGatedPath(gated, path), expected, path);

  assert.equal(access.matchGatedPath([], '/base-camp'), null);
  assert.equal(access.matchGatedPath(['base-camp', '', null, 7], '/base-camp'), null, 'malformed rows never match');
  // The never-gated list holds even when a row names one of those paths or a parent of it.
  assert.equal(access.matchGatedPath(['/member-login', '/_members', '/success'], '/member-login'), null);
  assert.equal(access.matchGatedPath(['/member-login'], '/member-login/x'), '/member-login');
});

// ---------------------------------------------------------------------------
// decideGate
// ---------------------------------------------------------------------------

test('decideGate: the full truth table', () => {
  const open = { gatedPath: '/base-camp', groupIds: [] };
  const adc = { gatedPath: '/base-camp/adc', groupIds: ['g-adc'] };
  const either = { gatedPath: '/x', groupIds: ['g-adc', 'g-staff'] };
  const noGroups = { memberId: 'm1', groupIds: [] };
  const inMember = { memberId: 'm2', groupIds: ['g-member'] };
  const inAdc = { memberId: 'm3', groupIds: ['g-member', 'g-adc'] };
  const inStaff = { memberId: 'm4', groupIds: ['g-staff'] };

  const cases = [
    // [access, isMembersEnabled, member, decision]
    // Not members-only: always open, whatever else is true.
    [null, false, null, 'open'],
    [null, true, null, 'open'],
    [null, false, inAdc, 'open'],
    [null, true, inAdc, 'open'],
    // Members-only with the switch off: 404 for everyone, signed in or not.
    [open, false, null, 'not-found'],
    [open, false, inAdc, 'not-found'],
    [adc, false, null, 'not-found'],
    [adc, false, inAdc, 'not-found'],
    // Members-only, switch on, no valid session.
    [open, true, null, 'sign-in'],
    [adc, true, null, 'sign-in'],
    [either, true, null, 'sign-in'],
    // No groups listed: every active member.
    [open, true, noGroups, 'allow'],
    [open, true, inMember, 'allow'],
    [open, true, inAdc, 'allow'],
    // Groups listed: the member must be in at least one of them.
    [adc, true, noGroups, 'forbidden'],
    [adc, true, inMember, 'forbidden'],
    [adc, true, inAdc, 'allow'],
    [adc, true, inStaff, 'forbidden'],
    [either, true, inMember, 'forbidden'],
    [either, true, inAdc, 'allow'],
    [either, true, inStaff, 'allow'],
    [either, true, noGroups, 'forbidden'],
  ];
  for (const [pageAccess, isMembersEnabled, member, expected] of cases) {
    assert.equal(
      access.decideGate({ access: pageAccess, isMembersEnabled, member }),
      expected,
      JSON.stringify([pageAccess, isMembersEnabled, member])
    );
  }
});

test('session token hash: SHA-256 of the raw token, hex (what the app stores)', () => {
  // Independent of the implementation: the published SHA-256 of "abc".
  assert.equal(access.hashSessionToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.match(access.hashSessionToken(TOKEN), /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// noindex + sitemap
// ---------------------------------------------------------------------------

test('noindex: every robots meta is replaced by one noindex tag', () => {
  const html = '<html><head><title>T</title><meta name="robots" content="index, follow">\n<META NAME=robots CONTENT="max-image-preview:large" /></head><body>B</body></html>';
  const out = access.forceNoindex(html);
  assert.equal(out.match(/name=["']?robots/gi).length, 1);
  assert.match(out, /<meta name="robots" content="noindex, nofollow">\n<\/head>/);
  assert.match(out, /<title>T<\/title>/);
  assert.match(out, /<body>B<\/body>/);
  // A "$" in the page must not be read as a replacement pattern.
  assert.match(access.forceNoindex("<head></head><p>$& $' $1</p>"), /<p>\$& \$' \$1<\/p>/);
  assert.equal(access.forceNoindex('<p>no head</p>'), '<p>no head</p>');
});

test('the 403 page says why, in plain words, and is never indexed', () => {
  const html = memberForbiddenPage('Victor & <Valor>');
  assert.match(html, /This page is for another group\./);
  assert.match(html, /href="\/"/);
  assert.match(html, /Sign out/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /<title>Victor &amp; &lt;Valor&gt; - Members Only<\/title>/);
});

function sitemap(paths) {
  const blocks = paths
    .map(([path, lastmod]) => `  <url>\n    <loc>https://www.site.test${path}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${blocks}\n</urlset>\n`;
}

test('sitemap: members-only paths and everything under them are left out', () => {
  const full = sitemap([['/', '2026-11-01'], ['/about', null], ['/base-camp', '2026-11-02'], ['/base-camp/adc', null], ['/base-camp-news', null], ['/articles/a&amp;b', '2026-11-03']]);
  assert.equal(
    removeGatedSitemapEntries(full, 'www.site.test', ['/base-camp']),
    sitemap([['/', '2026-11-01'], ['/about', null], ['/base-camp-news', null], ['/articles/a&amp;b', '2026-11-03']])
  );
  // A members-only home page leaves only the home page out.
  assert.equal(
    removeGatedSitemapEntries(full, 'www.site.test', ['/']),
    sitemap([['/about', null], ['/base-camp', '2026-11-02'], ['/base-camp/adc', null], ['/base-camp-news', null], ['/articles/a&amp;b', '2026-11-03']])
  );
  // An escaped path is compared unescaped.
  assert.equal(removeGatedSitemapEntries(full, 'www.site.test', ['/articles/a&b']).includes('a&amp;b'), false);
  // Everything members-only: a valid, empty url set.
  assert.equal(
    removeGatedSitemapEntries(sitemap([['/base-camp', null]]), 'www.site.test', ['/base-camp']),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n'
  );
});

test('sitemap: with no members-only paths the XML is returned untouched (same string)', () => {
  const full = sitemap([['/', '2026-11-01'], ['/base-camp', null]]);
  assert.equal(removeGatedSitemapEntries(full, 'www.site.test', []), full);
  assert.equal(removeGatedSitemapEntries(full, 'www.site.test', ['/elsewhere']), full);
});

// ---------------------------------------------------------------------------
// The gate against a recorded database: what is queried, and what is not
// ---------------------------------------------------------------------------

const calls = [];
let tables = {};
let failWith = null;

function fakeDb(table) {
  const name = String(table).replace(/^website_builder\./, '').replace(/ as \w+$/, '');
  const chain = {
    where: () => chain,
    whereNull: () => chain,
    join: () => chain,
    leftJoin: () => chain,
    select: () => chain,
    first: async () => {
      calls.push(name);
      if (failWith) throw failWith;
      return (tables[name] || [])[0];
    },
    then: (resolve, reject) => {
      calls.push(name);
      if (failWith) return Promise.reject(failWith).then(resolve, reject);
      return Promise.resolve(tables[name] || []).then(resolve, reject);
    },
  };
  for (const method of ['insert', 'update', 'del', 'delete', 'truncate', 'increment', 'decrement', 'upsert', 'merge']) {
    chain[method] = () => { throw new Error(`The renderer must never ${method} member data.`); };
  }
  return chain;
}
fakeDb.fn = { now: () => 'now()' };
database.getDb = () => fakeDb;

beforeEach(() => {
  calls.length = 0;
  tables = {};
  failWith = null;
  access.resetMemberAccessMemo();
});

function tokenReader(token) {
  const reader = () => { reader.reads += 1; return token; };
  reader.reads = 0;
  return reader;
}

test('zero cost for an ordinary site: switch off + no access rows = one probe a minute, then nothing', async () => {
  const project = { id: 'plain-site', members_enabled: false };
  const reader = tokenReader(TOKEN);

  assert.deepEqual(await access.resolveMemberGate(project, '/about', reader), { decision: 'open', access: null });
  assert.deepEqual(calls, ['site_page_access'], 'the first request asks once whether the site has any members-only path');

  calls.length = 0;
  for (const path of ['/', '/about', '/base-camp', '/tools/assets/app.js', '/articles/post']) {
    assert.deepEqual(await access.resolveMemberGate(project, path, reader), { decision: 'open', access: null });
  }
  assert.deepEqual(await access.listGatedPaths(project), []);
  assert.deepEqual(calls, [], 'no database call at all while the memo holds');
  assert.equal(reader.reads, 0, 'the cookie is never read for a public page');

  // A project row from before the app migration has no members_enabled at all: same as off.
  assert.deepEqual(await access.resolveMemberGate({ id: 'plain-site' }, '/about', reader), { decision: 'open', access: null });
  assert.deepEqual(calls, []);
});

test('the memo is per site and lasts 60 seconds', async () => {
  const now = 1_000_000;
  assert.equal(await access.hasAnyPageAccess('site-a', now), false);
  assert.equal(await access.hasAnyPageAccess('site-a', now + 59_999), false);
  assert.deepEqual(calls, ['site_page_access']);
  assert.equal(await access.hasAnyPageAccess('site-b', now), false);
  assert.equal(calls.length, 2);
  tables.site_page_access = [{ id: 'a1', path: '/base-camp' }];
  assert.equal(await access.hasAnyPageAccess('site-a', now + 60_000), true, 'asked again once the minute is up');
  assert.equal(calls.length, 3);
});

test('never-gated paths skip every lookup, even on a members-enabled site', async () => {
  tables.site_page_access = [{ id: 'a1', path: '/member-login' }, { id: 'a2', path: '/success' }];
  const reader = tokenReader(TOKEN);
  for (const path of ['/member-login', '/member-apply', '/_members/session', '/success', '/robots.txt', '/sitemap.xml', '/favicon.ico']) {
    assert.deepEqual(await access.resolveMemberGate({ id: 'p', members_enabled: true }, path, reader), { decision: 'open', access: null }, path);
  }
  assert.deepEqual(calls, []);
  assert.equal(reader.reads, 0);
});

test('members-only path with the switch off: 404, with no cookie read and no session query', async () => {
  tables.site_page_access = [{ id: 'a1', path: '/base-camp' }];
  const reader = tokenReader(TOKEN);
  const result = await access.resolveMemberGate({ id: 'p', members_enabled: false }, '/base-camp/asset.js', reader);
  assert.equal(result.decision, 'not-found');
  assert.equal(reader.reads, 0);
  assert.equal(calls.includes('site_member_sessions'), false);
  // A public page of the same site stays open.
  assert.equal((await access.resolveMemberGate({ id: 'p', members_enabled: false }, '/about', reader)).decision, 'open');
});

test('members-enabled site: public page does no cookie work; members-only page checks the session', async () => {
  const project = { id: 'p', members_enabled: true };
  tables.site_page_access = [{ id: 'a1', path: '/base-camp' }, { id: 'a2', path: '/base-camp/adc' }];
  tables.site_page_access_groups = [{ group_id: 'g-adc' }];

  const publicReader = tokenReader(TOKEN);
  assert.equal((await access.resolveMemberGate(project, '/about', publicReader)).decision, 'open');
  assert.equal(publicReader.reads, 0);
  assert.deepEqual(calls, ['site_page_access']);

  // No cookie: sign-in, and the session table is not queried.
  calls.length = 0;
  assert.equal((await access.resolveMemberGate(project, '/base-camp/adc', tokenReader(null))).decision, 'sign-in');
  assert.equal(calls.includes('site_member_sessions'), false);

  // A cookie that matches no live session: sign-in.
  tables.site_member_sessions = [];
  assert.equal((await access.resolveMemberGate(project, '/base-camp/adc', tokenReader(TOKEN))).decision, 'sign-in');

  // A member outside the group: forbidden. Inside it: allow.
  tables.site_member_sessions = [{ member_id: 'm1', group_id: 'g-member' }];
  assert.equal((await access.resolveMemberGate(project, '/base-camp/adc', tokenReader(TOKEN))).decision, 'forbidden');
  tables.site_member_sessions = [{ member_id: 'm1', group_id: 'g-member' }, { member_id: 'm1', group_id: 'g-adc' }];
  const allowed = await access.resolveMemberGate(project, '/base-camp/adc/', tokenReader(TOKEN));
  assert.deepEqual(allowed, { decision: 'allow', access: { gatedPath: '/base-camp/adc', groupIds: ['g-adc'] } });

  // A member in no group at all still opens a path that lists no groups.
  tables.site_page_access_groups = [];
  tables.site_member_sessions = [{ member_id: 'm9', group_id: null }];
  assert.deepEqual(await access.getMemberForSession('p', access.hashSessionToken(TOKEN)), { memberId: 'm9', groupIds: [] });
  assert.equal((await access.resolveMemberGate(project, '/base-camp', tokenReader(TOKEN))).decision, 'allow');
});

test('a hash that is not 64 hex characters is never sent to the database', async () => {
  assert.equal(await access.getMemberForSession('p', TOKEN), null);
  assert.equal(await access.getMemberForSession('p', ''), null);
  assert.deepEqual(calls, []);
});

test('tables not deployed yet (42P01): nothing is members-only, warned once', async () => {
  failWith = Object.assign(new Error('relation "website_builder.site_page_access" does not exist'), { code: '42P01' });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    for (const enabled of [true, false, undefined]) {
      access.resetMemberAccessMemo();
      const result = await access.resolveMemberGate({ id: 'p', members_enabled: enabled }, '/base-camp', tokenReader(TOKEN));
      assert.deepEqual(result, { decision: 'open', access: null });
    }
    assert.deepEqual(await access.listGatedPaths({ id: 'p', members_enabled: true }), []);
    assert.equal(await access.getMemberForSession('p', access.hashSessionToken(TOKEN)), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.length <= 1, 'at most one warning per process');
  for (const line of warnings) assert.equal(line.includes(TOKEN), false);
});

test('any other database error is thrown, never read as "public"', async () => {
  failWith = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  await assert.rejects(access.resolveMemberGate({ id: 'p', members_enabled: true }, '/base-camp', tokenReader(TOKEN)), /connection refused/);
  await assert.rejects(access.resolveMemberGate({ id: 'q', members_enabled: false }, '/base-camp', tokenReader(TOKEN)), /connection refused/);
  await assert.rejects(access.getMemberForSession('p', access.hashSessionToken(TOKEN)), /connection refused/);
});
