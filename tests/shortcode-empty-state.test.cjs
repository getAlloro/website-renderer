const assert = require('node:assert/strict');
const { after, test } = require('node:test');

const database = require('../dist/lib/db');
const redis = require('../dist/lib/redis');
const rows = { post_blocks: [], posts: [], projects: [], review_blocks: [], reviews: [] };

function query(table) {
  const result = rows[table] || [];
  const chain = {
    join: () => chain,
    where: () => chain,
    whereIn: () => chain,
    whereBetween: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    select: () => chain,
    first: async () => result[0],
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

const { resolvePostBlocks } = require('../dist/services/postblock.service');
const { resolveReviewBlocks } = require('../dist/services/review.service');

test('empty post blocks show a visibly provisional card only when opted in', async () => {
  rows.post_blocks = [{
    slug: 'services-grid',
    post_type_slug: 'services',
    sections: [{ content: '<div>{{start_post_loop}}<a href="{{post.url}}">{{post.title}}</a>{{end_post_loop}}</div>' }],
  }];
  rows.posts = [];

  const opted = await resolvePostBlocks("{{ post_block id='services-grid' items='services' empty='placeholder' }}", 'template', 'project');
  const legacy = await resolvePostBlocks("{{ post_block id='services-grid' items='services' }}", 'template', 'project');
  assert.match(opted, /data-alloro-empty-state="services-grid"/);
  assert.match(opted, /Placeholder/);
  assert.doesNotMatch(opted, /<a\b/);
  assert.doesNotMatch(legacy, /data-alloro-empty-state/);
});

test('published posts replace the empty state', async () => {
  rows.posts = [{
    id: 'post-1', title: 'Root Canal Treatment', slug: 'root-canal-treatment',
    content: 'Reviewed description', excerpt: '', featured_image: null,
    custom_fields: {}, created_at: null, updated_at: null, published_at: null,
  }];
  const html = await resolvePostBlocks("{{ post_block id='services-grid' items='services' empty='placeholder' }}", 'template', 'project');
  assert.match(html, /Root Canal Treatment/);
  assert.match(html, /href="\/services\/root-canal-treatment"/);
  assert.doesNotMatch(html, /data-alloro-empty-state/);
});

test('review shortcode without a review scope shows no fabricated review', async () => {
  rows.projects = [{ id: 'project', organization_id: null, selected_place_id: null }];
  const opted = await resolveReviewBlocks("{{ review_block id='review-grid' empty='placeholder' }}", 'project', 'template');
  const legacy = await resolveReviewBlocks("{{ review_block id='review-grid' }}", 'project', 'template');
  assert.match(opted, /data-alloro-empty-state="review-grid"/);
  assert.match(opted, /Reviews are not available here yet/);
  assert.doesNotMatch(opted, /<svg|reviewer_name|stars_html/);
  assert.doesNotMatch(legacy, /data-alloro-empty-state/);
});

test('a real review replaces the review empty state', async () => {
  rows.projects = [{ id: 'project', organization_id: null, selected_place_id: 'place-1' }];
  rows.review_blocks = [{
    slug: 'review-grid',
    sections: [{ content: '<div>{{start_review_loop}}<p>{{review.text}}</p>{{end_review_loop}}</div>' }],
  }];
  rows.reviews = [{
    stars: 5, text: 'Helpful visit', reviewer_name: 'Patient',
    reviewer_photo_url: null, is_anonymous: false, review_created_at: null,
    has_reply: false, reply_text: null, reply_date: null,
  }];
  const html = await resolveReviewBlocks("{{ review_block id='review-grid' empty='placeholder' }}", 'project', 'template');
  assert.match(html, /Helpful visit/);
  assert.doesNotMatch(html, /data-alloro-empty-state/);
});
