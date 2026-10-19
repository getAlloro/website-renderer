const assert = require('node:assert/strict');
const { after, beforeEach, test } = require('node:test');

// {{ form_block id='<uuid>' }} is swapped for the published markup of that form.
// The markup is written by the Alloro app at publish time and goes in verbatim;
// an unknown id renders nothing and is cached as '' so it is not re-queried on
// every request. A DB failure strips the tokens instead of taking the page down.

const database = require('../dist/lib/db');
const redis = require('../dist/lib/redis');

const FORM_A = '11111111-1111-4111-8111-111111111111';
const FORM_B = '22222222-2222-4222-8222-222222222222';
const UNKNOWN = '33333333-3333-4333-8333-333333333333';
const PROJECT = 'project-1';

// Form markup carries $$, $& and $' so a string replacement would corrupt it.
const MARKUP_A = `<div class="alloro-form-block" data-form-block="${FORM_A}"><form data-form-id="${FORM_A}"><p>From $$ and $' and $&amp;</p></form></div>`;
const MARKUP_B = `<div class="alloro-form-block" data-form-block="${FORM_B}"><form data-form-id="${FORM_B}"></form></div>`;

let rows = [];
let queries = [];
let cache = {};
let dbFails = false;
let redisFails = false;
let warnings = [];
let errors = [];

function query(table) {
  const q = { table, join: null, where: [], whereIn: null, select: null };
  queries.push(q);
  const chain = {
    join: (...args) => { q.join = args; return chain; },
    where: (col, val) => { q.where.push([col, val]); return chain; },
    whereIn: (col, vals) => { q.whereIn = [col, vals]; return chain; },
    select: (...cols) => { q.select = cols; return chain; },
    then: (resolve, reject) =>
      (dbFails ? Promise.reject(new Error('db down')) : Promise.resolve(rows)).then(resolve, reject),
  };
  return chain;
}

const redisMock = {
  get: async (key) => {
    if (redisFails) throw new Error('redis down');
    return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
  },
  set: async (key, value, mode, ttl) => {
    if (redisFails) throw new Error('redis down');
    cache[key] = value;
    cache[`${key}:ttl`] = `${mode}:${ttl}`;
  },
};

const originalDb = database.getDb;
const originalRedis = redis.getRedis;
const originalWarn = console.warn;
const originalError = console.error;
database.getDb = () => query;
redis.getRedis = () => redisMock;
console.warn = (...args) => warnings.push(args.join(' '));
console.error = (...args) => errors.push(args.join(' '));
after(() => {
  database.getDb = originalDb;
  redis.getRedis = originalRedis;
  console.warn = originalWarn;
  console.error = originalError;
});

beforeEach(() => {
  rows = [];
  queries = [];
  cache = {};
  dbFails = false;
  redisFails = false;
  warnings = [];
  errors = [];
});

const {
  FORM_BLOCK_SHORTCODE_REGEX,
  parseFormBlockShortcodes,
  hasFormBlockShortcodes,
} = require('../dist/utils/shortcodes');
const { resolveFormBlocks, FORM_BLOCK_TTL } = require('../dist/services/form.service');
const { renderPage } = require('../dist/utils/renderer');

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------
// shortcodes.ts
// ---------------------------------------------------------------------

test('the regex spells the token the same way as the app', () => {
  assert.equal(String(FORM_BLOCK_SHORTCODE_REGEX), String(/\{\{\s*form_block\s+id='([0-9a-f-]{36})'\s*\}\}/gi));
});

test('parseFormBlockShortcodes returns one entry per distinct id, lower-cased', () => {
  const html = [
    `{{ form_block id='${FORM_A}' }}`,
    `{{form_block id='${FORM_A.toUpperCase()}'}}`, // same id, other spelling
    `{{   FORM_BLOCK   id='${FORM_B}'   }}`,
    "{{ form_block kind='contact' }}", // template-only token, not an id token
    "{{ post_block id='services' items='services' }}",
    "{{ form_block id='not-a-uuid' }}",
  ].join('\n');

  const parsed = parseFormBlockShortcodes(html);
  assert.deepEqual(parsed, [
    { raw: `{{ form_block id='${FORM_A}' }}`, id: FORM_A },
    { raw: `{{   FORM_BLOCK   id='${FORM_B}'   }}`, id: FORM_B },
  ]);
  // The parser is re-entrant: a second call sees the same tokens.
  assert.equal(parseFormBlockShortcodes(html).length, 2);
  assert.deepEqual(parseFormBlockShortcodes('<p>no tokens</p>'), []);
});

test('hasFormBlockShortcodes is the cheap pre-check', () => {
  assert.equal(hasFormBlockShortcodes(`<p>{{ form_block id='${FORM_A}' }}</p>`), true);
  assert.equal(hasFormBlockShortcodes("<p>{{ post_block id='x' items='y' }}</p>"), false);
});

// ---------------------------------------------------------------------
// form.service.ts
// ---------------------------------------------------------------------

test('html without a token comes back unchanged and touches nothing', async () => {
  const html = "<main>{{ post_block id='services' items='services' }}</main>";
  assert.equal(await resolveFormBlocks(html, PROJECT), html);
  assert.equal(queries.length, 0);
  assert.deepEqual(cache, {});
});

