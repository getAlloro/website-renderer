import { wrapInLayout } from './layout';
import { brandColor, animationStyles, icons } from './styles';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Shown to a signed-in member who opens a members-only page that is limited to a
 * group they are not in. Modelled on page-not-found.ts. The "Sign out" button posts
 * to this site's own /_members/signout; without script it is plain text.
 */
export function memberForbiddenPage(businessName?: string): string {
  const title = businessName ? `${escapeHtml(businessName)} - Members Only` : 'Members Only';

  const body = `
<style>${animationStyles}</style>
<div class="site-page-wrapper" style="background-color: #fafafa;">
  <div style="text-align: center; padding: 3rem 2rem; max-width: 500px;">
    <div style="font-size: 6rem; font-weight: 800; color: ${brandColor}; line-height: 1; margin-bottom: 1rem; opacity: 0.2;">
      403
    </div>
    <h1 style="color: #1f2937; font-size: 1.75rem; font-weight: 700; margin-bottom: 0.75rem;">
      This page is for a different members group.
    </h1>
    <p style="color: #6b7280; font-size: 1rem; line-height: 1.6; margin-bottom: 2rem;">
      You are signed in, but your membership does not include this page.
    </p>
    <a href="/" style="display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1.5rem; background-color: ${brandColor}; color: white; border-radius: 0.75rem; text-decoration: none; font-weight: 600; font-size: 0.875rem; box-shadow: 0 4px 14px ${brandColor}40;">
      ${icons.arrowLeft}
      Go to Homepage
    </a>
    <p style="margin-top: 2rem; font-size: 0.875rem; color: #6b7280; line-height: 1.6;">
      Signed in with the wrong email?
      <button type="button" id="alloro-member-signout" style="background: none; border: 0; padding: 0; color: ${brandColor}; font: inherit; font-weight: 600; text-decoration: underline; cursor: pointer;">Sign out</button>
      and sign in again.
    </p>
    <p style="margin-top: 3rem; font-size: 0.75rem; color: #9ca3af;">
      Powered by <span style="color: ${brandColor}; font-weight: 600;">Alloro</span>
    </p>
  </div>
</div>
<script>
(function () {
  var button = document.getElementById('alloro-member-signout');
  if (!button) return;
  button.addEventListener('click', function () {
    button.disabled = true;
    fetch('/_members/signout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }).then(function () {
      window.location.href = '/member-login?next=' + encodeURIComponent(window.location.pathname + window.location.search);
    }).catch(function () {
      button.disabled = false;
    });
  });
})();
</script>`;

  return wrapInLayout(title, body).replace('</head>', '<meta name="robots" content="noindex, nofollow">\n</head>');
}
