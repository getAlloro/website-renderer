/**
 * Menu Resolution Service
 *
 * Resolves {{ menu id='slug' }} shortcodes at runtime:
 * 1. Scans HTML for menu shortcodes
 * 2. Fetches menu items from DB (via Redis cache)
 * 3. Builds nested HTML list (or renders through a menu template)
 * 4. Replaces shortcodes with rendered output
 */

import { getDb } from '../lib/db';
import { getRedis } from '../lib/redis';
import { parseMenuShortcodes, hasMenuShortcodes, escapeHtml } from '../utils/shortcodes';

const MENU_TTL = 300; // 5 minutes

interface MenuItemRow {
  id: string;
  menu_id: string;
  parent_id: string | null;
  label: string;
  url: string;
  target: string;
  order_index: number;
}

interface MenuItemNode extends MenuItemRow {
  children: MenuItemNode[];
}

interface MenuTemplateRow {
  id: string;
  template_id: string;
  name: string;
  slug: string;
  sections: string | { name: string; content: string }[];
}

/**
 * Build a nested tree from flat menu item rows.
 */
function buildTree(items: MenuItemRow[]): MenuItemNode[] {
  const map = new Map<string, MenuItemNode>();
  const roots: MenuItemNode[] = [];

  for (const item of items) {
    map.set(item.id, { ...item, children: [] });
  }

  for (const item of items) {
    const node = map.get(item.id)!;
    if (item.parent_id && map.has(item.parent_id)) {
      map.get(item.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Render a menu item tree as a nested <ul>/<li> HTML string.
 * Uses data-alloro-menu attribute for styling hooks.
 */
function renderMenuHtml(nodes: MenuItemNode[], isRoot: boolean): string {
  if (nodes.length === 0) return '';

  const tag = isRoot ? 'ul' : 'ul';
  const cls = isRoot ? ' class="alloro-menu"' : ' class="alloro-submenu"';

  const lis = nodes.map((node) => {
    const hasChildren = node.children.length > 0;
    const targetAttr = node.target !== '_self' ? ` target="${escapeHtml(node.target)}"` : '';
    const link = `<a href="${escapeHtml(node.url)}"${targetAttr}>${escapeHtml(node.label)}</a>`;
    const sub = hasChildren ? renderMenuHtml(node.children, false) : '';
    const liClass = hasChildren ? ' class="has-submenu"' : '';
    return `<li${liClass}>${link}${sub}</li>`;
  });

  return `<${tag}${cls}>${lis.join('')}</${tag}>`;
}

/**
 * Render a single menu item by replacing tokens in an item template.
 * Recurses for {{menu_item.children}}.
 */
function renderMenuItem(node: MenuItemNode, itemTemplate: string): string {
  let result = itemTemplate;
  result = result.split('{{menu_item.label}}').join(escapeHtml(node.label));
  result = result.split('{{menu_item.url}}').join(escapeHtml(node.url));
  result = result.split('{{menu_item.target}}').join(escapeHtml(node.target));

  if (node.children.length > 0) {
    const childrenHtml = `<ul class="nav-submenu">${node.children
      .map((child) => renderMenuItem(child, itemTemplate))
      .join('')}</ul>`;
    result = result.split('{{menu_item.children}}').join(childrenHtml);
  } else {
    result = result.split('{{menu_item.children}}').join('');
  }

  return result;
}

/**
 * Render menu nodes through a menu template's HTML.
 * Handles {{start_menu_loop}} / {{end_menu_loop}} markers.
 */
function renderMenuWithTemplate(nodes: MenuItemNode[], templateHtml: string): string {
  const startMarker = '{{start_menu_loop}}';
  const endMarker = '{{end_menu_loop}}';
  const startIdx = templateHtml.indexOf(startMarker);
  const endIdx = templateHtml.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = templateHtml.slice(0, startIdx);
    const itemTemplate = templateHtml.slice(startIdx + startMarker.length, endIdx);
    const after = templateHtml.slice(endIdx + endMarker.length);

    const rendered = nodes.map((node) => renderMenuItem(node, itemTemplate)).join('');
    return before + rendered + after;
  }

  // Fallback: no loop markers — render bare HTML
  return renderMenuHtml(nodes, true);
}

/**
 * Fetch menu items by project ID and menu slug, with Redis caching.
 */
async function fetchMenuItems(projectId: string, menuSlug: string): Promise<MenuItemRow[]> {
  const redis = getRedis();
  const cacheKey = `menu:${projectId}:${menuSlug}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // Cache miss or Redis down — fall through to DB
  }

  const db = getDb();

  const menu = await db('menus')
    .where({ project_id: projectId, slug: menuSlug })
    .first();

  if (!menu) return [];

  const items: MenuItemRow[] = await db('menu_items')
    .where('menu_id', menu.id)
    .orderBy('order_index', 'asc')
    .select('id', 'menu_id', 'parent_id', 'label', 'url', 'target', 'order_index');

  try {
    await redis.set(cacheKey, JSON.stringify(items), 'EX', MENU_TTL);
  } catch {
    // Cache write failure is non-fatal
  }

  return items;
}

/**
 * Fetch a menu template by template ID and slug, with Redis caching.
 */
async function fetchMenuTemplate(templateId: string, slug: string): Promise<MenuTemplateRow | null> {
  const redis = getRedis();
  const cacheKey = `mt:${templateId}:${slug}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // Cache miss or Redis down — fall through to DB
  }

  const db = getDb();

  const mt = await db('menu_templates')
    .where({ template_id: templateId, slug })
    .first();

  if (!mt) return null;

  try {
    await redis.set(cacheKey, JSON.stringify(mt), 'EX', MENU_TTL);
  } catch {
    // Cache write failure is non-fatal
  }

  return mt;
}

/**
 * Resolve all {{ menu id='slug' }} shortcodes in the given HTML.
 * When a template attribute is present and a matching menu template exists,
 * renders through the template. Otherwise falls back to bare HTML.
 */
export async function resolveMenus(
  html: string,
  projectId: string,
  templateId?: string
): Promise<string> {
  if (!hasMenuShortcodes(html)) {
    return html;
  }

  const shortcodes = parseMenuShortcodes(html);
  if (shortcodes.length === 0) {
    return html;
  }

  let result = html;

  for (const shortcode of shortcodes) {
    const items = await fetchMenuItems(projectId, shortcode.id);

    if (items.length === 0) {
      // No items or menu not found — render as nav with empty state
      result = result.replace(shortcode.raw, `<nav data-menu="${escapeHtml(shortcode.id)}"></nav>`);
      continue;
    }

    const tree = buildTree(items);

    // Check for menu template
    if (shortcode.template && templateId) {
      const mt = await fetchMenuTemplate(templateId, shortcode.template);
      if (mt) {
        const sections = typeof mt.sections === 'string' ? JSON.parse(mt.sections) : mt.sections;
        const templateHtml = Array.isArray(sections)
          ? sections.map((s: { content: string }) => s.content).join('\n')
          : '';

        if (templateHtml) {
          const rendered = renderMenuWithTemplate(tree, templateHtml);
          result = result.replace(shortcode.raw, rendered);
          continue;
        }
      }
    }

    // Fallback: bare HTML rendering
    const menuHtml = `<nav data-menu="${escapeHtml(shortcode.id)}">${renderMenuHtml(tree, true)}</nav>`;
    result = result.replace(shortcode.raw, menuHtml);
  }

  return result;
}
