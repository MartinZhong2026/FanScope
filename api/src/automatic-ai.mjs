// Durable continuous English-only queue, reusing analysis tables and request claims.
// No monetary budget or cumulative article limit. Explicit enable + resume required.
import crypto from 'node:crypto';
import {db,now} from './db.mjs';import {config} from './config.mjs';import {analyzePending} from './ai.mjs';import {publicationToday} from './publication-policy.mjs';
export const automaticBatchId='automatic-english-v14';
const controlKey='ai-auto:v14:control',leaseKey='ai-auto:v14:lease';
const read=k=>{const r=db.prepare('SELECT value FROM meta WHERE key=?').get(k);return r?JSON.parse(r.value):null;};
const write=(k,v)=>db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,JSON.stringify(v));
const state=()=>read(controlKey)||{state:'paused',reason:'not_started',rateLimits:0,serverErrors:0};
const date="COALESCE(NULLIF(a.published_online_date,''),NULLIF(a.publication_date,''),a.publication_date_partial)";
const minAbstract=()=>Math.max(200,Number(process.env.AI_AUTO_MIN_ABSTRACT_CHARS)||200);
function criteria(){return `a.market='international' AND j.market='international' AND j.enabled=1 AND j.issn<>''
 AND j.source IN ('crossref','rss') AND a.source IN ('crossref','rss') AND a.source_verification_status='verified' AND a.demo=0
 AND length(trim(coalesce(a.abstract,'')))>=? AND a.abstract_status='available'
 AND a.article_type NOT IN ('editorial','book_review','conference_abstract')
 AND a.analysis_status IN ('pending','needs_retry') AND a.analysis_attempts<5 AND coalesce(a.analysis_json,'')=''
 AND a.date_precision='day' AND length(${date})=10 AND date(${date},'+0 days')=${date} AND ${date}<=?
 AND (a.doi LIKE '10.%/%' OR a.publisher_landing_url LIKE 'https://%' OR a.url LIKE 'https://%')
 AND NOT EXISTS(SELECT 1 FROM articles x WHERE x.id<>a.id AND ((a.doi<>'' AND x.doi=a.doi) OR (a.url<>'' AND x.url=a.url)))
 AND NOT EXISTS(SELECT 1 FROM analysis_batch_items i JOIN analysis_batches b ON b.id=i.batch_id
   WHERE i.article_id=a.id AND b.id<>'${automaticBatchId}' AND b.status NOT IN ('completed','cancelled') AND i.status IN ('queued','running'))`;}
