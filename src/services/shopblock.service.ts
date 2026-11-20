/**
 * Shop Block Resolution Service
 *
 * Resolves {{ start_shop_block ... }} card markup {{ end_shop_block }} at runtime:
 * 1. Scans the HTML for shop blocks
 * 2. Reads the project's showing Store products from Redis, else the DB (a few small queries, one cache entry)
 * 3. Repeats each block's card markup once per picked product, filling {{product.*}} tokens
 *
 * Products come from the Alloro Store tables (website_builder.checkout_*), which the Alloro app owns.
 * Only active items and bundles that have their own page (a slug) are shown, and only while the
 * website's Store is on: with the Store off there are no /shop pages for a card to link to.
 */

import { getDb } from '../lib/db';
import { getRedis } from '../lib/redis';
import {
  SHOP_BLOCK_REGEX,
  hasShopBlockShortcodes,
  pickShopProducts,
  renderShopProductHtml,
  parseShopBlockShortcodes,
  type ShopBlockProduct,
} from '../utils/shortcodes';

export const SHOP_BLOCK_TTL = 60; // 1 minute: an edit in the Store shows up within a minute without ?nocache=1

function cacheKey(projectId: string): string {
  return `shopblock:${projectId}`;
}

interface ProductRow {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string | null;
  image_url: string | null;
  images: unknown;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstImage(row: ProductRow): { url: string; alt: string } {
  const raw = typeof row.images === 'string' ? safeJson(row.images) : row.images;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const url = item && typeof item.url === 'string' ? item.url : '';
      if (url) return { url, alt: typeof item.alt === 'string' ? item.alt : '' };
    }
  }
  return { url: row.image_url || '', alt: '' };
}

/** The project's showing products, in the Store's order, or [] when its Store is off. */
export async function loadShopProducts(projectId: string): Promise<ShopBlockProduct[]> {
  const db = getDb();
  const project = await db('projects').where('id', projectId).select('checkout_enabled').first();
  if (!project || project.checkout_enabled !== true) return [];

  const products: ProductRow[] = await db('checkout_products')
    .where('project_id', projectId)
    .where('is_active', true)
    .whereIn('product_type', ['item', 'bundle'])
    .whereNotNull('slug')
    .orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'created_at', order: 'asc' }])
    .select('id', 'slug', 'name', 'description', 'price_cents', 'currency', 'image_url', 'images');
  if (products.length === 0) return [];

  const ids = products.map((p) => p.id);
  const [variants, tagRows] = await Promise.all([
    db('checkout_product_variants')
      .where('project_id', projectId)
      .where('is_active', true)
      .whereIn('product_id', ids)
      .select('product_id', 'price_cents'),
    db('checkout_product_tags as pt')
      .join('checkout_tags as t', 't.id', 'pt.tag_id')
      .where('t.project_id', projectId)
      .whereIn('pt.product_id', ids)
      .orderBy('t.sort_order', 'asc')
      .select('pt.product_id', 't.slug', 't.name'),
  ]);

  return products.map((p) => {
    const own = (variants as { product_id: string; price_cents: number | null }[])
      .filter((v) => v.product_id === p.id)
      .map((v) => (v.price_cents === null || v.price_cents === undefined ? Number(p.price_cents) : Number(v.price_cents)));
    const prices = own.length ? own : [Number(p.price_cents)];
    const min = Math.min(...prices);
    const image = firstImage(p);
    return {
      slug: String(p.slug),
      name: p.name,
      description: p.description || '',
      image: image.url,
      imageAlt: image.alt,
      minCents: min,
      hasPriceRange: prices.some((c) => c !== min),
      currency: p.currency || 'usd',
      tags: (tagRows as { product_id: string; slug: string; name: string }[])
        .filter((t) => t.product_id === p.id)
        .map((t) => ({ slug: t.slug, name: t.name })),
    };
  });
}

async function readProducts(projectId: string): Promise<ShopBlockProduct[]> {
  const redis = getRedis();
  try {
    const cached = await redis.get(cacheKey(projectId));
    if (cached !== null) return JSON.parse(cached) as ShopBlockProduct[];
  } catch {
    // Cache miss or Redis down: fall through to DB
  }
  const products = await loadShopProducts(projectId);
  try {
    await redis.set(cacheKey(projectId), JSON.stringify(products), 'EX', SHOP_BLOCK_TTL);
  } catch {
    // Cache write failure is non-fatal
  }
  return products;
}

function stripShopBlocks(html: string): string {
  return html.replace(SHOP_BLOCK_REGEX, '');
}

/**
 * Resolve every shop block in the HTML. `pagePath` is the path being served, used by exclude='current'.
 * A DB failure renders the page without the product cards rather than taking it down.
 */
export async function resolveShopBlocks(html: string, projectId: string, pagePath?: string): Promise<string> {
  if (!hasShopBlockShortcodes(html)) return html;
  const blocks = parseShopBlockShortcodes(html);
  if (blocks.length === 0) return html;

  let products: ShopBlockProduct[];
  try {
    products = await readProducts(projectId);
  } catch (err) {
    console.error('[shop-block] Failed to load Store products, rendering the page without them:', err);
    return stripShopBlocks(html);
  }

  let i = 0;
  // Function replacement, so $$, $& and $' in product text stay literal.
  return html.replace(SHOP_BLOCK_REGEX, () => {
    const block = blocks[i++];
    return pickShopProducts(block, products, pagePath).map((p) => renderShopProductHtml(block.template, p)).join('');
  });
}
