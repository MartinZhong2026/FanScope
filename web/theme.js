/* FanScope theme state. No credentials, no remote requests. */
(function(){
  const key='fanscope-theme';
  const permitted=['dark','light','system'];
  let pref='dark';
  try { const saved=localStorage.getItem(key); if(permitted.includes(saved))pref=saved; }catch{}
  const resolved=()=>pref==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):pref;
  const paint=()=>{document.documentElement.dataset.theme=resolved();document.documentElement.dataset.themePreference=pref;const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=resolved()==='dark'?'#101827':'#F4F7FA';};
  window.FanScopeTheme={get preference(){return pref;},get resolved(){return resolved();},set(next){if(!permitted.includes(next))return;pref=next;try{localStorage.setItem(key,next)}catch{}paint();window.dispatchEvent(new Event('fanscope-theme-change'));},cycle(){this.set(permitted[(permitted.indexOf(pref)+1)%permitted.length]);}};
  paint();
  try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{paint();window.dispatchEvent(new Event('fanscope-theme-change'));})}catch{}
})();
