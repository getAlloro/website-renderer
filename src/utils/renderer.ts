import type { Section, SeoData } from '../types';

/**
 * Generates an inline <script> that auto-intercepts all forms on the page
 * and POSTs their contents to the Alloro form-submission API.
 * Forms with `data-alloro-ignore` are skipped.
 *
 * Security layers injected:
 * - Honeypot hidden field (_hp) — bots fill it, humans don't
 * - Timestamp (_ts) — recorded at page load, validated server-side
 */
function buildFormScript(projectId: string, apiBase: string): string {
  return `<script data-alloro-form-handler>
(function(){
  'use strict';
  var _ts=Date.now();
  var _jsc=_ts;for(var i=0;i<1000;i++){_jsc=((_jsc*1103515245+12345)&0x7fffffff);}
  // FIRST-TOUCH ATTRIBUTION. Captured once per session, on the first page seen,
  // so the channel recorded is the one that brought the visitor to THIS visit.
  // The referrer goes up RAW: classification stays server-side in
  // controllers/websiteContact/feature-utils/sourceAttribution.ts, where it is
  // testable and earns the stronger client_referrer tier. An empty capture is
  // still stored - presence of the key marks "first page seen", so a later
  // internal referrer can never masquerade as the entry channel.
  // Storage failures (private mode, disabled) must never break the form.
  var _ft=null;
  try{
    var _ftRaw=window.sessionStorage.getItem('_alloro_ft');
    if(_ftRaw){_ft=JSON.parse(_ftRaw);}
    if(!_ft||typeof _ft!=='object'){
      var _um=window.location.search.match(/[?&]utm_source=([^&#]*)/);
      var _u='';
      if(_um&&_um[1]){try{_u=decodeURIComponent(_um[1].replace(/\\+/g,' '));}catch(_e){_u=_um[1];}}
      _ft={r:String(document.referrer||'').slice(0,2048),u:_u.slice(0,100)};
      window.sessionStorage.setItem('_alloro_ft',JSON.stringify(_ft));
    }
  }catch(_e){_ft=null;}
  document.addEventListener('DOMContentLoaded',function(){
    var API='${apiBase}';
    var PID='${projectId}';
    var forms=document.querySelectorAll('form:not([data-alloro-ignore])');
    forms.forEach(function(form){
      var hp=document.createElement('input');
      hp.type='text';hp.name='website_url';hp.tabIndex=-1;hp.autocomplete='off';
      hp.setAttribute('aria-hidden','true');
      hp.style.cssText='position:absolute;left:-9999px;opacity:0;height:0;width:0;overflow:hidden;';
      form.appendChild(hp);
      var badge=document.createElement('a');
      badge.href='https://getalloro.com/alloro-protect';
      badge.target='_blank';badge.rel='noopener noreferrer';
      badge.style.cssText='display:flex;align-items:center;justify-content:center;gap:4px;margin-top:8px;text-decoration:none;';
      var dColor='rgba(0,0,0,0.25)';var hColor='rgba(214,104,83,0.65)';
      badge.onmouseenter=function(){lbl.style.color=hColor;lbl.style.textShadow='0 1px 2px rgba(214,104,83,0.2)';path.style.fill=hColor;};
      badge.onmouseleave=function(){lbl.style.color=dColor;lbl.style.textShadow='0 1px 1px rgba(0,0,0,0.1)';path.style.fill=dColor;};
      var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('width','12');svg.setAttribute('height','12');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');
      var path=document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d','M12 2l7 4v5c0 5.25-3.5 10-7 12-3.5-2-7-6.75-7-12V6l7-4z');path.style.fill=dColor;path.style.transition='fill 0.2s ease';
      svg.appendChild(path);
      var lbl=document.createElement('span');
      lbl.textContent='Powered by Alloro Protect\\u2122';
      lbl.style.cssText='font-size:11px;color:'+dColor+';font-family:system-ui,sans-serif;text-shadow:0 1px 1px rgba(0,0,0,0.1);transition:color 0.2s ease,text-shadow 0.2s ease;';
      badge.appendChild(svg);badge.appendChild(lbl);
      form.parentNode.insertBefore(badge,form.nextSibling);
      form.addEventListener('submit',function(e){
        e.preventDefault();
        var formName=form.getAttribute('data-form-name')||form.getAttribute('name')||'Contact Form';
        var formType=form.getAttribute('data-form-type')||'contact';
        var contents={};
        var inputs=form.querySelectorAll('input,select,textarea');
        inputs.forEach(function(el){
          if(el.tabIndex===-1||el.type==='submit'||el.type==='hidden'||el.type==='button')return;
          var label=el.getAttribute('data-label')||el.getAttribute('name')||el.getAttribute('placeholder')||'';
          if(!label)return;
          if(el.type==='checkbox'){
            if(el.checked){
              contents[label]=contents[label]?contents[label]+', '+el.value:el.value;
            }
          }else if(el.type==='radio'){
            if(el.checked){
              contents[label]=el.value;
            }
          }else if(el.tagName==='SELECT'){
            var opt=el.options[el.selectedIndex];
            if(opt&&opt.value){
              contents[label]=opt.textContent.trim();
            }
          }else{
            var v=el.value.trim();
            if(v)contents[label]=v;
          }
        });
        var btn=form.querySelector('button[type="submit"],input[type="submit"]');
        var origText=btn?btn.textContent:'';
        if(btn){btn.disabled=true;btn.textContent='Sending...';}
        var payload={projectId:PID,formName:formName,formType:formType,contents:contents,_hp:hp.value,_ts:_ts,_jsc:_jsc};
        if(_ft&&_ft.r){payload.first_touch_referrer=_ft.r;}
        if(_ft&&_ft.u){payload.utm_source=_ft.u;}
        fetch(API+'/api/websites/form-submission',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(payload)
        })
        .then(function(r){if(!r.ok)throw new Error('fail');return r.json();})
        .then(function(){
          window.location.href=formType==='newsletter'?'/newsletter-success':'/success';
        })
        .catch(function(){
          if(btn){btn.textContent='Error \\u2014 Try Again';btn.style.backgroundColor='#dc2626';}
          setTimeout(function(){if(btn){btn.disabled=false;btn.textContent=origText;btn.style.backgroundColor='';}},3000);
        });
      });
    });
  });
})();
</script>`;
}

