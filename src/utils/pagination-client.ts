/**
 * Client-side pagination script for Alloro site renderer.
 *
 * Returns a self-contained `<script>` + `<style>` string that handles
 * load-more, numbered, and infinite-scroll pagination for both
 * post blocks and review blocks. Injected once per page before </body>.
 */

export function getPaginationScript(): string {
  return `<style>.alloro-pg-loading{display:inline-block;width:20px;height:20px;border:2px solid #d1d5db;border-top-color:#6b7280;border-radius:50%;animation:alloro-spin .6s linear infinite}@keyframes alloro-spin{to{transform:rotate(360deg)}}.alloro-pg-error{text-align:center;padding:1rem;color:#b91c1c;font-size:.875rem}.alloro-pg-error button{margin-left:.5rem;padding:4px 12px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer}</style>
<script>(function(){
if(window.__alloroPaginationInit)return;
window.__alloroPaginationInit=true;

/* ---- helpers ---- */
function esc(s){if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function fmtDate(d){try{return new Date(d).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}catch(e){return d||''}}
function starsHtml(n){n=Math.round(Number(n)||0);var h='';for(var i=1;i<=5;i++){h+=i<=n?'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="color:#facc15;display:inline"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01z"/></svg>':'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#d1d5db;display:inline"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01z"/></svg>'}return h}

function renderItem(tpl,item,type){
  var html=tpl;
  if(type==='post'){
    html=html.replace(/\\{\\{post\\.title\\}\\}/g,function(){return esc(item.title)});
    html=html.replace(/\\{\\{post\\.slug\\}\\}/g,function(){return esc(item.slug)});
    html=html.replace(/\\{\\{post\\.url\\}\\}/g,function(){return esc(item.url)});
    html=html.replace(/\\{\\{post\\.excerpt\\}\\}/g,function(){return esc(item.excerpt)});
    html=html.replace(/\\{\\{post\\.featured_image\\}\\}/g,function(){return esc(item.featured_image)});
    html=html.replace(/\\{\\{post\\.categories\\}\\}/g,function(){return esc((item.categories||[]).join(', '))});
    html=html.replace(/\\{\\{post\\.tags\\}\\}/g,function(){return esc((item.tags||[]).join(', '))});
    html=html.replace(/\\{\\{post\\.created_at\\}\\}/g,function(){return fmtDate(item.created_at)});
    html=html.replace(/\\{\\{post\\.updated_at\\}\\}/g,function(){return fmtDate(item.updated_at)});
    html=html.replace(/\\{\\{post\\.published_at\\}\\}/g,function(){return fmtDate(item.published_at)});
    html=html.replace(/\\{\\{post\\.content\\}\\}/g,function(){return item.content||''});
    html=html.replace(/\\{\\{post\\.custom\\.(\\w+)\\}\\}/g,function(_,k){var cf=item.custom_fields||{};return esc(cf[k]!=null?cf[k]:'')});
  }else{
    html=html.replace(/\\{\\{review\\.stars\\}\\}/g,function(){return esc(item.stars)});
    html=html.replace(/\\{\\{review\\.stars_html\\}\\}/g,function(){return starsHtml(item.stars)});
    html=html.replace(/\\{\\{review\\.text\\}\\}/g,function(){return esc(item.text)});
    html=html.replace(/\\{\\{review\\.reviewer_name\\}\\}/g,function(){return esc(item.reviewer_name)});
    html=html.replace(/\\{\\{review\\.reviewer_photo\\}\\}/g,function(){return esc(item.reviewer_photo_url)});
    html=html.replace(/\\{\\{review\\.date\\}\\}/g,function(){return fmtDate(item.review_created_at)});
    html=html.replace(/\\{\\{review\\.is_anonymous\\}\\}/g,function(){return esc(item.is_anonymous)});
    html=html.replace(/\\{\\{review\\.has_reply\\}\\}/g,function(){return esc(item.has_reply)});
    html=html.replace(/\\{\\{review\\.reply_text\\}\\}/g,function(){return esc(item.reply_text)});
    html=html.replace(/\\{\\{review\\.reply_date\\}\\}/g,function(){return fmtDate(item.reply_date)});
  }
  return html;
}

function fetchPage(apiBase,page,perPage,filters){
  var url=apiBase+'?page='+page+'&per_page='+perPage;
  if(filters)url+='&'+filters;
  return fetch(url).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()});
}

function getGrid(container){return container}
function getTpl(container){try{var b=atob(container.getAttribute('data-block-template')||'');var u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return new TextDecoder().decode(u)}catch(e){return''}}

function setBtnLoading(btn,isLoading,label){
  if(isLoading){
    btn.textContent='';
    btn.style.display='inline-flex';
    btn.style.alignItems='center';
    btn.style.justifyContent='center';
    btn.style.gap='8px';
    var spinner=document.createElement('span');spinner.className='alloro-pg-loading';
    var text=document.createElement('span');text.textContent='Loading...';
    btn.appendChild(spinner);btn.appendChild(text);btn.disabled=true;
  }else{
    btn.textContent=label;btn.disabled=false;
  }
}

function applyEnhancements(root){
  (root||document).querySelectorAll('[data-truncate-words]').forEach(function(el){
    if(el.dataset.truncated==='true')return;
    var limit=parseInt(el.getAttribute('data-truncate-words'),10);
    if(!limit)return;
    var fullTitle=el.getAttribute('data-full-title')||el.textContent||'';
    var tooltip=el.querySelector('.tooltip-full');
    if(tooltip)tooltip.remove();
    var words=fullTitle.trim().split(/\\s+/).filter(Boolean);
    var wasTruncated=words.length>limit;
    el.textContent=wasTruncated?words.slice(0,limit).join(' ')+'...':fullTitle;
    if(tooltip&&wasTruncated){
      el.appendChild(tooltip);
      var showTimer=null;
      el.addEventListener('mouseenter',function(){
        showTimer=setTimeout(function(){
          tooltip.classList.remove('invisible','opacity-0','translate-y-1');
          tooltip.classList.add('opacity-100','translate-y-0');
        },100);
      });
      el.addEventListener('mouseleave',function(){
        if(showTimer){clearTimeout(showTimer);showTimer=null}
        tooltip.classList.add('invisible','opacity-0','translate-y-1');
        tooltip.classList.remove('opacity-100','translate-y-0');
      });
    }
    el.dataset.truncated='true';
  });
}

function showError(target,retryFn){
  var d=document.createElement('div');
  d.className='alloro-pg-error';
  d.textContent='Failed to load. Try again. ';
  var btn=document.createElement('button');
  btn.textContent='Retry';
  btn.addEventListener('click',function(){d.remove();retryFn()});
  d.appendChild(btn);
  target.appendChild(d);
}

/* ---- mode handlers ---- */

function findControls(container,sel){var p=container.parentElement;while(p){var c=p.querySelector(sel);if(c)return c;p=p.parentElement}return document.querySelector(sel)}

function initLoadMore(container){
  var ctrl=findControls(container,'[data-alloro-pagination-controls]');
  if(!ctrl)return;
  var btn=ctrl.querySelector('[data-alloro-load-more]');
  if(!btn)return;
  var tpl=getTpl(container),type=container.getAttribute('data-paginate-type')||'post';
  var grid=getGrid(container);

  btn.addEventListener('click',function(){
    var cur=parseInt(container.getAttribute('data-current-page'),10)||1;
    var total=parseInt(container.getAttribute('data-total-pages'),10)||1;
    var next=cur+1;
    if(next>total)return;
    var orig=btn.textContent;
    setBtnLoading(btn,true,orig);
    var perPage=container.getAttribute('data-per-page')||'9';
    var filters=container.getAttribute('data-filters')||'';
    var apiBase=container.getAttribute('data-api-base')||'';
    var key=type==='review'?'reviews':'posts';

    fetchPage(apiBase,next,perPage,filters).then(function(data){
      var items=data[key]||[];
      items.forEach(function(item){
        var rendered=renderItem(tpl,item,type);
        grid.insertAdjacentHTML('beforeend',rendered);
      });
      applyEnhancements(grid);
      container.setAttribute('data-current-page',String(next));
      setBtnLoading(btn,false,orig);
      if(next>=total){ctrl.style.display='none'}
    }).catch(function(){
      setBtnLoading(btn,false,orig);
      showError(ctrl,function(){btn.click()});
    });
  });
}

function initNumbered(container){
  var nav=findControls(container,'[data-alloro-numbered-pagination]');
  if(!nav)return;
  var tpl=getTpl(container),type=container.getAttribute('data-paginate-type')||'post';
  var grid=getGrid(container);
  var perPage=container.getAttribute('data-per-page')||'9';
  var filters=container.getAttribute('data-filters')||'';
  var apiBase=container.getAttribute('data-api-base')||'';
  var key=type==='review'?'reviews':'posts';

  function renderNav(cur,total){
    while(nav.firstChild)nav.removeChild(nav.firstChild);
    if(total<=1)return;
    var pages=[];
    for(var i=1;i<=total;i++){
      if(i<=2||i>total-2||Math.abs(i-cur)<=2)pages.push(i);
      else if(pages[pages.length-1]!==0)pages.push(0);
    }
    function mkBtn(label,pg,disabled,active){
      var b=document.createElement('button');
      b.textContent=label;
      b.style.cssText='padding:6px 12px;border:1px solid '+(active?'#374151':'#d1d5db')+';border-radius:6px;background:'+(active?'#374151':'#fff')+';color:'+(active?'#fff':'#374151')+';cursor:'+(disabled?'default':'pointer')+';font-size:.875rem';
      if(disabled)b.disabled=true;
      if(!disabled)b.addEventListener('click',function(){goToPage(pg)});
      return b;
    }
    nav.appendChild(mkBtn('\\u2039 Prev',cur-1,cur<=1,false));
    pages.forEach(function(p){
      if(p===0){var s=document.createElement('span');s.textContent='\\u2026';s.style.cssText='padding:6px 4px;color:#9ca3af';nav.appendChild(s)}
      else nav.appendChild(mkBtn(String(p),p,false,p===cur));
    });
    nav.appendChild(mkBtn('Next \\u203a',cur+1,cur>=total,false));
  }

  function goToPage(pg){
    var total=parseInt(container.getAttribute('data-total-pages'),10)||1;
    if(pg<1||pg>total)return;
    while(nav.firstChild)nav.removeChild(nav.firstChild);
    var spinner=document.createElement('span');spinner.className='alloro-pg-loading';nav.appendChild(spinner);
    fetchPage(apiBase,pg,perPage,filters).then(function(data){
      var items=data[key]||[];
      while(grid.firstChild)grid.removeChild(grid.firstChild);
      items.forEach(function(item){
        var rendered=renderItem(tpl,item,type);
        grid.insertAdjacentHTML('beforeend',rendered);
      });
      applyEnhancements(grid);
      container.setAttribute('data-current-page',String(pg));
      container.setAttribute('data-total-pages',String(data.total_pages||total));
      renderNav(pg,data.total_pages||total);
      history.pushState({alloroPage:pg},'','?page='+pg);
    }).catch(function(){
      renderNav(parseInt(container.getAttribute('data-current-page'),10)||1,total);
      showError(nav,function(){goToPage(pg)});
    });
  }

  var initPage=parseInt(new URLSearchParams(window.location.search).get('page'),10)||1;
  var totalPages=parseInt(container.getAttribute('data-total-pages'),10)||1;
  if(initPage>1&&initPage<=totalPages){
    goToPage(initPage);
  }else{
    renderNav(1,totalPages);
  }

  window.addEventListener('popstate',function(e){
    var pg=(e.state&&e.state.alloroPage)?e.state.alloroPage:parseInt(new URLSearchParams(window.location.search).get('page'),10)||1;
    goToPage(pg);
  });
}

function initInfinite(container){
  var sentinel=findControls(container,'[data-alloro-scroll-sentinel]');
  if(!sentinel)return;
  var tpl=getTpl(container),type=container.getAttribute('data-paginate-type')||'post';
  var grid=getGrid(container);
  var perPage=container.getAttribute('data-per-page')||'9';
  var filters=container.getAttribute('data-filters')||'';
  var apiBase=container.getAttribute('data-api-base')||'';
  var key=type==='review'?'reviews':'posts';
  var loading=false;

  var loader=document.createElement('div');
  loader.style.cssText='text-align:center;padding:1rem;display:none';
  var loaderSpinner=document.createElement('span');loaderSpinner.className='alloro-pg-loading';
  loader.appendChild(loaderSpinner);
  sentinel.parentNode.insertBefore(loader,sentinel);

  var observer=new IntersectionObserver(function(entries){
    if(!entries[0].isIntersecting||loading)return;
    var cur=parseInt(container.getAttribute('data-current-page'),10)||1;
    var total=parseInt(container.getAttribute('data-total-pages'),10)||1;
    var next=cur+1;
    if(next>total){observer.disconnect();return}
    loading=true;loader.style.display='block';

    fetchPage(apiBase,next,perPage,filters).then(function(data){
      var items=data[key]||[];
      items.forEach(function(item){
        var rendered=renderItem(tpl,item,type);
        grid.insertAdjacentHTML('beforeend',rendered);
      });
      applyEnhancements(grid);
      container.setAttribute('data-current-page',String(next));
      loading=false;loader.style.display='none';
      if(next>=total)observer.disconnect();
    }).catch(function(){
      loading=false;loader.style.display='none';
      showError(sentinel.parentNode,function(){loading=false;observer.observe(sentinel)});
      observer.disconnect();
    });
  },{rootMargin:'200px'});

  observer.observe(sentinel);
}

/* ---- init ---- */
document.querySelectorAll('[data-alloro-paginated]').forEach(function(el){
  applyEnhancements(el);
  var mode=el.getAttribute('data-paginate-mode');
  if(mode==='load-more')initLoadMore(el);
  else if(mode==='numbered')initNumbered(el);
  else if(mode==='infinite')initInfinite(el);
});

})();<` + `/script>`;
}
