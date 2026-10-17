const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const vm = require('node:vm');

// String.prototype.replace reads $$, $&, $` and $' inside a STRING replacement as
// patterns. Owner text (reviews, posts, menu labels, page copy) must come out
// exactly as written, so every splice and token fill passes a function instead.
// These tests fail on the string form: "$$" collapses to "$", and "$'" / "$&"
// paste other parts of the page into the card.

const database = require('../dist/lib/db');
const redis = require('../dist/lib/redis');
const rows = { post_blocks: [], posts: [], projects: [], review_blocks: [], reviews: [] };
const cache = {};

function query(table) {
  const result = rows[table] || [];
  let counting = false;
  const chain = {
    join: () => chain,
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
redis.getRedis = () => ({ get: async (key) => cache[key] ?? null, set: async () => undefined });
after(() => {
  database.getDb = originalDb;
  redis.getRedis = originalRedis;
});

const { resolvePostBlocks } = require('../dist/services/postblock.service');
const { resolveReviewBlocks } = require('../dist/services/review.service');
const { resolveMenus } = require('../dist/services/menu.service');
const { renderPage } = require('../dist/utils/renderer');
const { getPaginationScript } = require('../dist/utils/pagination-client');

// escapeHtml turns ' into &#39;, so the review text below reaches the page as
// "Saved $$ and $&#39; too". That still carries $$ and $& — both patterns.
const REVIEW_TEXT = "Saved $$ and $' too";
const REVIEW_HTML = 'Saved $$ and $&#39; too';
// Post content is trusted raw HTML, so a bare $' reaches the replacement unescaped.
const POST_CONTENT = "<p>Fees from $$ and $' up</p>";

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// Other renderer features may add attributes to the review text element, so
// compare cards with <p ...> reduced to <p>. The text itself must stay exact.
function plainParagraphs(html) {
  return html.replace(/<p\b[^>]*>/g, () => '<p>');
}

function useReview(text, reviewerName = 'Patient') {
  rows.projects = [{ id: 'project', organization_id: null, selected_place_id: 'place-1' }];
  rows.review_blocks = [{
    slug: 'review-grid',
    sections: [{ content: '<section>{{start_review_loop}}<p>{{review.text}}</p><b>{{review.reviewer_name}}</b>{{end_review_loop}}</section>' }],
  }];
  rows.reviews = [{
    stars: 5, text, reviewer_name: reviewerName,
    reviewer_photo_url: null, is_anonymous: false, review_created_at: null,
    has_reply: false, reply_text: null, reply_date: null,
  }];
}

test('review text with $$ and $\' renders verbatim', async () => {
  useReview(REVIEW_TEXT, 'Dr. $` Lee');
  const page = "<main>BEFORE {{ review_block id='review-grid' }} AFTER</main>";
  const html = await resolveReviewBlocks(page, 'project', 'template');

  assert.equal(
    plainParagraphs(html),
    `<main>BEFORE <section><p>${REVIEW_HTML}</p><b>Dr. $\` Lee</b></section> AFTER</main>`
  );
});

test('paginated review blocks keep $ patterns verbatim too', async () => {
  useReview(REVIEW_TEXT);
  const page = "<html><body>BEFORE {{ review_block id='review-grid' paginate='load-more' per_page='1' }} AFTER</body></html>";
  const html = await resolveReviewBlocks(page, 'project', 'template');

  assert.equal(count(plainParagraphs(html), `<p>${REVIEW_HTML}</p>`), 1);
  assert.equal(count(html, 'BEFORE'), 1);
  assert.equal(count(html, 'AFTER'), 1);
  assert.equal(count(html, '</body>'), 1);
  assert.doesNotMatch(html, /review_block/);
});

test('post content with $$ and $\' renders verbatim in a post block', async () => {
  rows.post_blocks = [{
    slug: 'services-grid',
    post_type_slug: 'services',
    sections: [{ content: '<div>{{start_post_loop}}<h3>{{post.title}}</h3>{{post.content}}{{end_post_loop}}</div>' }],
  }];
  rows.posts = [{
    id: 'post-1', title: 'Payment $$ plans', slug: 'payment-plans',
    content: POST_CONTENT, excerpt: '', featured_image: null,
    custom_fields: {}, created_at: null, updated_at: null, published_at: null,
  }];
  const page = "<main>BEFORE {{ post_block id='services-grid' items='services' }} AFTER</main>";
  const html = await resolvePostBlocks(page, 'template', 'project');

  assert.equal(count(html, '<h3>Payment $$ plans</h3>'), 1);
  assert.equal(count(html, POST_CONTENT), 1);
  assert.equal(count(html, 'BEFORE'), 1);
  assert.equal(count(html, 'AFTER'), 1);
  assert.doesNotMatch(html, /post_block|\{\{post\./);
});

test('menu labels with $$ and $\' render verbatim', async () => {
  cache['menu:project:main'] = JSON.stringify([{
    id: 'item-1', menu_id: 'menu-1', parent_id: null, label: "Fees $$ and $' more",
    url: '/fees', target: '_self', order_index: 0, item_type: null,
  }]);
  const page = "<header>BEFORE {{ menu id='main' }} AFTER</header>";
  const html = await resolveMenus(page, 'project');

  assert.equal(count(html, 'Fees $$ and $&#39; more'), 1);
  assert.equal(count(html, 'BEFORE'), 1);
  assert.equal(count(html, 'AFTER'), 1);
});

test('page and single-post sections keep $ patterns through the {{slot}} splice', () => {
  const html = renderPage(
    '<html><body>{{slot}}</body></html>',
    '<header>H</header>',
    '<footer>F</footer>',
    [{ name: 'post', content: POST_CONTENT }]
  );

  assert.equal(html, `<html><body><header>H</header>\n${POST_CONTENT}\n<footer>F</footer></body></html>`);
});

test('the browser pagination renderer keeps $ patterns verbatim on page 2+', () => {
  const script = getPaginationScript();
  const start = script.indexOf('function esc(');
  const end = script.indexOf('function fetchPage(');
  assert.ok(start > -1 && end > start, 'pagination script helpers moved; update this test');
  const renderItem = vm.runInNewContext(`${script.slice(start, end)}\nrenderItem;`);

  assert.equal(
    renderItem('<p>{{review.text}}</p><b>{{review.reviewer_name}}</b>', { text: REVIEW_TEXT, reviewer_name: 'Ana' }, 'review'),
    `<p>${REVIEW_HTML}</p><b>Ana</b>`
  );
  assert.equal(
    renderItem('<div>{{post.content}}</div><i>{{post.title}}</i>', { content: POST_CONTENT, title: 'T' }, 'post'),
    `<div>${POST_CONTENT}</div><i>T</i>`
  );
});
