import {topics,config} from './config.mjs';
import {classifyArticleType,relevanceScore,publicationToday} from './publication-policy.mjs';
const strip=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
export function classify(title,abstract=''){
 const s=`${title} ${strip(abstract)}`.toLowerCase();
 return topics.filter(t=>t.keywords.some(k=>k==='ai'?/\bai\b/i.test(s):s.includes(k.toLowerCase()))).map(t=>t.id);
}
export function canonicalDoi(doi){return String(doi||'').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i,'').toLowerCase();}
export const canonicalJournalTitle=s=>String(s||'').toLowerCase().replace(/&amp;|&#0*38;|&#x0*26;/gi,'&').replace(/^the\s+/,'').replace(/&/g,'and').replace(/[^a-z0-9\u4e00-\u9fff]/g,'');
export function journalTitleMatches(title,j){
 const configured=configuredJournals.find(x=>x.id===j.id);
 return [j.title,...(configured?.source_title_aliases||[])].some(t=>canonicalJournalTitle(t)===canonicalJournalTitle(title));
}
export function validIssn(s){if(!/^\d{4}-\d{3}[\dX]$/.test(s))return false;return [...s.replace('-','')].reduce((n,c,i)=>n+(c==='X'?10:Number(c))*(8-i),0)%11===0;}
export function dateParts(value){const p=value?.['date-parts']?.[0];if(!p||p.length<3||!Number.isInteger(p[0])||!Number.isInteger(p[1])||!Number.isInteger(p[2]))return '';const d=`${p[0]}-${String(p[1]).padStart(2,'0')}-${String(p[2]).padStart(2,'0')}`;return Number.isNaN(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d?'':d;}
function partialDate(value){const p=value?.['date-parts']?.[0];if(!Array.isArray(p)||!Number.isInteger(p[0])||p[0]<1000||p[0]>9999)return '';if(p.length===1)return String(p[0]);if(p.length===2&&Number.isInteger(p[1])&&p[1]>=1&&p[1]<=12)return `${p[0]}-${String(p[1]).padStart(2,'0')}`;return '';}
export function safeArticleUrl(value){try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port||!u.hostname.includes('.')||/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname))return '';return u.href;}catch{return '';}}
export function doiUrl(doi){const d=canonicalDoi(doi);return /^10\.\d{4,9}\/[^\s]+$/.test(d)?`https://doi.org/${encodeURIComponent(d).replace(/%2F/gi,'/')}`:'';}
export function articleLink(a){const doi=doiUrl(a.doi);const landing=safeArticleUrl(a.publisher_landing_url);const raw=safeArticleUrl(a.url);const source=raw&&new URL(raw).pathname!=='/'?raw:'';return {article_url:landing||doi||((a.source==='manual'||a.source==='rss')?source:''),link_provenance:landing?(a.link_provenance||'provider_metadata'):doi?'doi':'unverified_source',link_verified_at:null};}
export function crossrefToArticle(x,j){
 const title=strip(Array.isArray(x.title)?x.title[0]:x.title),doi=canonicalDoi(x.DOI);if(!title||!doiUrl(doi))return null;
 const online=dateParts(x['published-online']),print=dateParts(x['published-print']);
 const dates=[online,print,dateParts(x.published),dateParts(x.issued)].filter(Boolean).sort();
 let publication_date=dates[0]||'';
 const earliestPartial=[x['published-online'],x['published-print'],x.published,x.issued].map(partialDate).filter(Boolean).sort()[0]||'';
 // A 2024-10 online date must not become a 2025 print publication merely
 // because only the print date has day precision.
 const partial=earliestPartial&&(!publication_date||earliestPartial<publication_date.slice(0,earliestPartial.length))?earliestPartial:'';
 if(partial)publication_date='';
 // Future print issues are retained as evidence only when an actual earlier
 // publication date exists. Index/deposit/discovery timestamps are never dates.
 if(publication_date&&publication_date>publicationToday())return null;
 if(partial&&partial>publicationToday().slice(0,partial.length))return null;
 const authors=(x.author||[]).slice(0,100).map(a=>[a.given,a.family].filter(Boolean).join(' ')).join(', ');
 const abstract=strip(x.abstract||''),t=classify(title,abstract);
 // Only article-level resource URLs provided by Crossref, never journal homepages.
 const candidate=safeArticleUrl(x.resource?.primary?.URL||x.URL),u=candidate?new URL(candidate):null;
 const landing=u&&u.pathname!=='/'&&!/^(dx\.)?doi\.org$/i.test(u.hostname)&&(!j.homepage||candidate!==safeArticleUrl(j.homepage))?candidate:'';
 const quality=classifyArticleType([x.subtype,x['article-type'],x.type].filter(Boolean),'crossref',title);
 const evidence={doi,publication_types:quality.evidence.raw_labels,ISSN:x.ISSN||[],journal_titles:x['container-title']||[],publisher:x.publisher||null,published:x.published||null,published_online:x['published-online']||null,published_print:x['published-print']||null,issued:x.issued||null,resource:x.resource||null,source_updated_at:x.deposited?.['date-time']||null};
 const missing={};for(const [key,value] of Object.entries({authors,abstract,publication_date,published_online_date:online,published_print_date:print,volume:x.volume,issue:x.issue}))if(!value)missing[key]=key.includes('date')?'source does not supply an exact day':'not supplied by source';
 const verified=Array.isArray(x.ISSN)&&x.ISSN.includes(j.issn)&&(x['container-title']||[]).some(title=>journalTitleMatches(title,j));
 return {id:`doi:${doi}`,journal_id:j.id,market:j.market,title,doi,url:doiUrl(doi),publisher_landing_url:landing,link_provenance:landing?'crossref_metadata':'doi',authors,abstract,article_type:quality.article_type,article_type_evidence:quality.evidence,relevance_score:relevanceScore(title,abstract),publication_date,publication_date_partial:partial,published_online_date:online,published_print_date:print,volume:String(x.volume||''),issue:String(x.issue||''),issns:x.ISSN||[],source_evidence:evidence,metadata_fetched_at:new Date().toISOString(),source_verification_status:verified?'verified':'unverified',missing_fields:missing,indexed_at:x.indexed?.['date-time']||'',date_precision:publication_date?'day':partial.length===7?'month':partial?'year':'unknown',source:'crossref',topics:t,matched:t.length>0};
}
export async function fetchJson(url,timeout=22000){
 for(let attempt=0;attempt<3;attempt++){
   try {const response=await fetch(url,{headers:{'User-Agent':`FanScope/1.0 (mailto:${config.contactEmail||'unconfigured@example.com'})`,'Accept':'application/json'},signal:AbortSignal.timeout(timeout)});
    if((response.status===429||response.status>=500)&&attempt<2){const header=response.headers.get('Retry-After');const seconds=Number(header),retry=header?(Number.isFinite(seconds)?seconds*1000:Date.parse(header)-Date.now()):0;await new Promise(r=>setTimeout(r,Math.min(60000,Math.max(900*2**attempt,retry||0))));continue;}
    if(!response.ok)throw new Error(`HTTP ${response.status}`);return await response.json();
   }catch(e){if(attempt===2)throw e;await new Promise(r=>setTimeout(r,700*Math.pow(2,attempt)));}
 }
}
// A bounded invocation yields a resumable state. Cursor is saved only after the
// consumer commits its page; failed requests never advance it. End is fixed.
export async function* crossrefPages(j,{initial=false,checkpoint='',lookbackDays=14,maxPages=20,state=null,onState=()=>{},request=fetchJson,until=new Date().toISOString(),fromDate='',toDate='',windowDays=1,pageSize=100,strictPageBudget=false,shouldContinue=()=>true}={}){
 if(!Number.isInteger(pageSize)||pageSize<1||pageSize>1000||!Number.isFinite(windowDays)||windowDays<=0||windowDays>366)throw Error('Invalid Crossref page or window size');
 const day=86400000,iso=n=>new Date(n).toISOString();
 let st=state?{...state}:null;
 if(!st||st.status==='complete'){
  const end=toDate?Date.parse(toDate):Date.parse(until);
  const start=fromDate?Date.parse(fromDate):(checkpoint&&!initial?Date.parse(checkpoint)-2*day:Date.parse(until)-lookbackDays*day);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)throw Error('Invalid Crossref scan range');
  st={mode:fromDate?'backfill':initial?'backfill':'incremental',range_end:iso(end),window_start:iso(start),window_end:iso(Math.min(start+day*windowDays,end)),cursor:'*',processed:0,total:null,attempts:0,status:'running',error:''};
 }
 let pages=0,resets=0;
 try{while(Date.parse(st.window_start)<Date.parse(st.range_end)){
  if(!shouldContinue())return;
  const prefix=st.mode==='backfill'?'pub':'index';
  const p=new URLSearchParams({filter:`from-${prefix}-date:${st.window_start.slice(0,19)},until-${prefix}-date:${st.window_end.slice(0,19)}`,rows:String(pageSize),cursor:st.cursor,mailto:config.contactEmail||''});
  let body;try{body=await request(`https://api.crossref.org/journals/${encodeURIComponent(j.issn)}/works?${p}`);}catch(e){
   if(st.cursor!=='*'&&resets++<2&&/HTTP (400|404|410)|cursor.*(?:expired|invalid)/i.test(String(e.message))){st.cursor='*';st.processed=0;st.total=null;st.attempts++;st.error='Cursor invalid; replaying fixed window with DOI deduplication';onState({...st});continue;}throw e;
  }
  const msg=body?.message;if(!Array.isArray(msg?.items))throw Error('Crossref malformed response');
  const items=msg.items,total=msg['total-results'];if(total!==undefined&&(!Number.isInteger(total)||total<0))throw Error('Crossref invalid total');if(Number.isFinite(total))st.total=total;
  // Split unusually dense windows before consuming pages; fixed bounds remain
  // persistent. Normal windows finish in one invocation so cursor TTL cannot
  // turn the soft scheduling budget into a permanent four-page loop.
  if(st.cursor==='*'&&total>10000&&Date.parse(st.window_end)-Date.parse(st.window_start)>1000){st.window_end=iso(Math.max(Date.parse(st.window_start)+1000,Math.floor((Date.parse(st.window_start)+Date.parse(st.window_end))/2000)*1000));st.total=null;onState({...st});continue;}
  if(st.processed>=10000)throw Error('Dense minimum window requires operator review; checkpoint retained');
  // Reject contradictory venue metadata rather than assigning another journal's
  // papers to this source. Older providers may omit these optional fields.
  yield items.filter(x=>x.type==='journal-article'&&(!x.ISSN||Array.isArray(x.ISSN)&&x.ISSN.includes(j.issn))&&(!x['container-title']||Array.isArray(x['container-title'])&&x['container-title'].some(t=>journalTitleMatches(t,j)))).map(x=>crossrefToArticle(x,j)).filter(Boolean).filter(a=>{if(!fromDate)return true;const date=a.publication_date||a.publication_date_partial;return !!date&&date>=fromDate.slice(0,date.length)&&date<=st.range_end.slice(0,date.length)}).map(a=>({...a,scan_mode:st.mode}));
  const processed=st.processed+items.length;
  const complete=st.total!==null?processed>=st.total:items.length<pageSize;
  if(!complete){const next=msg['next-cursor'];if(!items.length||!next||next===st.cursor)throw Error('Crossref incomplete page / cursor did not advance');st.cursor=next;}
  else{
   st.window_start=st.window_end;st.window_end=iso(Math.min(Date.parse(st.window_start)+day*windowDays,Date.parse(st.range_end)));
   st.cursor='*';st.processed=0;st.total=null;
   if(st.window_start===st.range_end)st.status='complete';
  }
  if(!complete)st.processed=processed;
  pages++;if(st.status!=='complete')st.status='running';st.error='';
  onState({...st});
  if(st.status==='complete')return;
  if(pages>=maxPages&&(strictPageBudget||complete)){st.status='paused';onState({...st});return;}
  await new Promise(r=>setTimeout(r,500));
 }}catch(e){st.status='failed';st.error=String(e.message).slice(0,230);st.attempts++;onState({...st});throw e;}
}
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {secureFeed,approvedURL} from './rss-security.mjs';
import {journals as configuredJournals} from './config.mjs';
import crypto from 'node:crypto';
const list=x=>x===undefined?[]:Array.isArray(x)?x:[x];
const text=x=>typeof x==='object'?String(x?.['#text']||''):String(x||'');
export function feedHosts(j){return configuredJournals.find(x=>x.id===j.id)?.rss_allowed_hosts||[]}
export function parseFeed(xml,j,{verifyIdentity=false}={}){
 if(Buffer.byteLength(xml)>2e6||/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw Error('Invalid or unsafe feed XML');
 const x=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false,processEntities:true}).parse(xml);
 const channel=x.rss?.channel||x.feed||x.RDF?.channel;if(!channel)throw Error('Expected RSS or Atom');
 if(verifyIdentity&&canonicalJournalTitle(text(channel.title))!==canonicalJournalTitle(j.title))throw Error('Feed journal title does not match');
 const entries=x.feed?list(x.feed.entry):list(x.rss?.channel?.item||x.RDF?.item);
 const rows=entries.slice(0,300).map(a=>{
 const title=strip(text(a.title));let link=text(a.link);
 if(typeof a.link==='object'){const selected=list(a.link).find(l=>!l['@_rel']||l['@_rel']==='alternate');link=selected?.['@_href']||text(selected)}
 let url;try{url=new URL(link,j.rss_url||undefined).href}catch{return null}if(!safeArticleUrl(url)||!title)return null;
 if(verifyIdentity){try{approvedURL(url,feedHosts(j))}catch{return null}}
 const raw=text(a.pubDate||a.published||a.date),date=Date.parse(raw);if(verifyIdentity&&(!Number.isFinite(date)||new Date(date).toISOString().slice(0,10)>publicationToday()))return null;
 const publication_date=Number.isFinite(date)?new Date(date).toISOString().slice(0,10):'';
 const abstract=strip(text(a.description||a.summary||a.content)),doi=canonicalDoi((url.match(/10\.\d{4,9}\/[^\s?#]+/i)||[])[0]||''),topics=classify(title,abstract);
 const authors=list(a.author||a.creator).map(v=>text(v?.name||v)).filter(Boolean).join(', ');
 return {id:doi?'doi:'+doi:'feed:'+j.id+':'+crypto.createHash('sha256').update(url).digest('hex'),journal_id:j.id,market:j.market,title,doi,url,authors,abstract,publication_date,source:'rss',source_verification_status:verifyIdentity?'verified':'unverified',metadata_fetched_at:new Date().toISOString(),source_evidence:{url,feed:j.rss_url,channel_title:text(channel.title),published:raw,updated:text(a.updated)||null},missing_fields:{...(!doi?{doi:'not supplied by source'}:{}),...(!authors?{authors:'not supplied by source'}:{}),...(!abstract?{abstract:'not supplied by source'}:{})},topics,matched:!!topics.length};
 }).filter(Boolean);
 return [...new Map(rows.map(a=>[a.id,a])).values()];
}
export async function fetchRSS(j,request=secureFeed){
 const body=await request(j.rss_url,feedHosts(j));const rows=parseFeed(body,j,{verifyIdentity:true});if(!rows.length)throw Error('No verified articles in feed');return rows;
}
