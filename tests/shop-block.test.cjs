const assert = require('node:assert/strict');
const { after, beforeEach, test } = require('node:test');

// {{ start_shop_block ... }} card {{ end_shop_block }} repeats the site's own card markup once per
// showing Store product, filled from the Store tables when the page is served. With the Store off
// there are no /shop pages, so blocks render nothing. A DB failure strips the blocks instead of
// taking the page down.

const database = require('../dist/lib/db');
const redis = require('../dist/lib/redis');

const PROJECT = 'project-1';

let tables = {};
let queries = [];
let cache = {};
let dbFails = false;
let errors = [];

function query(table) {
  const q = { table, where: [], whereIn: [], whereNotNull: [] };
  queries.push(q);
  const result = () => {
    if (dbFails) return Promise.reject(new Error('db down'));
    const name = table.split(' ')[0];
    return Promise.resolve(tables[name] || []);
  };
  const chain = {
    join: () => chain,
    where: (col, val) => { q.where.push([col, val]); return chain; },
    whereIn: (col, vals) => { q.whereIn.push([col, vals]); return chain; },
    whereNotNull: (col) => { q.whereNotNull.push(col); return chain; },
    orderBy: () => chain,
    select: () => chain,
    first: () => result().then((rows) => rows[0]),
    then: (resolve, reject) => result().then(resolve, reject),
  };
  return chain;
}

const redisMock = {
  get: async (key) => (Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null),
  set: async (key, value, mode, ttl) => {
    cache[key] = value;
    cache[`${key}:ttl`] = `${mode}:${ttl}`;
  },
};

const originalDb = database.getDb;
const originalRedis = redis.getRedis;
const originalError = console.error;
database.getDb = () => query;
redis.getRedis = () => redisMock;
console.error = (...args) => errors.push(args.join(' '));
after(() => {
  database.getDb = originalDb;
  redis.getRedis = originalRedis;
  console.error = originalError;
});

const P1 = { id: 'p1', slug: 'hero-s-brew', name: 'Hero’s Brew', description: 'Colombia. <b>Bold</b>', price_cents: 1400, currency: 'usd', image_url: null, images: [{ url: 'https://img/heros.webp', alt: 'Hero bag' }] };
const P2 = { id: 'p2', slug: 'courageous-dawn', name: 'Courageous Dawn', description: 'Costa Rica', price_cents: 1400, currency: 'usd', image_url: 'https://img/dawn.webp', images: [] };
const P3 = { id: 'p3', slug: 'perseverance', name: 'Perseverance', description: 'El Salvador $& $$', price_cents: 1550, currency: 'usd', image_url: null, images: JSON.stringify([{ url: 'https://img/pers.webp' }]) };

beforeEach(() => {
  tables = {
    projects: [{ checkout_enabled: true }],
    checkout_products: [P1, P2, P3],
    checkout_product_variants: [
      { product_id: 'p1', price_cents: null },
      { product_id: 'p1', price_cents: 2400 },
      { product_id: 'p2', price_cents: null },
    ],
    checkout_product_tags: [
      { product_id: 'p1', slug: 'medium-dark', name: 'Medium-dark' },
      { product_id: 'p2', slug: 'light', name: 'Light' },
      { product_id: 'p3', slug: 'medium-dark', name: 'Medium-dark' },
    ],
  };
  queries = [];
  cache = {};
  dbFails = false;
  errors = [];
});

const { parseShopBlockShortcodes, hasShopBlockShortcodes, formatShopPrice, renderShopProductHtml } = require('../dist/utils/shortcodes');
const { resolveShopBlocks, SHOP_BLOCK_TTL } = require('../dist/services/shopblock.service');

const CARD = '<a class="card" href="{{product.url}}"><img src="{{product.image}}" alt="{{product.image_alt}}"><span>{{product.tag}}</span><span>{{product.price_label}}</span><h3>{{product.name}}</h3></a>';
const block = (attrs = '') => `<div class="grid">{{ start_shop_block${attrs} }}${CARD}{{ end_shop_block }}</div>`;

test('the parser reads every attribute and keeps the card markup', () => {
  const [b] = parseShopBlockShortcodes(block(" limit='3' tags='Light, decaf' exclude='current'"));
  assert.equal(b.limit, 3);
  assert.deepEqual(b.tags, ['light', 'decaf']);
  assert.equal(b.excludeCurrent, true);
  assert.equal(b.template, CARD);
  const [plain] = parseShopBlockShortcodes(block());
  assert.equal(plain.limit, null);
  assert.deepEqual(plain.tags, []);
  assert.equal(plain.excludeCurrent, false);
  assert.equal(parseShopBlockShortcodes(block(" limit='999'"))[0].limit, 48);
  assert.equal(parseShopBlockShortcodes(block(" limit='zero'"))[0].limit, null);
  assert.equal(hasShopBlockShortcodes('<p>{{ post_block id="x" items="y" }}</p>'), false);
});

