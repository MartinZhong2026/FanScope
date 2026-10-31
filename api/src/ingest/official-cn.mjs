// Chinese journal collection from publisher pages that are public and allowed by
// robots.txt. One adapter serves every journal on the "/CN/" platform; SciOpen, the
// publisher's platform, serves 公共管理评论. Abstracts are the publisher's own text, stored with
// their source. Nothing is generated; a missing abstract stays missing, with a reason.
// Re-running is safe: finished articles and issues are skipped, existing rows are
// filled in rather than duplicated.
import {db} from '../db.mjs';
import {classify} from '../sources.mjs';
import {relevanceScore} from '../publication-policy.mjs';
import {citationArticle,importChinese} from '../chinese-ingestion.mjs';
import {log} from '../platform/log.mjs';

const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ldquo:'“',rdquo:'”',lsquo:'‘',rsquo:'’',mdash:'—',hellip:'…'};
const entities=s=>String(s).replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi,(m,d,h,n)=>d?String.fromCodePoint(Number(d)):h?String.fromCodePoint(parseInt(h,16)):ENTITIES[n.toLowerCase()]??m);
export const cleanText=html=>entities(entities(String(html).replace(/<[^>]*>/g,' ')).replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();

const usable=s=>s.length>=30&&!/(\.\.\.|…)$/.test(s);
// The full abstract is in the page body. The Description meta tag is cut off with "...".
export function extractAbstract(html){
 const start=html.indexOf('id="collapseOne"');
 if(start<0)return '';
 const block=html.slice(start,start+40000).replace(/<script[\s\S]*?<\/script>/gi,'');
 const m=block.match(/<strong>\s*摘要\s*[：:]?\s*<\/strong>([\s\S]*?)(?:<strong>\s*(?:Abstract|关键词|Key\s*words)|<\/div>)/i);
 const text=m?cleanText(m[1]):'';
 return usable(text)?text:'';
}

export function issueLinks(html,base){
 const links=[...html.matchAll(/href=["']([^"']*(?:volumn\/volumn_\d+\.shtml|\/CN\/Y\d{4}\/V\d+\/I\d+))["']/g)].map(m=>new URL(m[1],base+'/CN/article/').href);
 return [...new Set(links)];
}
export function articleLinks(html,base){
 const links=[...html.matchAll(/href=["']([^"']*\/CN\/(?:Y\d{4}\/V\d+\/I\d+\/\d+|abstract\/abstract\d+\.shtml))["']/g)].map(m=>new URL(m[1],base+'/').href);
 return [...new Set(links)];
}
const urlYear=url=>Number(url.match(/\/Y(\d{4})\//)?.[1]||0);

const metaKey=entry=>'cn-official:'+entry.issn;
const getState=entry=>{try{return JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get(metaKey(entry))?.value||'{}')}catch{return {}}};
const setState=(entry,value)=>db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(metaKey(entry),JSON.stringify(value));

function journalRow(entry){
 const j=db.prepare("SELECT * FROM journals WHERE id=? AND market='chinese'").get(entry.journal_id);
 if(!j)throw Object.assign(Error('Journal missing: '+entry.journal_id),{code:'ingest_journal_missing'});
 if(j.issn!==entry.issn)db.prepare("UPDATE journals SET issn=? WHERE id=? AND COALESCE(issn,'')=''").run(entry.issn,j.id);
 return {...j,issn:entry.issn};
}

function annotate(id,{abstract,sourceUrl,source,gap,title}){
 if(abstract){
  const topics=classify(title,abstract);
  db.prepare(`UPDATE articles SET abstract_source=?,topics=?,matched=?,relevance_score=?,
   source_evidence_json=json_remove(json_set(source_evidence_json,'$.abstract_policy','publisher public page','$.abstract_url',?),'$.abstract_gap') WHERE id=?`)
   .run(source,JSON.stringify(topics),topics.length?1:0,relevanceScore(title,abstract),sourceUrl,id);
 }else db.prepare("UPDATE articles SET source_evidence_json=json_set(source_evidence_json,'$.abstract_policy','publisher public page','$.abstract_url',?,'$.abstract_gap',?) WHERE id=?").run(sourceUrl,gap,id);
}
const needsWork=(journalId,url)=>{
 const r=db.prepare("SELECT abstract,source_evidence_json e FROM articles WHERE journal_id=? AND (url=? OR publisher_landing_url=?) LIMIT 1").get(journalId,url,url);
 return !r||(!r.abstract&&!JSON.parse(r.e||'{}').abstract_gap);
};

function store(j,entry,article,totals){
 const result=importChinese({journalId:j.id,items:[article],authorized:true,evidenceUrl:entry.home});
 if(result.rejected?.length||result.review?.length){
  const reason=result.rejected?.[0]?.reason||result.review?.[0]?.reason||'unknown';
  totals.rejected++;(totals.reasons??={})[reason]=(totals.reasons[reason]||0)+1;
  log('warn','ingest.article_rejected',{journal_id:j.id,url:article.url});return null;
 }
 totals.added+=result.added;
 return db.prepare('SELECT id FROM articles WHERE journal_id=? AND (url=? OR publisher_landing_url=?) LIMIT 1').get(j.id,article.url,article.url)?.id||null;
}

// The /CN/ platform: issue index -> issue page -> article page.
export async function collectOfficial(entry,{read,checkpoint=()=>{},since=entry.since,recent=2}){
 const j=journalRow(entry),hosts=[new URL(entry.base).hostname],state=getState(entry),finished=new Set(state.issues||[]);
 const totals={issues:0,articles:0,added:0,abstracts:0,noAbstract:0,rejected:0,failed:0,skippedOld:0};
 const issues=issueLinks(await read(entry.base+'/CN/article/showOldVolumn.do',hosts),entry.base);
 if(!issues.length)throw Object.assign(Error('Issue index layout changed'),{code:'ingest_layout_changed'});
 // The past-issue index stops before the current issue, which only the home page lists.
 const pending=[entry.home,...issues.filter((u,i)=>i<recent||!finished.has(u))];
 for(const issue of pending){
  checkpoint();
  const links=articleLinks(await read(issue,hosts),entry.base);
  totals.issues++;
  let complete=true;
  for(const url of links){
   if(urlYear(url)&&urlYear(url)<since){totals.skippedOld++;continue}
   if(!needsWork(j.id,url))continue;
   checkpoint();
   try{
    const html=await read(url,hosts),article=citationArticle(html,j,url);
    if(!article){totals.rejected++;continue}
    // Keep a stored title as it is: identity checks compare against it.
    article.title=db.prepare('SELECT title FROM articles WHERE journal_id=? AND url=?').get(j.id,url)?.title||cleanText(article.title);
    article.abstract=extractAbstract(html);
    if(!article.publication_date){article.publication_date_partial=String(urlYear(url)||'');article.date_precision='year'}
    if(!article.issn)article.issn=entry.issn;
    article.source='official_catalog';
    const id=store(j,entry,article,totals);
    // A rejection is deterministic; retrying the issue would not change it.
    if(!id)continue;
    totals.articles++;
    if(article.abstract)totals.abstracts++;else totals.noAbstract++;
    annotate(id,{abstract:article.abstract,title:article.title,sourceUrl:url,source:'official_page',gap:'publisher_page_has_no_abstract'});
   }catch(e){
    if(e?.code==='scheduler_hold'||/budget exhausted/.test(e?.message))throw e;
    complete=false;totals.failed++;log('warn','ingest.source_failed',{market:'chinese',journal_id:j.id,url,error:String(e?.message).slice(0,160)});
   }
  }
  if(complete&&issue!==entry.home){finished.add(issue);setState(entry,{issues:[...finished]})}
 }
 return totals;
}

// 公共管理评论: the SciOpen archive is the list of record. Crossref lacks whole issues
// (those DOIs return 404), so it is only a fallback for a missing abstract.
export const sciopenYears=html=>[...new Set([...html.matchAll(/volume=(\d{4})/g)].map(m=>m[1]))];
export const sciopenIssues=html=>[...new Set([...html.matchAll(/issueIndex=(\d+)/g)].map(m=>m[1]))];
export const sciopenDois=(html,prefix)=>[...new Set([...html.matchAll(/10\.\d{4,9}\/[A-Za-z]+\.\d{4}\.\d+/g)].map(m=>m[0].toLowerCase()))].filter(d=>d.startsWith(prefix));
const metaValues=(html,name)=>[...html.matchAll(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`,'g'))].map(m=>cleanText(m[1]));
export function sciopenArticle(html,doi){
 const one=name=>metaValues(html,name)[0]||'';
 if(one('citation_doi').toLowerCase()!==doi)throw Object.assign(Error('SciOpen page does not match the DOI'),{code:'ingest_identity_mismatch'});
 const date=one('citation_publication_date').match(/^(\d{4})\/(\d{1,2})/);
 const abstract=one('Description');
 return {title:one('citation_title'),authors:metaValues(html,'citation_author').join(', '),volume:one('citation_volume'),issue:one('citation_issue'),
  publication_date_partial:date?`${date[1]}-${date[2].padStart(2,'0')}`:'',date_precision:'month',doi,abstract:usable(abstract)?abstract:''};
}

export async function collectSciopen(entry,{read,json,checkpoint=()=>{},recent=2}){
 const j=journalRow(entry),hosts=['www.sciopen.com'],state=getState(entry),finished=new Set(state.issues||[]);
 const totals={issues:0,articles:0,added:0,abstracts:0,noAbstract:0,rejected:0,failed:0,skippedOld:0};
 const archive=`${entry.base}/journal/join_journal/archive?journalId=${entry.journal_key}&issn=${entry.issn}`;
 const years=sciopenYears(await read(archive,hosts));
 if(!years.length)throw Object.assign(Error('Archive layout changed'),{code:'ingest_layout_changed'});
 const issues=[];
 for(const year of years){checkpoint();issues.push(...sciopenIssues(await read(`${archive}&volume=${year}`,hosts)))}
 for(const [index,issue] of issues.entries()){
  if(index>=recent&&finished.has(issue))continue;
  checkpoint();
  const dois=sciopenDois(await read(`${entry.base}/journal/join_journal/stage_page?stage=5&id=${entry.journal_key}&issn=${entry.issn}&issueIndex=${issue}`,hosts),entry.doi_prefix);
  totals.issues++;
  let complete=dois.length>0;
  for(const doi of dois){
   const row=db.prepare('SELECT id,abstract,source_evidence_json e FROM articles WHERE journal_id=? AND lower(doi)=? LIMIT 1').get(j.id,doi);
   if(row&&(row.abstract||JSON.parse(row.e||'{}').abstract_gap))continue;
   checkpoint();
   const page=`${entry.base}/article/${doi.toUpperCase()}`;
   try{
    const article=sciopenArticle(await read(page,hosts),doi);
    let sourceUrl=page,source='sciopen';
    if(!article.abstract){
     try{
      const fallback=cleanText((await json(`https://api.crossref.org/works/${doi}`)).message?.abstract||'');
      if(usable(fallback)){article.abstract=fallback;sourceUrl=`https://doi.org/${doi}`;source='crossref'}
     }catch(e){if(e?.code==='scheduler_hold'||/budget exhausted/.test(e?.message))throw e}
    }
    Object.assign(article,{url:`https://doi.org/${doi}`,publisher_landing_url:page,source:'official_catalog',issn:entry.issn,market:'chinese',journal_id:j.id,link_provenance:'official_citation_metadata'});
    const id=row?.id||store(j,entry,article,totals);
    if(!id)continue;
    if(row&&article.abstract)db.prepare("UPDATE articles SET abstract=?,abstract_status=CASE WHEN length(trim(?))>=55 THEN 'available' ELSE 'missing' END,analysis_status=CASE WHEN analysis_status='insufficient_abstract' THEN 'pending' ELSE analysis_status END WHERE id=?").run(article.abstract,article.abstract,id);
    totals.articles++;
    if(article.abstract)totals.abstracts++;else totals.noAbstract++;
    annotate(id,{abstract:article.abstract,title:article.title,sourceUrl,source,gap:'no_abstract_in_sciopen_or_crossref'});
   }catch(e){
    if(e?.code==='scheduler_hold'||/budget exhausted/.test(e?.message))throw e;
    complete=false;totals.failed++;log('warn','ingest.source_failed',{market:'chinese',journal_id:j.id,doi,error:String(e?.message).slice(0,160)});
   }
  }
  if(complete){finished.add(issue);setState(entry,{issues:[...finished]})}
 }
 return totals;
}

export const collectJournal=(entry,options)=>entry.adapter==='sciopen'?collectSciopen(entry,options):collectOfficial(entry,options);
