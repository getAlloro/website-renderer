export interface WorktreePreviewContext { projectId: string; runId: string; candidateId?: string; path: string }

/** Pure URL translation shared by the initial HTML and the local-only browser binding. */
export function worktreePreviewDestination(raw: string, context: WorktreePreviewContext): string {
  if (!/^\/(?!\/)/.test(raw)) return raw;
  const route = `/__worktree/generation/${context.projectId}/${context.runId}`;
  const url = new URL(raw, 'http://preview.invalid');
  const selectedPath = url.pathname === route ? url.searchParams.get('path') || context.path : url.pathname;
  url.searchParams.set('path', selectedPath);
  if (context.candidateId) url.searchParams.set('candidateId', context.candidateId);
  else url.searchParams.delete('candidateId');
  return `${route}?${url.searchParams.toString()}${url.hash}`;
}

function navigationScript(context: WorktreePreviewContext): string {
  const json = JSON.stringify(context).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<script data-alloro-worktree-navigation>(function(){
var context=${json}, destination=${worktreePreviewDestination.toString()};
function anchor(node){
  if(!node||!node.getAttribute||!node.matches||!node.matches('a[href]'))return;
  var raw=node.getAttribute('href');if(!raw)return;
  var next=destination(raw,context);if(next!==raw)node.setAttribute('href',next);
}
function update(root){
  if(!root)return;
  if(root.matches&&root.matches('a[href]'))anchor(root);
  if(root.querySelectorAll)root.querySelectorAll('a[href]').forEach(anchor);
}
update(document);
new MutationObserver(function(records){records.forEach(function(record){
  if(record.type==='attributes')anchor(record.target);
  else record.addedNodes.forEach(update);
})}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['href']});
['click','auxclick'].forEach(function(name){document.addEventListener(name,function(event){
  var node=event.target&&event.target.closest?event.target.closest('a[href]'):null;anchor(node);
},true)});
['pushState','replaceState'].forEach(function(name){
  var original=history[name];
  history[name]=function(state,title,raw){
    var next=raw;
    if(typeof raw==='string'&&raw.charAt(0)==='?'){
      var current=new URL(location.href), supplied=new URL(raw,location.href);
      supplied.searchParams.forEach(function(value,key){current.searchParams.set(key,value)});
      current.searchParams.set('path',context.path);
      if(context.candidateId)current.searchParams.set('candidateId',context.candidateId);
      else current.searchParams.delete('candidateId');
      if(raw.indexOf('#')!==-1)current.hash=supplied.hash;
      next=current.pathname+'?'+current.searchParams.toString()+current.hash;
    }else if(typeof raw==='string')next=destination(raw,context);
    return original.call(history,state,title,next);
  };
});
})();</script>`;
}

/** The caller is the loopback-only route; no public render path includes this binding. */
export function bindWorktreePreviewNavigation(html: string, context: WorktreePreviewContext): string {
  const translated = html.replace(/<a\b[^>]*>/gi, tag => tag.replace(/\bhref=(['"])([^'"]*)\1/gi, (_match, quote: string, raw: string) => {
    const decoded = raw.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    const value = worktreePreviewDestination(decoded, context).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return `href=${quote}${value}${quote}`;
  }));
  const script = navigationScript(context);
  return /<\/body>/i.test(translated) ? translated.replace(/<\/body>/i, () => `${script}</body>`) : translated + script;
}
