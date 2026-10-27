/**
 * "Website Powered by Alloro" credit, added to the footer of every rendered page.
 *
 * The credit used to be pasted into each project's saved footer by hand, so a
 * regenerated footer silently lost it. Adding it at render time keeps it on
 * every site. A page whose saved HTML already carries a credit is left as it is,
 * so no page shows two.
 */

// getalloro.com is served by this renderer too, and does not credit itself.
const EXCLUDED_PROJECT_IDS = new Set([
  'acc7cbfc-a3fd-4476-abbc-aace3a566fc5',
]);

// "Powered by Alloro", allowing tags between the words ("Powered by <a>Alloro</a>").
// "Powered by Alloro Protect" is the form badge, not a site credit.
const EXISTING_CREDIT_PATTERN = /powered\s+by(?:\s|<[^>]*>)*alloro(?!(?:\s|<[^>]*>)*protect)/i;

// Inline styles only: sites do not share a stylesheet, and color: inherit takes
// the footer's own text color so the credit reads on light and dark footers.
const CREDIT_HTML = `<div data-alloro-credit style="width:100%;padding:16px 24px;text-align:center;font-size:12px;line-height:16px;">
  <a href="https://www.getalloro.com" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:8px;color:inherit;opacity:0.6;text-decoration:none;">
    <img src="https://app.getalloro.com/logo.png" alt="" style="height:16px;width:auto;">
    <span>Website Powered by Alloro</span>
  </a>
</div>`;

/**
 * True when the HTML already carries a "Powered by Alloro" credit.
 */
export function hasAlloroCredit(html: string): boolean {
  return EXISTING_CREDIT_PATTERN.test(html);
}

/**
 * Return the footer with the credit added inside its last </footer>, or after it
 * when the footer has no <footer> element. Returns the footer unchanged for an
 * excluded project or when `pageHtml` already carries a credit.
 */
export function withAlloroCredit(footer: string, pageHtml: string, projectId?: string): string {
  if (projectId && EXCLUDED_PROJECT_IDS.has(projectId)) return footer;
  if (hasAlloroCredit(pageHtml)) return footer;

  const closeIndex = footer.toLowerCase().lastIndexOf('</footer>');
  if (closeIndex === -1) return `${footer}\n${CREDIT_HTML}`;
  return `${footer.slice(0, closeIndex)}${CREDIT_HTML}\n${footer.slice(closeIndex)}`;
}
