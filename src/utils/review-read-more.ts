/**
 * "Read more" for long review text, on every template's review blocks.
 *
 * Server side, markReviewTextElement() tags the element that holds
 * {{review.text}} in a block's review loop. Client side, the string from
 * getReviewReadMoreScript() clamps tagged text to REVIEW_TEXT_LINES lines and
 * adds a Read more / Show less button only under text that is actually cut off.
 * The full text stays in the HTML; the clamp is visual only.
 */

export const REVIEW_TEXT_ATTR = 'data-alloro-review-text';
export const REVIEW_TEXT_LINES = 6;

// The v1 Alloro Dental carousel ships its own Read more toggle, so its block is left as it is.
const OWN_READ_MORE_ATTR = 'data-review-toggle';

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

// An opening tag whose first content is {{review.text}}, optionally after whitespace and an
// opening quote mark. A token inside an attribute value is never preceded by `>`, so it never matches.
const TEXT_ELEMENT_PATTERN = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*)?>(\s*["'“]?\s*)\{\{review\.text\}\}/g;

/**
 * True when a review block already carries its own Read more control.
 */
export function hasOwnReadMore(blockHtml: string): boolean {
  return blockHtml.includes(OWN_READ_MORE_ATTR);
}

/**
 * Tag the element that holds {{review.text}} in a review loop template.
 * Returns the template unchanged when no element directly holds the token.
 */
export function markReviewTextElement(loopTemplate: string): string {
  return loopTemplate.replace(
    TEXT_ELEMENT_PATTERN,
    (match, tag: string, attrs: string | undefined, lead: string) => {
      const attributes = attrs || '';
      if (VOID_TAGS.has(tag.toLowerCase()) || attributes.includes(REVIEW_TEXT_ATTR)) return match;
      return `<${tag}${attributes} ${REVIEW_TEXT_ATTR}>${lead}{{review.text}}`;
    }
  );
}

/**
 * Returns a self-contained `<style>` + `<script>` string, injected once per page
 * before </body> when any review text was tagged.
 *
 * The max-height in `lh` (one line of the element's own text) matters: when a grid or flex
 * row stretches a short card, line-clamp alone lets the taller box show lines past the "…".
 */
export function getReviewReadMoreScript(): string {
  return `<style>[${REVIEW_TEXT_ATTR}]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${REVIEW_TEXT_LINES};line-clamp:${REVIEW_TEXT_LINES};max-height:${REVIEW_TEXT_LINES}lh;overflow:hidden}[${REVIEW_TEXT_ATTR}][data-alloro-expanded]{display:block!important;-webkit-line-clamp:unset!important;line-clamp:none!important;max-height:none!important;overflow:visible!important}[data-alloro-review-more]{display:inline-block;margin:.5rem 0 0;padding:0;border:0;background:none;color:inherit;font:inherit;font-weight:600;line-height:1.4;text-decoration:underline;text-underline-offset:3px;cursor:pointer}[data-alloro-review-more][hidden]{display:none!important}[data-alloro-review-more]:focus-visible{outline:2px solid currentColor;outline-offset:2px;border-radius:2px}</style>
<script>(function(){
if(window.__alloroReviewReadMoreInit)return;
window.__alloroReviewReadMoreInit=true;
var SEL='[${REVIEW_TEXT_ATTR}]',BTN='data-alloro-review-more',OPEN='data-alloro-expanded';
var seen=typeof WeakSet==='function'?new WeakSet():null;
var ro=typeof ResizeObserver==='function'?new ResizeObserver(function(entries){entries.forEach(function(e){sync(e.target)})}):null;

function buttonFor(el){var n=el.nextElementSibling;return n&&n.hasAttribute(BTN)?n:null}

/* The button sits right after the text, so the clamp never hides it. It copies the text's size,
   color and indent so it reads as part of the review on any template. */
function makeButton(el){
  var b=document.createElement('button');
  b.type='button';b.setAttribute(BTN,'');b.setAttribute('aria-expanded','false');b.textContent='Read more';
  var cs=getComputedStyle(el);
  b.style.fontSize=cs.fontSize;b.style.color=cs.color;
  var indent=(parseFloat(cs.marginLeft)||0)+(parseFloat(cs.paddingLeft)||0);
  if(indent>0)b.style.marginLeft=indent+'px';
  var side=cs.textAlign==='center'?'center':'start';
  b.style.justifySelf=side;b.style.alignSelf=side;
  var parent=el.parentElement?getComputedStyle(el.parentElement):null;
  if(parent&&/grid|flex/.test(parent.display)&&(parseFloat(parent.rowGap)||0)>0)b.style.marginTop='0';
  el.insertAdjacentElement('afterend',b);
  return b;
}

/* Show the button only while text is actually cut off. Re-run whenever the text's box changes. */
function sync(el){
  if(el.hasAttribute(OPEN))return;
  var b=buttonFor(el);
  var cut=el.scrollHeight-el.clientHeight>1;
  if(cut&&!b)b=makeButton(el);
  if(b)b.hidden=!cut;
}

function track(el){
  if(seen){if(seen.has(el))return;seen.add(el)}
  sync(el);
  if(ro)ro.observe(el);
}

function scan(root){
  if(!root||(root.nodeType!==1&&root.nodeType!==9))return;
  if(root.nodeType===1&&root.matches(SEL))track(root);
  var list=root.querySelectorAll(SEL);
  for(var i=0;i<list.length;i++)track(list[i]);
}

function resyncAll(){
  var list=document.querySelectorAll(SEL);
  for(var i=0;i<list.length;i++)sync(list[i]);
}

document.addEventListener('click',function(e){
  var b=e.target&&e.target.closest?e.target.closest('['+BTN+']'):null;
  if(!b)return;
  var el=b.previousElementSibling;
  if(!el||!el.matches(SEL))return;
  e.preventDefault();
  var open=!el.hasAttribute(OPEN);
  if(open)el.setAttribute(OPEN,'');else el.removeAttribute(OPEN);
  b.textContent=open?'Show less':'Read more';
  b.setAttribute('aria-expanded',open?'true':'false');
});

scan(document);
/* Reviews added later by Load more or numbered pages arrive as new nodes. */
if(typeof MutationObserver==='function'&&document.body){
  new MutationObserver(function(muts){
    muts.forEach(function(m){for(var i=0;i<m.addedNodes.length;i++)scan(m.addedNodes[i])});
  }).observe(document.body,{childList:true,subtree:true});
}
window.addEventListener('load',resyncAll);
if(!ro)window.addEventListener('resize',resyncAll);
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(resyncAll);
})();</script>`;
}
