/**
 * Public-facing empty states for shortcodes that explicitly opt in.
 * The marker lets site QA distinguish these from real post or review cards.
 * Keep this markup in sync with Alloro's empty-shortcode-state.ts.
 */

const MESSAGES: Record<string, string> = {
  'doctors-grid': 'Team profiles are being prepared.',
  'doctors-list-footer-dark': 'Team profiles are being prepared.',
  'services-grid': 'Service details are being prepared.',
  'services-list-dark': 'Service details are being prepared.',
  'articles-grid': 'Articles are being prepared.',
  'review-carousel': 'Reviews are not available here yet.',
  'review-grid': 'Reviews are not available here yet.',
};

const COMPACT_BLOCKS = new Set([
  'doctors-list-footer-dark',
  'services-list-dark',
]);

export function emptyShortcodeState(slug: string): string {
  const message = MESSAGES[slug] || 'Content is being prepared.';
  const marker = `data-alloro-empty-state="${slug.replace(/[^a-z0-9-]/g, '')}"`;
  if (COMPACT_BLOCKS.has(slug)) {
    return `<div ${marker} role="note" class="small muted" style="border:1px dashed currentColor;border-radius:8px;padding:.75rem"><strong>Placeholder</strong><br />${message}</div>`;
  }
  return `<div ${marker} role="note" class="card" style="border-style:dashed;box-shadow:none"><span class="badge">Placeholder</span><p class="small muted mt-4 mb-0">${message}</p></div>`;
}
