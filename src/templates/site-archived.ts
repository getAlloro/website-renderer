import { wrapInLayout } from './layout';
import { brandColor, animationStyles, icons } from './styles';

/**
 * Served with HTTP 410 when a hostname/domain matches an ARCHIVED project —
 * distinct from site-not-found (never existed) so crawlers get an explicit
 * "gone, deindex me" signal and humans get an honest message.
 */
export function siteArchivedPage(hostname: string): string {
  const body = `
<style>${animationStyles}</style>
<div class="site-page-wrapper" style="background: linear-gradient(135deg, #f5f5f5 0%, #e5e5e5 100%);">
  <div style="text-align: center; padding: 3rem 2rem; max-width: 500px;">
    <div class="icon-float" style="display: flex; justify-content: center; margin-bottom: 1.5rem;">
      ${icons.searchX}
    </div>
    <h1 style="color: #1f2937; font-size: 2rem; font-weight: 700; margin-bottom: 1rem; letter-spacing: -0.025em;">
      This Site Is No Longer Available
    </h1>
    <p style="color: #6b7280; font-size: 1.125rem; line-height: 1.6; margin-bottom: 1.5rem;">
      The site that used to live at this address has been retired.
    </p>
    <div style="display: inline-block; padding: 0.75rem 1.25rem; background-color: white; border-radius: 0.75rem; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); margin-bottom: 2rem;">
      <code style="font-size: 0.875rem; color: #6b7280; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">
        ${hostname}
      </code>
    </div>
    <p style="color: #9ca3af; font-size: 0.875rem; line-height: 1.6;">
      If you believe this is an error, please contact support.
    </p>
    <p style="margin-top: 3rem; font-size: 0.75rem; color: #9ca3af;">
      Powered by <span style="color: ${brandColor}; font-weight: 600;">Alloro</span>
    </p>
  </div>
</div>`;

  return wrapInLayout('Site No Longer Available', body);
}
