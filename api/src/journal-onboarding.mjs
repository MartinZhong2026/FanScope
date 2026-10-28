import crypto from 'node:crypto';
// Explicit operator-verified Crossref source onboarding. No AI and no invented journals.
import {db,now} from './db.mjs';
import {journals as configuredJournals} from './config.mjs';
import {fetchJson,canonicalDoi,doiUrl,validIssn,canonicalJournalTitle,feedHosts,journalTitleMatches} from './sources.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export const canonicalTitle=canonicalJournalTitle;
export async function probeJournalSource({id,issn='',enable=false,confirm=false}={},request=fetchJson){
 const j=db.prepare('SELECT * FROM journals WHERE id=?').get(String(id||''));
 if(!j)throw fail('Unknown journal',404);
 const code=String(issn||j.issn||'').trim().toUpperCase();
 if(!validIssn(code))throw fail('Valid ISSN required (including checksum)');
 if(enable&&!confirm)throw fail('Operator confirmation required');
 const revision=crypto.randomUUID(),revisionKey='rss-edit:'+j.id;
 if(enable)db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(revisionKey,revision);
 const url=`https://api.crossref.org/journals/${encodeURIComponent(code)}/works?rows=25&select=DOI,ISSN,title,type,published,container-title,publisher`;
 let x;try{x=await request(url)}catch(e){saveSourceEvidence(j,'crossref',code,false,{url},e.message);throw e}
 if(!Array.isArray(x?.message?.items))throw fail('Crossref malformed response',502);
 const records=x.message.items.filter(a=>a.type==='journal-article'&&Array.isArray(a.ISSN)&&a.ISSN.includes(code)&&doiUrl(a.DOI));
 const matched=records.filter(a=>(a['container-title']||[]).some(t=>journalTitleMatches(t,j)));
 const ok=matched.length>0;
 const result={journalId:j.id,issn:code,source:'crossref',verified:ok,examined:x.message.items.length,sample:[...new Map(matched.map(a=>[canonicalDoi(a.DOI),a])).values()].slice(0,2).map(a=>({doi:canonicalDoi(a.DOI),title:String(a.title?.[0]||'').slice(0,240),publisher:String(a.publisher||'').slice(0,240)})),enabled:!!j.enabled};
 saveSourceEvidence(j,'crossref',code,ok,{...result,url},ok?'':'Sample identity did not match');
 if(enable&&!ok)throw fail('Source sample identity could not be verified; journal unchanged',409);
 if(enable){
  if(db.prepare('SELECT value FROM meta WHERE key=?').get(revisionKey)?.value!==revision)throw fail('A newer source operation superseded this request',409);
  if(j.issn!==code||j.source!=='crossref'){
   db.prepare('DELETE FROM scan_windows WHERE journal_id=?').run(j.id);
   db.prepare('UPDATE journals SET last_success=NULL,last_checked=NULL,last_count=0 WHERE id=?').run(j.id);
  }
  db.prepare("UPDATE journals SET checkpoint=CASE WHEN issn<>? OR source<>'crossref' THEN NULL ELSE checkpoint END,issn=?,source='crossref',enabled=1,last_error=NULL WHERE id=?").run(code,code,j.id);
  db.prepare('INSERT INTO jobs(kind,start_at,end_at,status,details) VALUES(?,?,?,?,?)').run('journal_source_activated',now(),now(),'ok',JSON.stringify({id:j.id,issn:code}));
  result.enabled=true;
 }
 return result;
}
function saveSourceEvidence(j,source,identifier,verified,evidence,error=''){
 db.prepare('INSERT INTO journal_source_evidence(journal_id,source,identifier,checked_at,verified,evidence_json,error) VALUES(?,?,?,?,?,?,?)').run(j.id,source,identifier,now(),verified?1:0,JSON.stringify(evidence),String(error).slice(0,500));
}
export function sourceSummary(){
 const rows=db.prepare('SELECT * FROM journals ORDER BY market,title').all();
 const items=rows.map(j=>{
  const key=j.source==='rss'?j.rss_url:j.issn;
  const e=db.prepare('SELECT * FROM journal_source_evidence WHERE journal_id=? AND source=? AND identifier=? ORDER BY id DESC LIMIT 1').get(j.id,j.source,key||'');
  const verified=!!e?.verified;
  const fresh=j.last_success&&Date.now()-Date.parse(j.last_success)<86400000;
  const status=!j.enabled?'pending':j.last_error?'failed':!verified?'unverified':!j.last_success?'awaiting_first_scan':!fresh?'stale':'healthy';
  const history=db.prepare('SELECT id,status,from_date,to_date,window_start,added_articles,pages_done,error FROM journal_backfill_jobs WHERE journal_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(j.id)||null;
  const article_count=db.prepare('SELECT COUNT(*) n FROM articles WHERE journal_id=? AND market=? AND demo=0').get(j.id,j.market).n;
  const cn=db.prepare('SELECT value FROM meta WHERE key=?').get('cn-source:'+j.id);
  const bulk_connection=cn?JSON.parse(cn.value):null;
  const errorRow=db.prepare('SELECT value FROM meta WHERE key=?').get('cn-source-error:'+j.id),sourceError=errorRow?JSON.parse(errorRow.value):null;
  const bulk_source_verified=bulk_connection?.verified===true&&!(sourceError&&(Date.parse(sourceError.at||'')||0)>=(Date.parse(bulk_connection.checkedAt||'')||0));
  const automatic_source_verified=bulk_source_verified||verified&&['rss','crossref'].includes(j.source);
  const collection_status=j.market==='chinese'?(article_count?'metadata_ready':automatic_source_verified?'source_verified':'uncollected'):null;
  return {...j,article_count,bulk_connection,bulk_source_verified,automatic_source_verified,collection_status,candidate_issn:configuredJournals.find(x=>x.id===j.id)?.candidate_issn||'',rss_allowed_hosts:feedHosts(j),verified,status,history,evidence:e?{...JSON.parse(e.evidence_json),checked_at:e.checked_at,error:e.error}:null};
 });
 return {total:items.length,enabled:items.filter(x=>x.enabled).length,verifiedAutomatic:items.filter(x=>x.verified&&['crossref','rss'].includes(x.source)).length,metadataConnected:items.filter(x=>x.collection_status==='metadata_ready').length,metadataCollected:items.filter(x=>x.collection_status==='metadata_ready').length,monitored:items.filter(x=>x.status==='healthy').length,failed:items.filter(x=>x.status==='failed').length,manualFallback:items.filter(x=>!x.enabled&&x.market==='chinese'&&!x.automatic_source_verified).length,unconfigured:items.filter(x=>!x.enabled&&(x.market==='chinese'?!x.automatic_source_verified&&!x.article_count:true)).length,pendingConfirmation:items.filter(x=>!x.verified&&!x.bulk_source_verified).length,backfillRunning:items.filter(x=>x.history?.status==='running').length,backfillEnumerated:items.filter(x=>x.history?.status==='completed').length,items};
}

// DOI-backed ISSN suggestions from Crossref metadata, not AI guesses.
// Query returns likely works by title; accept ISSNs only from exact journal titles.
export function parseJournalCandidates(data,title){
 const rows=Array.isArray(data?.message?.items)?data.message.items:[];
 const matches=rows.filter(x=>x?.type==='journal-article' &&
  (x['container-title']||[]).some(n=>canonicalTitle(n)===canonicalTitle(title)) &&
  doiUrl(x.DOI));
 const candidates=new Map();
 for(const x of matches){
  for(const code of new Set((x.ISSN||[]).map(v=>String(v||'').trim().toUpperCase()))){
   if(!validIssn(code))continue;
   const o=candidates.get(code)||{issn:code,doiSamples:[],evidenceCount:0};
   if(!o.doiSamples.includes(canonicalDoi(x.DOI))){o.doiSamples.push(canonicalDoi(x.DOI));o.evidenceCount++;}
   candidates.set(code,o);
  }
 }
 return [...candidates.values()].filter(o=>o.evidenceCount>=2)
  .sort((a,b)=>b.evidenceCount-a.evidenceCount).slice(0,5)
  .map(o=>({issn:o.issn,evidenceCount:o.evidenceCount,doiSamples:o.doiSamples.slice(0,3)}));
}
export async function discoverJournalSource(id,request=fetchJson){
 const j=db.prepare('SELECT id,title,market,issn,source,enabled FROM journals WHERE id=?').get(String(id||''));
 if(!j)throw fail('Unknown journal',404);
 if(j.market!=='international')throw fail('Automatic Crossref suggestion is only available for English journals');
 const q=new URLSearchParams({'query.bibliographic':j.title,'filter':'type:journal-article',rows:'60',select:'DOI,ISSN,container-title,type'});
 const result=await request('https://api.crossref.org/works?'+q);
 const candidates=parseJournalCandidates(result,j.title);
 return {journalId:j.id,title:j.title,status:candidates.length?'candidates_found':'needs_manual_research',candidates,
  warning:'候选 ISSN 是来自 Crossref 文章的线索，不代表完成监测；必须使用独立验证接口核对 DOI、名称、ISSN 后管理员确认启用。'};
}

export async function manageRSS({id,rss_url='',action='test',confirm=false}={},request){
 const j=db.prepare('SELECT * FROM journals WHERE id=?').get(String(id||''));if(!j)throw fail('Unknown journal',404);
 if(!['test','save','enable','pause'].includes(action))throw fail('Invalid RSS action');
 if(action==='enable'&&confirm!==true)throw fail('Operator confirmation required');
 const revision=crypto.randomUUID(),revisionKey='rss-edit:'+j.id;
 if(action!=='test')db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(revisionKey,revision);
 if(action==='pause'){db.prepare('UPDATE journals SET enabled=0 WHERE id=?').run(j.id);return {enabled:false}}
 const {fetchRSS}=await import('./sources.mjs');
 const url=String(rss_url||j.rss_url).trim();let rows;try{rows=await fetchRSS({...j,rss_url:url},request)}catch(e){saveSourceEvidence(j,'rss',url,false,{url},e.message);throw fail(e.message,422)}
 if(action!=='test'&&db.prepare('SELECT value FROM meta WHERE key=?').get(revisionKey)?.value!==revision)throw fail('A newer source operation superseded this request',409);
 saveSourceEvidence(j,'rss',url,true,{url,count:rows.length,sample:rows.slice(0,3)});
 if(action!=='test'&&(j.rss_url!==url||j.source!=='rss'))db.prepare('UPDATE journals SET last_success=NULL,last_checked=NULL,last_count=0 WHERE id=?').run(j.id);
 if(action!=='test')db.prepare("UPDATE journals SET checkpoint=CASE WHEN rss_url<>? OR source<>'rss' THEN NULL ELSE checkpoint END,rss_url=?,source='rss',enabled=?,last_error=NULL WHERE id=?").run(url,url,action==='enable'?1:0,j.id);
 return {verified:true,enabled:action==='enable',count:rows.length,sample:rows.slice(0,3),note:'Saving pauses monitoring; enabling always performs a fresh check'};
}
