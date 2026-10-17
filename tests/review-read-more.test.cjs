const assert = require('node:assert/strict');
const vm = require('node:vm');
const { after, test } = require('node:test');

const database = require('../dist/lib/db');
const redis = require('../dist/lib/redis');
const { shapes } = require('./fixtures/review-block-shapes.json');

const rows = { projects: [], review_blocks: [], reviews: [] };

function query(table) {
  const result = rows[table] || [];
  let counting = false;
  const chain = {
    where: () => chain,
    whereIn: () => chain,
    whereBetween: () => chain,
    whereNotNull: () => chain,
    whereRaw: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    select: () => chain,
    count: () => {
      counting = true;
      return chain;
    },
    first: async () => (counting ? { total: result.length } : result[0]),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

const originalDb = database.getDb;
const originalRedis = redis.getRedis;
database.getDb = () => query;
redis.getRedis = () => ({ get: async () => null, set: async () => undefined });
after(() => {
  database.getDb = originalDb;
  redis.getRedis = originalRedis;
});

const { resolveReviewBlocks } = require('../dist/services/review.service');
const { renderReviewBlockHtml } = require('../dist/utils/shortcodes');
const {
  markReviewTextElement,
  getReviewReadMoreScript,
  REVIEW_TEXT_ATTR,
} = require('../dist/utils/review-read-more');

const LONG_TEXT = 'I reached out to several companies while researching options for my garage floor. '.repeat(8).trim();
const SHORT_TEXT = 'Absolutely love the quality and attention to detail!';
const PAGE = (shortcode) => `<html><head></head><body>${shortcode}</body></html>`;
const SCRIPT_FLAG = '__alloroReviewReadMoreInit';

function review(text, name) {
  return {
    stars: 5, text, reviewer_name: name, reviewer_photo_url: null, is_anonymous: false,
    review_created_at: '2026-10-07T00:00:00Z', has_reply: false, reply_text: null, reply_date: null,
  };
}

function useBlock(slug, html) {
  rows.projects = [{ id: 'project', organization_id: null, selected_place_id: 'place-1' }];
  rows.review_blocks = [{ slug, sections: [{ name: 'main', content: html }] }];
  rows.reviews = [review(LONG_TEXT, 'Eduardo'), review(SHORT_TEXT, 'Dana')];
}

// The pre-change algorithm: the block split on its loop markers, each review rendered as-is.
function renderWithoutReadMore(blockHtml) {
  const start = '{{start_review_loop}}';
  const end = '{{end_review_loop}}';
  const before = blockHtml.slice(0, blockHtml.indexOf(start));
  const loop = blockHtml.slice(blockHtml.indexOf(start) + start.length, blockHtml.indexOf(end));
  const afterLoop = blockHtml.slice(blockHtml.indexOf(end) + end.length);
  return before + rows.reviews.map((r) => renderReviewBlockHtml(loop, r)).join('\n') + afterLoop;
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

for (const shape of ['v2-grid', 'v2-carousel', 'v1-grid', 'v1-list-compact']) {
  test(`${shape}: the element holding each review's text is tagged once`, async () => {
    useBlock('reviews', shapes[shape]);
    const html = await resolveReviewBlocks(PAGE("{{ review_block id='reviews' }}"), 'project', 'template');

    assert.equal(count(html, `${REVIEW_TEXT_ATTR}>`), 2);
    assert.match(html, new RegExp(`<p [^>]*${REVIEW_TEXT_ATTR}>${LONG_TEXT.slice(0, 40)}`));
    assert.match(html, new RegExp(`<p [^>]*${REVIEW_TEXT_ATTR}>${SHORT_TEXT}`));
    assert.equal(count(html, SCRIPT_FLAG), 2, 'one script: the guard is read once and set once');
    assert.ok(html.indexOf(SCRIPT_FLAG) < html.indexOf('</body>'));
    // The full review stays in the HTML; the clamp is visual only.
    assert.ok(html.includes(LONG_TEXT));
  });
}

test('v1 carousel keeps its own Read more and renders byte for byte as before', async () => {
  useBlock('review-carousel', shapes['v1-carousel']);
  const html = await resolveReviewBlocks(PAGE("{{ review_block id='review-carousel' }}"), 'project', 'template');

  assert.equal(html, PAGE(renderWithoutReadMore(shapes['v1-carousel'])));
  assert.doesNotMatch(html, new RegExp(REVIEW_TEXT_ATTR));
  assert.ok(!html.includes(SCRIPT_FLAG));
});

test('two review blocks on one page share one script', async () => {
  useBlock('reviews', shapes['v2-grid']);
  const html = await resolveReviewBlocks(
    PAGE("{{ review_block id='reviews' }}<hr>{{ review_block id='reviews' location='primary' }}"),
    'project',
    'template'
  );
  assert.equal(count(html, `${REVIEW_TEXT_ATTR}>`), 4);
  assert.equal(count(html, '<script>(function(){\nif(window.' + SCRIPT_FLAG), 1);
});

test('a review text token inside an attribute is not tagged and nothing is injected', async () => {
  const block = '<div>{{start_review_loop}}<img alt="{{review.text}}"><span>{{review.reviewer_name}}</span>{{end_review_loop}}</div>';
  useBlock('photo-wall', block);
  const html = await resolveReviewBlocks(PAGE("{{ review_block id='photo-wall' }}"), 'project', 'template');

  assert.equal(html, PAGE(renderWithoutReadMore(block)));
  assert.ok(!html.includes(SCRIPT_FLAG));
});

test('Load more pages render from a template that carries the tag', async () => {
  useBlock('review-list-compact', shapes['v1-list-compact']);
  const html = await resolveReviewBlocks(
    PAGE("{{ review_block id='review-list-compact' paginate='load-more' per_page='1' limit='0' }}"),
    'project',
    'template'
  );
  const encoded = html.match(/data-block-template="([^"]+)"/)[1];
  const template = Buffer.from(encoded, 'base64').toString('utf8');

  assert.match(template, new RegExp(`<p [^>]*pl-12" ${REVIEW_TEXT_ATTR}>\\{\\{review\\.text\\}\\}`));
  assert.ok(html.includes(SCRIPT_FLAG));
  assert.ok(html.includes('__alloroPaginationInit'));
});

test('review text stays escaped inside the tagged element', async () => {
  useBlock('reviews', shapes['v2-grid']);
  rows.reviews = [review('Great <img src=x onerror=alert(1)> work', 'Probe')];
  const html = await resolveReviewBlocks(PAGE("{{ review_block id='reviews' }}"), 'project', 'template');

  assert.match(html, new RegExp(`${REVIEW_TEXT_ATTR}>Great &lt;img src=x onerror=alert\\(1\\)&gt; work`));
  assert.ok(!html.includes('<img src=x'));
});

test('markReviewTextElement handles quotes, void tags and repeat calls', () => {
  assert.equal(
    markReviewTextElement('<p class="quote">"{{review.text}}"</p>'),
    `<p class="quote" ${REVIEW_TEXT_ATTR}>"{{review.text}}"</p>`
  );
  assert.equal(markReviewTextElement('<blockquote>\n  {{review.text}}</blockquote>'), `<blockquote ${REVIEW_TEXT_ATTR}>\n  {{review.text}}</blockquote>`);
  assert.equal(markReviewTextElement('<p>Said:<br>{{review.text}}</p>'), '<p>Said:<br>{{review.text}}</p>');
  const once = markReviewTextElement(shapes['v2-grid']);
  assert.equal(markReviewTextElement(once), once);
});

test('the client script parses and clamps at six lines', () => {
  const output = getReviewReadMoreScript();
  const code = output.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(code));
  assert.match(output, /-webkit-line-clamp:6;/);
  // Caps the box too, so a stretched grid row cannot show lines past the clamp.
  assert.match(output, /max-height:6lh;/);
  assert.match(output, /aria-expanded/);
});
