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
    <div aria-hidden="true" style="display: inline-flex; align-items: center; justify-content: center; width: 4.5rem; height: 4.5rem; margin-bottom: 1.5rem; border-radius: 9999px; background-color: ${brandColor}1a; color: ${brandColor};">
      <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    </div>
    <h1 style="color: #1f2937; font-size: 1.75rem; font-weight: 700; margin-bottom: 0.75rem;">
      This page is for another group.
    </h1>
    <p style="color: #6b7280; font-size: 1rem; line-height: 1.6; margin-bottom: 2rem;">
      You are signed in, but your membership does not include this page. If you think it should, ask the person who invited you.
    </p>
    <a href="/" style="display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1.5rem; background-color: ${brandColor}; color: white; border-radius: 0.75rem; text-decoration: none; font-weight: 600; font-size: 0.875rem; box-shadow: 0 4px 14px ${brandColor}40;">
      ${icons.arrowLeft}
      Back to the homepage
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
