import {english} from './messages-en.mjs';
const key='fanscope-language',allowed=['zh-CN','en'];
let language='zh-CN';try{const saved=localStorage.getItem(key);if(allowed.includes(saved))language=saved;}catch{}
export const locale=()=>language;
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const phrases=new RegExp(Object.keys(english).filter(s=>s.length>1).sort((a,b)=>b.length-a.length).map(escape).join('|'),'gu');
export function translate(value,target=language){
 const text=String(value??'');if(target!=='en')return text;
 const trim=text.trim();if(Object.hasOwn(english,trim))return text.replace(trim,english[trim]);
 return text.replace(phrases,match=>english[match]).replace(/(\d[\d,]*(?:\.\d+)?)\s*篇/gu,'$1 papers').replace(/(\d[\d,]*(?:\.\d+)?)\s*次/gu,'$1 requests').replace(/(\d[\d,]*)\s*条/gu,'$1 records').replace(/(\d[\d,]*)\s*本/gu,'$1 journals').replace(/(\d{4}-\d{2}) 至 (\d{4}-\d{2})/gu,'$1 to $2').replace(/(\d{4}-\d{2}) 与 (\d{4}-\d{2})/gu,'$1 and $2');
}
const skip='[data-i18n-skip],script,style,code,pre,textarea,input,blockquote,.paper-title,.article-title,.article-summary,.article-abstract,.paper-journal,.app-activity-row strong,.project-card h3,.project-description,.journal-card>strong,.research-evidence a,.item h3,.item .sm,.quote,.review .sm';
const originals=new WeakMap(),attributes=new WeakMap();let queued=false;
function paintText(node){
 if(node.parentElement?.closest(skip))return;
 const previous=originals.get(node),current=node.nodeValue;
 const source=previous&&current===previous.output?previous.source:current;
 const output=translate(source);if(output!==current)node.nodeValue=output;
 originals.set(node,{source,output});
}
export function applyLanguage(root=document){
 document.documentElement.lang=language;
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
 while((node=walker.nextNode()))paintText(node);
 for(const el of root.querySelectorAll?.('[placeholder],[aria-label],[title],[data-label]')||[]){
  if(el.closest(skip))continue;const saved=attributes.get(el)||{};
  for(const name of ['placeholder','aria-label','title','data-label']){const current=el.getAttribute(name);if(current===null)continue;const previous=saved[name],source=previous&&current===previous.output?previous.source:current,output=translate(source);if(current!==output)el.setAttribute(name,output);saved[name]={source,output};}attributes.set(el,saved);
 }
 for(const button of document.querySelectorAll('[data-language-toggle]')){button.textContent=language==='en'?'中文':'English';button.setAttribute('aria-label',language==='en'?'Switch to Chinese':'切换到英文');button.lang=language==='en'?'zh-CN':'en';}
}
function controls(){
 const mobile=matchMedia('(max-width:820px)').matches;
 let host=document.querySelector(mobile?'.app-header-actions':'.topright')||(!mobile?document.querySelector('.topbar>span,.logopanel'):null);
 if(!host)host=document.querySelector('.app-header-actions');
 for(const target of [host,document.querySelector('dialog[open] .bar')||document.querySelector('dialog[open]')].filter(Boolean)){
  if(target.querySelector('[data-language-toggle]'))continue;
  const button=document.createElement('button');button.type='button';button.className='language-toggle';button.dataset.languageToggle='';target.prepend(button);
 }
}
function schedule(){if(queued)return;queued=true;queueMicrotask(()=>{queued=false;observer.disconnect();controls();applyLanguage();observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['placeholder','aria-label','title','data-label']});});}
export function setLanguage(next){
 if(!allowed.includes(next)||next===language)return;language=next;try{localStorage.setItem(key,next);}catch{}
 applyLanguage();window.dispatchEvent(new Event('fanscope-language-change'));schedule();
}
const observer=new MutationObserver(schedule);
document.addEventListener('click',event=>{if(event.target.closest('[data-language-toggle]'))setLanguage(language==='en'?'zh-CN':'en');});
window.addEventListener('storage',event=>{if(event.key===key&&allowed.includes(event.newValue))setLanguage(event.newValue);});
window.addEventListener('resize',schedule);
window.FanScopeI18n={translate,locale,setLanguage};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule,{once:true});else schedule();