test('known ids are fetched in one scoped query and replaced verbatim, every occurrence', async () => {
  rows = [
    { id: FORM_A, rendered_html: MARKUP_A },
    { id: FORM_B, rendered_html: MARKUP_B },
  ];
  const html = `<main>BEFORE {{ form_block id='${FORM_A}' }} MID {{form_block id='${FORM_B}'}} AGAIN {{ form_block id='${FORM_A.toUpperCase()}' }} AFTER</main>`;

  const out = await resolveFormBlocks(html, PROJECT);

  assert.equal(out, `<main>BEFORE ${MARKUP_A} MID ${MARKUP_B} AGAIN ${MARKUP_A} AFTER</main>`);
  assert.doesNotMatch(out, /form_block/);

  assert.equal(queries.length, 1);
  const [q] = queries;
  assert.equal(q.table, 'forms as f');
  assert.deepEqual(q.join, ['form_versions as v', 'v.id', 'f.published_version_id']);
  assert.deepEqual(q.where, [['f.project_id', PROJECT], ['f.status', 'active']]);
  assert.deepEqual(q.whereIn, ['f.id', [FORM_A, FORM_B]]);
  assert.deepEqual(q.select, ['f.id', 'v.rendered_html']);

  assert.equal(cache[`form:${PROJECT}:${FORM_A}`], MARKUP_A);
  assert.equal(cache[`form:${PROJECT}:${FORM_B}`], MARKUP_B);
  assert.equal(FORM_BLOCK_TTL, 60);
  assert.equal(cache[`form:${PROJECT}:${FORM_A}:ttl`], 'EX:60');
  assert.deepEqual(warnings, []);
});

test('a cached form is served without a query', async () => {
  cache[`form:${PROJECT}:${FORM_A}`] = MARKUP_A;
  const out = await resolveFormBlocks(`<p>{{ form_block id='${FORM_A}' }}</p>`, PROJECT);
  assert.equal(out, `<p>${MARKUP_A}</p>`);
  assert.equal(queries.length, 0);
});

test('a cache hit and a cache miss on the same page query only the miss', async () => {
  cache[`form:${PROJECT}:${FORM_A}`] = MARKUP_A;
  rows = [{ id: FORM_B, rendered_html: MARKUP_B }];
  const out = await resolveFormBlocks(`{{ form_block id='${FORM_A}' }}{{ form_block id='${FORM_B}' }}`, PROJECT);
  assert.equal(out, MARKUP_A + MARKUP_B);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].whereIn, ['f.id', [FORM_B]]);
});

test('an unknown id renders nothing, warns once, and is cached as a miss', async () => {
  rows = [{ id: FORM_A, rendered_html: MARKUP_A }];
  const html = `<main>{{ form_block id='${UNKNOWN}' }}<hr>{{ form_block id='${FORM_A}' }}<hr>{{ form_block id='${UNKNOWN}' }}</main>`;

  const out = await resolveFormBlocks(html, PROJECT);
  assert.equal(out, `<main><hr>${MARKUP_A}<hr></main>`);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`Unknown form ${UNKNOWN} on project ${PROJECT}`));
  assert.equal(cache[`form:${PROJECT}:${UNKNOWN}`], '');

  // Second request inside the TTL: the miss is served from the cache, no query, no new warning.
  queries = [];
  const again = await resolveFormBlocks(html, PROJECT);
  assert.equal(again, `<main><hr>${MARKUP_A}<hr></main>`);
  assert.equal(queries.length, 0);
  assert.equal(warnings.length, 1);
});

test('a malformed id is never sent to the database', async () => {
  const bad = '------------------------------------'; // 36 chars, matches the token regex, not a uuid
  rows = [{ id: FORM_A, rendered_html: MARKUP_A }];
  const out = await resolveFormBlocks(`{{ form_block id='${bad}' }}{{ form_block id='${FORM_A}' }}`, PROJECT);
  assert.equal(out, MARKUP_A);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].whereIn, ['f.id', [FORM_A]]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Malformed form id/);
});

test('a form published without markup renders nothing and warns', async () => {
  rows = [{ id: FORM_A, rendered_html: null }];
  const out = await resolveFormBlocks(`<p>{{ form_block id='${FORM_A}' }}</p>`, PROJECT);
  assert.equal(out, '<p></p>');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /published without markup/);
});

test('a database failure strips the tokens and keeps the page', async () => {
  dbFails = true;
  const html = `<main>BEFORE {{ form_block id='${FORM_A}' }} AFTER</main>`;
  const out = await resolveFormBlocks(html, PROJECT);
  assert.equal(out, '<main>BEFORE  AFTER</main>');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Failed to load published forms/);
  assert.equal(count(out, 'form_block'), 0);
});

test('a Redis failure falls through to the database', async () => {
  redisFails = true;
  rows = [{ id: FORM_A, rendered_html: MARKUP_A }];
  const out = await resolveFormBlocks(`<p>{{ form_block id='${FORM_A}' }}</p>`, PROJECT);
  assert.equal(out, `<p>${MARKUP_A}</p>`);
  assert.equal(queries.length, 1);
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------
// renderer.ts — the submit handler forwards the form ids
// ---------------------------------------------------------------------

test('the served submit handler sends formId and formVersionId only when the form carries them', () => {
  const html = renderPage(
    '<!doctype html><html><body>{{slot}}</body></html>',
    '',
    '',
    [{ name: 'body', content: `<form data-form-name="Contact" data-form-id="${FORM_A}"><input name="Email"></form>` }],
    undefined,
    undefined,
    PROJECT,
    'https://api.example.test'
  );
  assert.equal(count(html, "var _fid=form.getAttribute('data-form-id');if(_fid){payload.formId=_fid;}"), 1);
  assert.equal(count(html, "var _fvid=form.getAttribute('data-form-version-id');if(_fvid){payload.formVersionId=_fvid;}"), 1);
  // The payload literal itself is untouched, so a legacy form sends the same bytes as before.
  assert.equal(count(html, 'var payload={projectId:PID,formName:formName,formType:formType,contents:contents,_hp:hp.value,_ts:_ts,_jsc:_jsc};'), 1);
  assert.equal(count(html, 'body:JSON.stringify(payload)'), 1);
});