/**
 * Unwrap sections whether stored as Section[] or { sections: Section[] }.
 * N8N writes directly to the DB with the wrapped format; our API writes the bare array.
 */
export function normalizeSections(raw: unknown): Section[] {
  if (Array.isArray(raw)) return raw;
  if (
    raw &&
    typeof raw === 'object' &&
    'sections' in raw &&
    Array.isArray((raw as { sections: unknown }).sections)
  ) {
    return (raw as { sections: Section[] }).sections;
  }
  return [];
}

/**
 * Inject code snippets into HTML at specified locations
 */
function injectCodeSnippets(
  html: string,
  snippets: any[],
  currentPageId?: string
): string {
  // 1. Filter enabled snippets
  const enabled = snippets.filter((s) => s.is_enabled);

  // 2. Filter by page targeting
  const targeted = enabled.filter((s) => {
    if (!s.page_ids || s.page_ids.length === 0) return true; // All pages
    if (!currentPageId) return true; // Show all in preview
    return s.page_ids.includes(currentPageId);
  });

  // 3. Group by location and sort by order_index
  const byLocation = {
    head_start: targeted
      .filter((s) => s.location === 'head_start')
      .sort((a, b) => a.order_index - b.order_index),
    head_end: targeted
      .filter((s) => s.location === 'head_end')
      .sort((a, b) => a.order_index - b.order_index),
    body_start: targeted
      .filter((s) => s.location === 'body_start')
      .sort((a, b) => a.order_index - b.order_index),
    body_end: targeted
      .filter((s) => s.location === 'body_end')
      .sort((a, b) => a.order_index - b.order_index),
  };

  // 4. Inject at each location
  let result = html;

  if (byLocation.head_start.length > 0) {
    const code = byLocation.head_start.map((s) => s.code).join('\n');
    result = result.replace(/<head>/i, `<head>\n${code}`);
  }

  if (byLocation.head_end.length > 0) {
    const code = byLocation.head_end.map((s) => s.code).join('\n');
    result = result.replace(/<\/head>/i, `${code}\n</head>`);
  }

  if (byLocation.body_start.length > 0) {
    const code = byLocation.body_start.map((s) => s.code).join('\n');
    result = result.replace(/<body([^>]*)>/i, `<body$1>\n${code}`);
  }

  if (byLocation.body_end.length > 0) {
    const code = byLocation.body_end.map((s) => s.code).join('\n');
    result = result.replace(/<\/body>/i, `${code}\n</body>`);
  }

  return result;
}

