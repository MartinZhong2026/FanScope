// Shared, dependency-free mobile navigation presentation. Static route descriptors only.
// Icons are local SVG paths; no CDN, API key or runtime font dependency.
const paths = {
  filter: '<path d="M3 4h18l-7 8v7l-4 2v-9z"/>',
  theme: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 19 5M12 3v3"/>',
  trend: '<path d="M3 3v18h18"/><path d="m6 15 5-5 4 3 5-7"/>',
  journal: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18M12 8h5M12 12h5M12 16h4"/>',
  ai: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  project: '<rect x="3" y="6" width="18" height="15" rx="2"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18"/>',
  manuscript: '<path d="M7 3h8l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM15 3v5h4M9 12h6M9 16h6"/>',
  meeting: '<rect x="6" y="3" width="12" height="13" rx="6"/><path d="M3 11a9 9 0 0 0 18 0M12 20v2m-4 0h8"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 10h18c0-2-3-3-3-10zM10 21h4"/>',
  health: '<path d="M4 12h4l2-5 4 10 2-5h4"/><path d="M3 6a10 10 0 0 1 18 0M3 18a10 10 0 0 0 18 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  arrow: '<path d="m15 18-6-6 6-6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 17v4h16v-4"/>',
  shield: '<path d="m12 2 8 4v6c0 5-3 8-8 10-5-2-8-5-8-10V6z"/>',
};
export const mobileIcon = (name, size=26) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.home}</svg>`;

// A single tab bar is used by Radar and Lab. The URL is the source of truth.
export const mobileQuery='(max-width:820px), (max-width:1100px) and (hover:none) and (pointer:coarse) and (max-height:600px)';
export const appTabs=[
 {page:'home',name:'首页',icon:'home'},
 {page:'feed',name:'文献',icon:'search'},
 {page:'trends',name:'趋势',icon:'trend'},
 {page:'projects',name:'项目',icon:'project'},
];
export function mobileDock(page,{lab=false}={}){
 const current=lab?'projects':page==='article'?'feed':page;
 return `<nav class="mobile-dock" aria-label="主要导航">${appTabs.map(t=>{
  const active=t.page===current?'aria-current="page"':'';
  return t.page==='projects'?`<a href="/lab/?view=projects" ${active}>${mobileIcon(t.icon,22)}<span>${t.name}</span></a>`:lab?`<a href="/?page=${t.page}" ${active}>${mobileIcon(t.icon,22)}<span>${t.name}</span></a>`:`<button type="button" data-page="${t.page}" ${active}>${mobileIcon(t.icon,22)}<span>${t.name}</span></button>`;
 }).join('')}</nav>`;
}
export function mobileHeader(title,{home=false,lab=false,page=''}={}){
 const leading=home?`<span class="app-mark"><img src="/assets/favicon.svg" width="28" height="28" alt=""></span><strong>FanScope<small>RESEARCH WORKSPACE</small></strong>`:`<button type="button" data-app-back aria-label="返回">${mobileIcon('arrow',22)}</button><strong>FanScope<small class="header-page-name">${title}</small></strong>`;
 const search=`<button type="button" data-open-search aria-label="搜索论文">${mobileIcon('search',22)}</button>`;
 const account=`<button type="button" data-page="me" aria-label="个人工作台">${mobileIcon('user',22)}</button>`;
 const actions=lab?`<button type="button" data-theme-next aria-label="切换显示主题">${mobileIcon('theme',21)}</button><a href="/?page=me" aria-label="我的工作台">${mobileIcon('user',21)}</a>`:home?`${search}<button type="button" data-page="alerts" aria-label="论文通知">${mobileIcon('bell',22)}</button>${account}`:page==='trends'?`${search}<button type="button" data-open-trend-filters aria-label="筛选趋势">${mobileIcon('filter',22)}</button>`:page==='feed'?search:`<button type="button" data-theme-next aria-label="切换显示主题">${mobileIcon('theme',21)}</button>${account}`;
 return `<header class="app-header${home?' app-header-home':''}"><div class="app-header-leading">${leading}</div><div class="app-header-actions">${actions}</div></header>`;
}
export function launcherHtml(statusHtml='',contentHtml=''){
 const cards=[['feed','search','查找论文','发现最新研究与文献','purple'],['trends','trend','研究趋势','研究热点与方法变化','blue'],['journals','journal','期刊画像','中文 C 刊与英文期刊','green'],['projects','project','课题组项目','项目、任务与科研协作','amber']];
 return `<section class="app-dashboard"><div class="app-greeting"><p class="app-eyebrow">YOUR RESEARCH, IN FOCUS</p><h1>从学术前沿，到研究进展。</h1><p>追踪新论文，洞察研究趋势，让每一步探索都有方向。</p>${statusHtml}</div><div class="app-quick-grid dashboard-tiles">${cards.map(([page,icon,name,description,tone])=>{const inside=`<span class="tile-icon">${mobileIcon(icon,36)}</span><span class="tile-arrow">${mobileIcon('chevron',18)}</span><strong>${name}</strong><small>${description}</small>`;return page==='projects'?`<a class="feature-tile tile-${tone}" href="/lab/?view=projects">${inside}</a>`:`<button class="feature-tile tile-${tone}" type="button" data-page="${page}">${inside}</button>`;}).join('')}</div>${contentHtml}<a class="app-import" href="/lab/?view=documents"><span class="app-icon-tile">${mobileIcon('upload',23)}</span><span><strong>记录一次科研交流</strong><small>导入组会记录，审核更新建议</small></span>${mobileIcon('chevron',20)}</a></section>`;
}
export const mobilePageAllowed=page=>['home','feed','trends','me','journals','alerts','health','sources','operations','article'].includes(page);

// Native dialog focus containment, Escape and focus restoration for both apps.
export function openAppDialog(html,{label='编辑',onClose=()=>{}}={}){
 const focus=document.activeElement,dialog=document.createElement('dialog');
 dialog.className='app-dialog';dialog.setAttribute('aria-label',label);dialog.innerHTML=html;
 dialog.addEventListener('close',()=>{dialog.remove();focus?.focus();onClose();},{once:true});
 dialog.addEventListener('click',e=>{if(e.target.closest('[data-close]'))dialog.close();});
 document.body.append(dialog);dialog.showModal();return dialog;
}
export function installMobileEnvironment(){
 if(!globalThis.window)return;
 const update=()=>{
  const keyboard=!!window.visualViewport&&window.innerHeight-window.visualViewport.height>150;
  document.documentElement.classList.toggle('keyboard-open',keyboard);
  document.documentElement.style.setProperty('--visual-height',(window.visualViewport?.height||innerHeight)+'px');
 };
 window.visualViewport?.addEventListener('resize',update);window.addEventListener('resize',update);update();
 window.addEventListener('popstate',()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
 if('scrollRestoration' in history)history.scrollRestoration='manual';
}