test('prices: whole dollars drop the cents, others keep two places', () => {
  assert.equal(formatShopPrice(1400, 'usd'), '$14');
  assert.equal(formatShopPrice(1550, 'USD'), '$15.50');
  assert.equal(formatShopPrice(1000, 'eur'), '10 EUR');
});

test('tokens are escaped and unknown tokens render nothing', () => {
  const html = renderShopProductHtml('<p>{{product.description}}|{{product.nope}}|{{product.tags}}</p>', {
    slug: 's', name: 'n', description: '<script>x</script>', image: '', imageAlt: '', minCents: 100, hasPriceRange: false, currency: 'usd', tags: [{ slug: 'a', name: 'A&B' }],
  });
  assert.equal(html, '<p>&lt;script&gt;x&lt;/script&gt;||A&amp;B</p>');
});

test('html without a block comes back unchanged and touches nothing', async () => {
  const html = "<main>{{ post_block id='x' items='y' }}</main>";
  assert.equal(await resolveShopBlocks(html, PROJECT), html);
  assert.equal(queries.length, 0);
});

test('a block repeats the card per product in Store order with live prices and tags', async () => {
  const out = await resolveShopBlocks(block(), PROJECT);
  assert.equal((out.match(/class="card"/g) || []).length, 3);
  assert.ok(out.indexOf('Hero’s Brew') < out.indexOf('Courageous Dawn'));
  assert.ok(out.includes('href="/shop/hero-s-brew"'));
  assert.ok(out.includes('src="https://img/heros.webp" alt="Hero bag"'));
  assert.ok(out.includes('<span>From $14</span><h3>Hero’s Brew'), 'size prices differ -> From');
  assert.ok(out.includes('<span>$14</span><h3>Courageous Dawn'), 'one price -> no From');
  assert.ok(out.includes('src="https://img/dawn.webp" alt="Courageous Dawn"'), 'falls back to image_url and the name');
  assert.ok(out.includes('<span>$15.50</span><h3>Perseverance'), 'no variants -> product price');
  assert.ok(!out.includes('shop_block'));
  assert.equal(cache[`shopblock:${PROJECT}:ttl`], `EX:${SHOP_BLOCK_TTL}`);
});

test('limit, tags and exclude=current pick the right products', async () => {
  const limited = await resolveShopBlocks(block(" limit='2'"), PROJECT);
  assert.equal((limited.match(/class="card"/g) || []).length, 2);
  const tagged = await resolveShopBlocks(block(" tags='medium-dark'"), PROJECT);
  assert.ok(tagged.includes('Hero’s Brew') && tagged.includes('Perseverance') && !tagged.includes('Courageous Dawn'));
  const others = await resolveShopBlocks(block(" exclude='current'"), PROJECT, '/shop/perseverance/');
  assert.ok(!others.includes('<h3>Perseverance'));
  assert.equal((others.match(/class="card"/g) || []).length, 2);
});

test('two blocks on one page share one load and stay independent', async () => {
  const out = await resolveShopBlocks(block(" limit='1'") + block(" tags='light'"), PROJECT);
  assert.equal((out.match(/<h3>Hero’s Brew/g) || []).length, 1);
  assert.equal((out.match(/<h3>Courageous Dawn/g) || []).length, 1);
  assert.equal(queries.filter((q) => q.table === 'checkout_products').length, 1);
});

test('$ patterns in product text stay literal', async () => {
  const out = await resolveShopBlocks('{{ start_shop_block }}<p>{{product.description}}</p>{{ end_shop_block }}', PROJECT);
  assert.ok(out.includes('El Salvador $&amp; $$'));
});

test('a website with its Store off shows no cards (its /shop pages do not exist)', async () => {
  tables.projects = [{ checkout_enabled: false }];
  const out = await resolveShopBlocks(block(), PROJECT);
  assert.equal(out, '<div class="grid"></div>');
  assert.equal(queries.filter((q) => q.table === 'checkout_products').length, 0);
});

test('the query is scoped to the project and to showing items with a page', async () => {
  await resolveShopBlocks(block(), PROJECT);
  const q = queries.find((x) => x.table === 'checkout_products');
  assert.deepEqual(q.where, [['project_id', PROJECT], ['is_active', true]]);
  assert.deepEqual(q.whereIn, [['product_type', ['item', 'bundle']]]);
  assert.deepEqual(q.whereNotNull, ['slug']);
});

test('a cached list is used without touching the DB', async () => {
  await resolveShopBlocks(block(), PROJECT);
  const before = queries.length;
  await resolveShopBlocks(block(), PROJECT);
  assert.equal(queries.length, before);
});

test('a DB failure renders the page without the cards', async () => {
  dbFails = true;
  const out = await resolveShopBlocks(`<main>${block()}</main>`, PROJECT);
  assert.equal(out, '<main><div class="grid"></div></main>');
  assert.equal(errors.length, 1);
});