function ensureQueue(){
 db.prepare("INSERT OR IGNORE INTO analysis_batches(id,created_at,status,filter_json,total) VALUES(?,?,'paused',?,0)").run(automaticBatchId,now(),JSON.stringify({policy:'automatic_english_v14',automatic:true}));
 const b=db.prepare('SELECT filter_json FROM analysis_batches WHERE id=?').get(automaticBatchId);if(JSON.parse(b.filter_json).policy!=='automatic_english_v14')throw Error('Automatic batch ID collision');
}
function fillQueue(){
 ensureQueue();
 const cutoff=new Date(Date.parse(publicationToday()+'T00:00:00Z')-179*86400000).toISOString().slice(0,10);
 const rows=db.prepare(`SELECT a.id FROM articles a JOIN journals j ON j.id=a.journal_id WHERE ${criteria()}
 AND NOT EXISTS(SELECT 1 FROM analysis_batch_items i WHERE i.batch_id=? AND i.article_id=a.id)
 ORDER BY CASE WHEN ${date}>=? THEN 0 ELSE 1 END,${date} DESC,a.id LIMIT 500`).all(minAbstract(),publicationToday(),automaticBatchId,cutoff);
 const insert=db.prepare("INSERT OR IGNORE INTO analysis_batch_items(batch_id,article_id,status,updated_at) VALUES(?,?,'queued',?)");for(const r of rows)insert.run(automaticBatchId,r.id,now());
 db.prepare('UPDATE analysis_batches SET total=(SELECT COUNT(*) FROM analysis_batch_items WHERE batch_id=?) WHERE id=?').run(automaticBatchId,automaticBatchId);
}
export function automaticStatus(){
 const c=state(),counts=Object.fromEntries(db.prepare('SELECT status,COUNT(*) n FROM analysis_batch_items WHERE batch_id=? GROUP BY status').all(automaticBatchId).map(r=>[r.status,r.n]));
 const cutoff=new Date(Date.parse(publicationToday()+'T00:00:00Z')-179*86400000).toISOString().slice(0,10);
 const eligible=db.prepare(`SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN ${date}>=? THEN 1 ELSE 0 END),0) recent FROM articles a JOIN journals j ON j.id=a.journal_id WHERE ${criteria()}`).get(cutoff,minAbstract(),publicationToday());
 const usage=db.prepare('SELECT COUNT(*) requests,SUM(input_tokens) inputTokens,SUM(output_tokens) outputTokens,SUM(cost_cny) estimatedCost, SUM(CASE WHEN cost_cny IS NULL THEN 1 ELSE 0 END) unpriced FROM analysis_usage_log WHERE batch_id=?').get(automaticBatchId);
 return {...c,enabled:process.env.FANSCOPE_AI_AUTO_ENABLED==='true',keyConfigured:!!config.dsKey,counts,total:Object.values(counts).reduce((n,v)=>n+v,0),eligible:eligible.total,eligibleRecent180:eligible.recent,usage:{requests:usage.requests,inputTokens:usage.inputTokens||0,outputTokens:usage.outputTokens||0,estimatedCost:usage.unpriced?null:usage.estimatedCost||0},minAbstractChars:minAbstract(),budgetEnforced:false};
}
export function changeAutomatic(action){
 if(!['resume','pause','stop'].includes(action))throw Object.assign(Error('Invalid automatic AI action'),{status:400});
 if(action==='resume'&&(process.env.FANSCOPE_AI_AUTO_ENABLED!=='true'||!config.dsKey))throw Object.assign(Error('Automatic AI is not enabled/configured on the server'),{status:409});
 db.exec('BEGIN IMMEDIATE');try{
  ensureQueue();const c=state();write(controlKey,{...c,state:action==='resume'?'running':action==='stop'?'stopped':'paused',reason:action==='resume'?'':action,nextAllowedAt:null,rateLimits:0,serverErrors:0,changedAt:now()});
  db.prepare('UPDATE analysis_batches SET status=?,started_at=CASE WHEN ? THEN coalesce(started_at,?) ELSE started_at END WHERE id=?').run(action==='resume'?'running':'paused',action==='resume'?1:0,now(),automaticBatchId);db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}return automaticStatus();
}
function recoverInterrupted(){
 let uncertain=false;
 for(const i of db.prepare("SELECT i.article_id,a.analysis_status,a.analysis_json FROM analysis_batch_items i JOIN articles a ON a.id=i.article_id WHERE i.batch_id=? AND i.status='running'").all(automaticBatchId)){
  if(i.analysis_status==='analyzed'&&i.analysis_json){db.prepare("UPDATE analysis_batch_items SET status='completed',updated_at=? WHERE batch_id=? AND article_id=?").run(now(),automaticBatchId,i.article_id);continue;}
  if(i.analysis_status==='analyzing'){
   uncertain=true;
   db.prepare("UPDATE articles SET analysis_status='failed',analysis_error='DeepSeek request_uncertain',analysis_retry_at=NULL WHERE id=? AND analysis_status='analyzing'").run(i.article_id);
   db.prepare("UPDATE analysis_usage_log SET error='DeepSeek request_uncertain',error_code='request_uncertain' WHERE id=(SELECT MAX(id) FROM analysis_usage_log WHERE article_id=?)").run(i.article_id);
   db.prepare("UPDATE analysis_batch_items SET status='failed',error='DeepSeek request_uncertain',updated_at=? WHERE batch_id=? AND article_id=?").run(now(),automaticBatchId,i.article_id);
  }else db.prepare("UPDATE analysis_batch_items SET status=?,updated_at=? WHERE batch_id=? AND article_id=?").run(i.analysis_status==='failed'?'failed':'queued',now(),automaticBatchId,i.article_id);
 }
 return uncertain;
}
let working=false;
export async function automaticTick(){
 if(working)return {status:'busy'};
 if(process.env.FANSCOPE_AI_AUTO_ENABLED!=='true'||!config.dsKey)return {status:'disabled'};
 const owner=crypto.randomUUID();working=true;let leased=false;
 try{
  db.exec('BEGIN IMMEDIATE');try{
   const c=state(),lease=read(leaseKey);if(c.state!=='running'||c.nextAllowedAt&&Date.parse(c.nextAllowedAt)>Date.now()){db.exec('COMMIT');return {status:c.state};}
   if(lease&&lease.expiresAt>Date.now()){db.exec('COMMIT');return {status:'busy'};}
   write(leaseKey,{owner,expiresAt:Date.now()+120000});leased=true;if(recoverInterrupted())write(controlKey,{...c,state:'blocked',reason:'request_uncertain'});fillQueue();db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  // Completed results are never resubmitted even if a prior process died before item bookkeeping.
  db.prepare("UPDATE analysis_batch_items SET status='cached',updated_at=? WHERE batch_id=? AND status IN ('queued','running','failed') AND article_id IN (SELECT id FROM articles WHERE analysis_status='analyzed' AND coalesce(analysis_json,'')<>'')").run(now(),automaticBatchId);
  if(state().state!=='running')return {status:state().state};
  const cutoff=new Date(Date.parse(publicationToday()+'T00:00:00Z')-179*86400000).toISOString().slice(0,10);
  db.exec('BEGIN IMMEDIATE');let item;try{
   if(state().state!=='running'||read(leaseKey)?.owner!==owner){db.exec('COMMIT');return {status:state().state};}
   item=db.prepare(`SELECT a.* FROM analysis_batch_items i JOIN articles a ON a.id=i.article_id JOIN journals j ON j.id=a.journal_id
    WHERE i.batch_id=? AND i.status='queued' AND (a.analysis_retry_at IS NULL OR a.analysis_retry_at<=?) AND ${criteria()}
    ORDER BY CASE WHEN ${date}>=? THEN 0 ELSE 1 END,${date} DESC,a.id LIMIT 1`).get(automaticBatchId,now(),minAbstract(),publicationToday(),cutoff);
   if(item)db.prepare("UPDATE analysis_batch_items SET status='running',attempts=attempts+1,updated_at=? WHERE batch_id=? AND article_id=? AND status='queued'").run(now(),automaticBatchId,item.id);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  if(!item)return {status:'idle'};
  const result=await analyzePending(1,{articleId:item.id,batchId:automaticBatchId});
  db.exec('BEGIN IMMEDIATE');try{
  if(read(leaseKey)?.owner!==owner){db.exec('COMMIT');return {status:'lease_lost',articleId:item.id};}
  const a=db.prepare('SELECT analysis_status,analysis_json,analysis_error,analysis_retry_at FROM articles WHERE id=?').get(item.id);
  const code=(a.analysis_error||'').replace('DeepSeek ','');let c=state(),itemState='failed';
  if(a.analysis_status==='analyzed'&&a.analysis_json){itemState='completed';c={...c,rateLimits:0,serverErrors:0};}
  else if(!result.attempts){itemState='queued';}
  else if(['http_401','http_402','http_403'].includes(code)){
   itemState='queued';db.prepare("UPDATE articles SET analysis_status='pending',analysis_retry_at=NULL WHERE id=? AND coalesce(analysis_json,'')=''").run(item.id);c={...c,state:'blocked',reason:code};
  }else if(code==='http_429'){
   const n=(c.rateLimits||0)+1;itemState=a.analysis_status==='needs_retry'?'queued':'failed';c={...c,rateLimits:n,state:n>=3?'blocked':c.state,reason:n>=3?'persistent_rate_limit':c.reason,nextAllowedAt:new Date(Date.now()+Math.min(900,60*2**(n-1))*1000).toISOString()};
  }else if(/^http_5/.test(code)){
   const n=(c.serverErrors||0)+1;itemState=a.analysis_status==='needs_retry'?'queued':'failed';c={...c,serverErrors:n,state:n>=3?'blocked':c.state,reason:n>=3?'provider_unavailable':c.reason};
  }else if(code==='request_uncertain')c={...c,state:'blocked',reason:'request_uncertain'};
  else itemState=a.analysis_status==='needs_retry'?'queued':'failed';
  // Do not undo a human pause/stop that happened while the HTTP request was in flight.
  const latest=state();if(['paused','stopped'].includes(latest.state))c={...c,state:latest.state,reason:latest.reason};
  write(controlKey,c);
  db.prepare("UPDATE analysis_batch_items SET status=?,error=?,next_attempt_at=?,updated_at=? WHERE batch_id=? AND article_id=? AND status='running'").run(itemState,a.analysis_error||'',a.analysis_retry_at,now(),automaticBatchId,item.id);
  if(c.state==='blocked')db.prepare("UPDATE analysis_batches SET status='paused',error=? WHERE id=?").run(c.reason,automaticBatchId);
  db.exec('COMMIT');
  return {status:c.state,articleId:item.id,result:itemState};
  }catch(e){db.exec('ROLLBACK');throw e;}
 }finally{
  if(leased){const lease=read(leaseKey);if(lease?.owner===owner)db.prepare('DELETE FROM meta WHERE key=?').run(leaseKey);}
  working=false;
 }
}
