import {topics} from './config.mjs';
export const articleTypes=['original_research','review','conference_abstract','editorial','book_review','unknown'];
export const typeLabels={original_research:'原创研究',review:'综述',conference_abstract:'会议摘要',editorial:'社论',book_review:'书评',unknown:'类型未确认',all:'全部类型'};
export function publicationToday(at=new Date()){const p=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}`;}
export const currentResearchYear=(at=new Date())=>Math.max(2026,Number(publicationToday(at).slice(0,4)));
// Publication metadata has calendar-day precision. Use the client's current
// day, including the Taipei New Year boundary, never a later calendar date.
export function publicationBackfillEnd(year,at=new Date()){
 return new Date(Math.min(Date.parse(`${Number(year)+1}-01-01T00:00:00Z`),Date.parse(publicationToday(at)+'T23:59:59Z'))).toISOString();
}
export function trendWindow(period='90d',at=new Date()){
 const today=publicationToday(at),year=currentResearchYear(at);
 if(period==='all')return {period,start:null,end:today,year};
 if(/^20\d\d$/.test(period))return {period,start:period+'-01-01',end:period<today.slice(0,4)?period+'-12-31':today,year:Number(period)};
 if(period==='ytd')return {period,start:year+'-01-01',end:today,year};
 const days={'30d':30,'90d':90,'180d':180,'12m':365}[period];
 if(!days)throw Object.assign(Error('Invalid period'),{status:400});
 return {period,start:[new Date(Date.parse(today+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10),'2026-01-01'].sort().at(-1),end:today,year};
}
// Explicit provider publication types only. Generic journal-article/Journal
// Article is NOT evidence that a paper is original research.
export function classifyArticleType(labels=[],source='unknown',title=''){
 const raw=Array.isArray(labels)?labels.filter(x=>typeof x==='string'):[];
 const normalized=raw.map(x=>x.toLowerCase().trim().replace(/[_-]/g,' ').replace(/\s+/g,' '));
 const titleConflict=/\bstudy protocol\b|\bprotocol for (?:a |an )?(?:randomi[sz]ed|clinical|trial|systematic|scoping)|:\s*(?:a\s+)?protocol\b|(?:^|:)\s*(?:a\s+)?(?:systematic|scoping|literature|rapid|narrative)\s+review\b|:\s*(?:a\s+)?meta-analysis\b|^editorial\s*:/i.test(String(title||''));
 const nonResearch=titleConflict||normalized.some(v=>['clinical trial protocol','study protocol','protocol','news','letter','comment','published erratum','retraction of publication','retracted publication','correction'].includes(v));
 const matches=new Set();
 for(const v of normalized){
  if(['research article','original article','original research','original research article','randomized controlled trial','controlled clinical trial','clinical trial','observational study','comparative study','evaluation study'].includes(v)||/^clinical trial, phase [iv]+$/.test(v))matches.add('original_research');
  if(['review','review article','systematic review','meta analysis','scoping review'].includes(v))matches.add('review');
  if(['conference abstract','meeting abstract','proceedings abstract'].includes(v))matches.add('conference_abstract');
  if(['editorial','editorial material'].includes(v))matches.add('editorial');
  if(['book review','book reviews'].includes(v))matches.add('book_review');
 }
 const blocked=nonResearch&&(matches.has('original_research')||!matches.size);
 const article_type=!blocked&&matches.size===1?[...matches][0]:'unknown';
 return {article_type,evidence:{source,raw_labels:raw,rule:'explicit-publication-type-v3',...(titleConflict?{source_title:title}:{}),reason:blocked?'protocol/news/letter/correction or source-title conflict; not confirmed completed original research':matches.size>1?'conflicting explicit types':matches.size?'explicit provider type':'provider type is absent, generic or unsupported'}};
}
export function relevanceScore(title='',abstract=''){
 const hit=(s,k)=>k==='ai'?/\bai\b/i.test(String(s||'')):String(s||'').toLowerCase().includes(k.toLowerCase());
 return topics.reduce((n,t)=>n+(t.keywords.some(k=>hit(title,k))?3:0)+(t.keywords.some(k=>hit(abstract,k))?1:0),0);
}
export const normalizedAnalysisText=a=>[a.title||'',(a.abstract||'').slice(0,7000)].map(x=>String(x).normalize('NFC').replace(/\s+/g,' ').trim()).join('\n');