/**
 * Strip honeypot inputs and "Powered by Alloro Protect" badges that were
 * accidentally baked into section content by the N8N headless rendering
 * pipeline. The form script adds these at runtime — they should never be
 * persisted in section HTML.
 */
function stripFormArtifacts(html: string): string {
  return html
    .replace(/<input[^>]*name="website_url"[^>]*tabindex="-1"[^>]*>/gi, '')
    .replace(/<a[^>]*href="https:\/\/getalloro\.com\/alloro-protect"[^>]*>[\s\S]*?<\/a>/gi, '');
}

/**
 * Check if an HTML string's root element has data-alloro-hidden="true".
 */
function isHiddenElement(html: string): boolean {
  const openTagMatch = html.match(/^[\s]*<[^>]+>/);
  if (!openTagMatch) return false;
  return /data-alloro-hidden\s*=\s*["']true["']/.test(openTagMatch[0]);
}

/**
 * Remove any nested elements that have data-alloro-hidden="true" from an HTML string.
 * Uses a non-greedy regex that matches the opening tag through the corresponding
 * closing tag. Works reliably for alloro-tpl component wrappers which don't
 * nest other alloro-tpl elements inside them.
 */
function stripHiddenElements(html: string): string {
  // Match elements whose opening tag contains data-alloro-hidden="true".
  // Pattern: <tagname ...data-alloro-hidden="true"...>...content...</tagname>
  // We capture the tag name so we can match its closing tag.
  return html.replace(
    /<(\w+)\b[^>]*\bdata-alloro-hidden\s*=\s*["']true["'][^>]*>[\s\S]*?<\/\1>/g,
    ''
  );
}

/**
 * Assemble a full HTML page from project wrapper/header/footer and page sections.
 *
 * wrapper.replace('{{slot}}', header + sections + footer)
 *
 * @param codeSnippets – optional code snippets to inject
 * @param currentPageId – optional page ID for snippet targeting
 */
export function renderPage(
  wrapper: string,
  header: string,
  footer: string,
  sections: Section[],
  codeSnippets?: any[],
  currentPageId?: string,
  projectId?: string,
  apiBaseUrl?: string
): string {
  const visibleSections = sections.filter(
    (s) => !isHiddenElement(s.content)
  );
  const mainContent = visibleSections
    .map((s) => stripFormArtifacts(stripHiddenElements(s.content)))
    .join('\n');
  const pageContent = [
    stripFormArtifacts(stripHiddenElements(header)),
    mainContent,
    stripFormArtifacts(stripHiddenElements(footer)),
  ].join('\n');

  if (!wrapper.includes('{{slot}}')) {
    return [
      '<!doctype html><html><head><meta charset="UTF-8"></head><body>',
      '<div style="max-width:600px;margin:80px auto;font-family:system-ui;text-align:center">',
      '<h1 style="font-size:1.5rem;color:#991b1b">Configuration Error</h1>',
      '<p style="color:#6b7280;margin-top:12px">The site wrapper is missing the <code>{{slot}}</code> placeholder. Page content cannot be rendered.</p>',
      '</div></body></html>',
    ].join('\n');
  }

  // Strip any baked-in form handler scripts from the wrapper before assembly
  const cleanWrapper = wrapper.replace(
    /<script data-alloro-form-handler>[\s\S]*?<\/script>/gi,
    ''
  );
  let finalHtml = cleanWrapper.replace('{{slot}}', pageContent);

  // Inject code snippets
  if (codeSnippets && codeSnippets.length > 0) {
    finalHtml = injectCodeSnippets(finalHtml, codeSnippets, currentPageId);
  }

  // Inject default form submission handler on all pages
  // The renderer is the sole authority for this script — any baked-in copies
  // were already stripped from the wrapper and section content above.
  if (projectId && apiBaseUrl) {
    const formScript = buildFormScript(projectId, apiBaseUrl);
    finalHtml = finalHtml.replace(/<\/body>/i, `${formScript}\n</body>`);
  }

  return finalHtml;
}

// =====================================================================
// SEO META TAG INJECTION
// =====================================================================

/**
 * Replace an existing meta tag or inject a new one before </head>.
 * Uses case-insensitive matching.
 *
 * @param html - Full HTML string
 * @param attr - The attribute to match (e.g., 'name="description"' or 'property="og:title"')
 * @param fullTag - The full replacement tag (e.g., '<meta name="description" content="...">')
 */
function replaceOrInjectMeta(html: string, attr: string, fullTag: string): string {
  // Build regex to find existing tag with this attribute
  const escapedAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingRegex = new RegExp(`<meta\\s+[^>]*${escapedAttr}[^>]*/?>`, 'i');

  if (existingRegex.test(html)) {
    return html.replace(existingRegex, fullTag);
  }

  // Inject before </head>
  return html.replace(/<\/head>/i, `${fullTag}\n</head>`);
}

/**
 * Replace an existing <link> tag or inject a new one before </head>.
 */
function replaceOrInjectLink(html: string, relAttr: string, fullTag: string): string {
  const escapedAttr = relAttr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingRegex = new RegExp(`<link\\s+[^>]*${escapedAttr}[^>]*/?>`, 'i');

  if (existingRegex.test(html)) {
    return html.replace(existingRegex, fullTag);
  }

  return html.replace(/<\/head>/i, `${fullTag}\n</head>`);
}

/**
 * Escape a string for safe use in HTML attribute values.
 */
function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Where a page/post is actually being served — drives canonical/og:url self-derivation. */
export interface ServingContext {
  /** The project's primary public host (custom domain, or generated hostname + .sites.getalloro.com). */
  host: string;
  /** The entity's real serving path (page path, or /{post_type.slug}/{post.slug}). */
  path: string;
}

function normalizeComparablePath(p: string): string {
  const trimmed = (p || '').trim();
  if (!trimmed) return '/';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

/**
 * The canonical URL this render declares: always the self-referencing absolute
 * URL on the site's one canonical host (primaryPublicHost) + real serving
 * path. The stored seo_data.canonical_url is intentionally ignored — it was
 * the source of every canonical defect (fabricated paths, wrong hosts, and a
 * relative/absolute format mix left by the 2026-07-02 data repairs). Deriving
 * it here makes canonical/og:url uniform site-wide and consistent with the
 * host-unification redirect, the sitemap, and robots (all share
 * primaryPublicHost).
 */
function resolveCanonical(_stored: unknown, serving: ServingContext): string {
  return `https://${serving.host}${normalizeComparablePath(serving.path)}`;
}

/**
 * Inject page-level SEO meta tags into assembled HTML.
 *
 * Smart duplicate handling:
 * - If a matching tag already exists in the wrapper → replace it
 * - If not → inject before </head>
 * - Never duplicates
 *
 * When a ServingContext is provided, canonical + og:url are ALWAYS emitted —
 * self-derived from the serving URL when the stored value is absent or junk —
 * even when seoData itself is null (previously, entities with no seo_data
 * shipped with no canonical at all, and stored junk was emitted verbatim).
 */
export function injectSeoMeta(
  html: string,
  seoData: SeoData | null,
  serving?: ServingContext
): string {
  if (!seoData && !serving) return html;

  let result = html;

  if (serving) {
    const canonical = resolveCanonical(seoData?.canonical_url, serving);
    result = replaceOrInjectLink(
      result,
      'rel="canonical"',
      `<link rel="canonical" href="${escapeAttr(canonical)}">`
    );
    result = replaceOrInjectMeta(
      result,
      'property="og:url"',
      `<meta property="og:url" content="${escapeAttr(canonical)}">`
    );
  }

  if (!seoData) return result;

  // 1. Title tag
  if (seoData.meta_title) {
    const escapedTitle = escapeAttr(seoData.meta_title);
    const titleRegex = /<title>[^<]*<\/title>/i;
    if (titleRegex.test(result)) {
      result = result.replace(titleRegex, `<title>${escapedTitle}</title>`);
    } else {
      result = result.replace(/<\/head>/i, `<title>${escapedTitle}</title>\n</head>`);
    }
  }

  // 2. Meta description
  if (seoData.meta_description) {
    result = replaceOrInjectMeta(
      result,
      'name="description"',
      `<meta name="description" content="${escapeAttr(seoData.meta_description)}">`
    );
  }

  // 3. Canonical URL — legacy verbatim emit, only for callers with no
  // ServingContext (all live render paths pass one; the self-derived
  // canonical above already handled it and must not be overwritten).
  if (!serving && seoData.canonical_url) {
    result = replaceOrInjectLink(
      result,
      'rel="canonical"',
      `<link rel="canonical" href="${escapeAttr(seoData.canonical_url)}">`
    );
  }

  // 4. Robots directive
  if (seoData.robots) {
    result = replaceOrInjectMeta(
      result,
      'name="robots"',
      `<meta name="robots" content="${escapeAttr(seoData.robots)}">`
    );
  }

  // 5. Max image preview (appended to robots or as separate tag)
  if (seoData.max_image_preview) {
    result = replaceOrInjectMeta(
      result,
      'name="robots" content="max-image-preview',
      `<meta name="robots" content="max-image-preview:${escapeAttr(seoData.max_image_preview)}">`
    );
  }

  // 6. Open Graph tags
  if (seoData.og_title) {
    result = replaceOrInjectMeta(
      result,
      'property="og:title"',
      `<meta property="og:title" content="${escapeAttr(seoData.og_title)}">`
    );
  }

  if (seoData.og_description) {
    result = replaceOrInjectMeta(
      result,
      'property="og:description"',
      `<meta property="og:description" content="${escapeAttr(seoData.og_description)}">`
    );
  }

  if (seoData.og_image) {
    result = replaceOrInjectMeta(
      result,
      'property="og:image"',
      `<meta property="og:image" content="${escapeAttr(seoData.og_image)}">`
    );
  }

  if (seoData.og_type) {
    result = replaceOrInjectMeta(
      result,
      'property="og:type"',
      `<meta property="og:type" content="${escapeAttr(seoData.og_type)}">`
    );
  }

  // 7. OG URL (matches canonical) — legacy verbatim emit, only when no
  // ServingContext (see canonical note above).
  if (!serving && seoData.canonical_url) {
    result = replaceOrInjectMeta(
      result,
      'property="og:url"',
      `<meta property="og:url" content="${escapeAttr(seoData.canonical_url)}">`
    );
  }

  // 8. JSON-LD schema blocks — inject before </head>
  if (seoData.schema_json && Array.isArray(seoData.schema_json) && seoData.schema_json.length > 0) {
    const schemaBlocks = seoData.schema_json
      .map((schema) => `<script type="application/ld+json">${JSON.stringify(schema)}</script>`)
      .join('\n');
    result = result.replace(/<\/head>/i, `${schemaBlocks}\n</head>`);
  }

  return result;
}
