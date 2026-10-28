// Durable, SQLite-backed AI work queue. No Redis or Trigger.dev infrastructure.
// Creating a batch never spends money; an administrator must explicitly start it.
import crypto from 'node:crypto';
import {db,now} from './db.mjs';
import {analyzePending,analysisFingerprint,analysisIsCurrent} from './ai.mjs';
import {config} from './config.mjs';
import {currentResearchYear,publicationToday} from './publication-policy.mjs';
import {researchWhere,researchReport,validatedAnalysis,hasAnalysisEvidence} from './research.mjs';

const finalStates=['completed','cached','insufficient_abstract','failed','excluded'];
let processing=false;
const bad=(message,status=400)=>Object.assign(Error(message),{status});
function validCached(a){return analysisIsCurrent(a)}
export function coverage(q={period:'ytd'}){
 const {where,params}=researchWhere(q),report=researchReport(q);
 const rows=db.prepare('SELECT analysis_status,COUNT(*) n FROM articles a'+where+' GROUP BY analysis_status').all(...params);
 return {total:report.n,statuses:Object.fromEntries(rows.map(r=>[r.analysis_status,r.n])),validDesign:report.known.design,validMethods:report.known.methods,validSamples:report.known.sample,validTopics:report.known.topics,validData:report.known.data,evidenced:report.evidenced,evidenceCoverage:report.coverage,known:report.known,missingRates:report.unknown_rates,missingAbstract:report.missingAbstract,window:report.window};
}
export function createBatch(opts={}){
 const yearFrom=opts.yearFrom===undefined?currentResearchYear():Number(opts.yearFrom);
 const yearTo=opts.yearTo===undefined?currentResearchYear():Number(opts.yearTo);
 const limit=opts.limit===undefined?150:Number(opts.limit);
 if(!Number.isInteger(yearFrom)||!Number.isInteger(yearTo)||yearFrom<2000||yearTo>2100||yearFrom>yearTo)throw bad('Invalid year range');
 if(!Number.isInteger(limit)||limit<1||limit>1000)throw bad('Limit must be between 1 and 1000');
 const policy=opts.policy||'trend_candidates';
 if(!['trend_candidates','custom'].includes(policy))throw bad('Invalid analysis policy');
 if(policy==='trend_candidates'&&(limit>200||yearFrom!==currentResearchYear()||yearTo!==currentResearchYear()))throw bad('趋势候选仅准备当前年度最多200篇；历史自定义分析需明确选择 custom');
 const journalId=opts.journalId?String(opts.journalId):'';
 if(journalId&&!db.prepare('SELECT id FROM journals WHERE id=?').get(journalId))throw bad('Unknown journal');
 // Legacy budget inputs are ignored. Administrator-started batches are
 // controlled by selected articles, pause/cancel and provider account balance.
 // The old nullable SQLite column is retained for migration compatibility.
 const args=[String(yearFrom),String(yearTo)],parts=["substr(COALESCE(NULLIF(publication_date_partial,''),NULLIF(published_online_date,''),publication_date),1,4) BETWEEN ? AND ?"];
 if(policy==='trend_candidates'){parts.push("demo=0 AND article_type='original_research' AND article_type_evidence_json<>'{}' AND relevance_score>=3 AND length(trim(coalesce(abstract,'')))>=55 AND COALESCE(NULLIF(publication_date_partial,''),NULLIF(published_online_date,''),publication_date)<=?");args.push(publicationToday())}
 if(journalId){parts.push('journal_id=?');args.push(journalId)}
 // Stable IDs and newest qualified papers first; never fill a quota with unknown types.
 const articles=db.prepare(`SELECT id,title,substr(abstract,1,7000) AS abstract,analysis_status,analysis_json,analysis_input_hash,analysis_normalized_hash FROM articles WHERE ${parts.join(' AND ')} ORDER BY COALESCE(NULLIF(publication_date_partial,''),NULLIF(published_online_date,''),publication_date) DESC,relevance_score DESC,id ASC LIMIT ?`).all(...args,limit);
 const id=crypto.randomUUID(),created=now();
 db.exec('BEGIN IMMEDIATE');
 try{
  db.prepare('INSERT INTO analysis_batches(id,created_at,status,filter_json,total,estimated_cost_limit_cny) VALUES(?,?,?,?,?,?)').run(id,created,'paused',JSON.stringify({yearFrom,yearTo,journalId,limit,policy}),articles.length,null);
  const insert=db.prepare('INSERT INTO analysis_batch_items(batch_id,article_id,status,updated_at) VALUES(?,?,?,?)');
  for(const a of articles)insert.run(id,a.id,validCached(a)?'cached':(a.abstract||'').trim().length<55?'insufficient_abstract':'queued',created);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e}
 return batchDetail(id);
}
export function analysisFailure(error=''){
 const match=String(error).match(/^DeepSeek (http_\d{3}|length|empty_content|invalid_json|unexpected_finish_reason|missing_analysis|request_uncertain)$/);
 const code=match?.[1]||'other';
 const messages={length:'模型输出达到长度限制，未得到完整分析',empty_content:'模型返回空内容',invalid_json:'模型返回的 JSON 无法解析',unexpected_finish_reason:'模型提前终止输出',missing_analysis:'响应缺少结构化分析',request_uncertain:'请求中断，是否完成及计费尚不确定；请先核对供应商账单',http_429:'供应商限流',http_401:'供应商认证失败，请检查服务端配置',http_402:'供应商余额不足，请核对账户',http_403:'供应商拒绝请求，请检查账户权限',other:'任务未完成，请由管理员核对文章状态及服务日志'};
 return {code,message:messages[code]||(code.startsWith('http_5')?'供应商服务暂不可用':'供应商请求失败，请核对服务状态'),mayHaveCost:!['http_400','http_401','http_402','http_403','http_404','http_429'].includes(code)};
}
export function batchDetail(id){
 const b=db.prepare('SELECT * FROM analysis_batches WHERE id=?').get(id);if(!b)throw bad('Unknown batch',404);
 const counts=db.prepare('SELECT status,COUNT(*) n FROM analysis_batch_items WHERE batch_id=? GROUP BY status').all(id);
 const spend=db.prepare(`SELECT COUNT(*) requests,SUM(input_tokens) input_tokens,SUM(output_tokens) output_tokens,
  SUM(cost_cny) estimated_cost_cny,SUM(CASE WHEN status='completed' THEN cost_cny ELSE 0 END) reported_cost,
  SUM(CASE WHEN status<>'completed' THEN cost_cny ELSE 0 END) reserved_cost,
  SUM(CASE WHEN status<>'completed' THEN 1 ELSE 0 END) uncertain_requests,
  SUM(CASE WHEN cost_cny IS NULL THEN 1 ELSE 0 END) unpriced_requests
  FROM analysis_usage_log WHERE batch_id=?`).get(id);
 const count=Object.fromEntries(counts.map(x=>[x.status,x.n]));
 const settled=finalStates.reduce((n,k)=>n+(count[k]||0),0),succeeded=(count.completed||0)+(count.cached||0);
 const evidenced=db.prepare("SELECT a.* FROM articles a JOIN analysis_batch_items i ON i.article_id=a.id WHERE i.batch_id=? AND i.status IN ('completed','cached')").all(id).filter(a=>hasAnalysisEvidence(validatedAnalysis(a))).length;
 const failures=db.prepare("SELECT status,error,COUNT(*) n FROM analysis_batch_items WHERE batch_id=? AND status IN ('failed','queued') AND error<>'' GROUP BY status,error").all(id);
 const reasons=new Map();for(const f of failures){const reason=analysisFailure(f.error),key=f.status+':'+reason.code;const row=reasons.get(key)||{...reason,status:f.status,count:0};row.count+=f.n;reasons.set(key,row);}
 const nextRetryAt=db.prepare("SELECT MIN(next_attempt_at) at FROM analysis_batch_items WHERE batch_id=? AND status='queued' AND next_attempt_at>?").get(id,now()).at;
 return {...b,filter:JSON.parse(b.filter_json),counts:count,
  progress:{settled,total:b.total,percent:b.total?Math.round(100*settled/b.total):null,succeeded,evidenced,withoutEvidence:succeeded-evidenced,running:count.running||0,nextRetryAt},
  failures:[...reasons.values()],
  usage:{requests:spend.requests||0,inputTokens:spend.input_tokens||0,outputTokens:spend.output_tokens||0,
   estimatedCostCny:spend.unpriced_requests?null:(spend.estimated_cost_cny||0),reportedCostCny:spend.reported_cost||0,reservedCostCny:spend.reserved_cost||0,
   uncertainRequests:spend.uncertain_requests||0,unpricedRequests:spend.unpriced_requests||0},items:undefined};
}
export function listBatches(){return db.prepare('SELECT id FROM analysis_batches ORDER BY created_at DESC LIMIT 30').all().map(x=>batchDetail(x.id))}
export function setBatchBudget(id){
 // Backwards-compatible no-op for clients still calling the former endpoint.
 // No budget column is used to block execution.
 return batchDetail(id);
}
export function changeBatch(id,action){
 const b=db.prepare('SELECT status FROM analysis_batches WHERE id=?').get(id);if(!b)throw bad('Unknown batch',404);
 if(action==='retry'){
  if(b.status==='cancelled'||b.status==='running')throw bad('Pause the batch before retrying failures',409);
  const failed=db.prepare("SELECT article_id FROM analysis_batch_items WHERE batch_id=? AND status='failed'").all(id);
  if(!failed.length)throw bad('No failed items to retry',409);
  db.exec('BEGIN IMMEDIATE');try{
   for(const item of failed)db.prepare("UPDATE articles SET analysis_status=CASE WHEN analysis_status IN ('needs_retry','failed') THEN 'pending' ELSE analysis_status END,analysis_attempts=CASE WHEN analysis_status IN ('needs_retry','failed') THEN 0 ELSE analysis_attempts END,analysis_retry_at=NULL WHERE id=?").run(item.article_id);
   db.prepare("UPDATE analysis_batch_items SET status='queued',attempts=0,next_attempt_at=NULL,error='',updated_at=? WHERE batch_id=? AND status='failed'").run(now(),id);
   db.prepare("UPDATE analysis_batches SET status='paused',finished_at=NULL,error='' WHERE id=?").run(id);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  return batchDetail(id);
 }
 if(!['start','pause','cancel'].includes(action))throw bad('Invalid action');
 if(['completed','cancelled'].includes(b.status))throw bad('Finished batches cannot be restarted',409);
 if(action==='start'&&!config.dsKey)throw bad('DeepSeek API key is not configured',409);
 const next=action==='start'?'running':action==='pause'?'paused':'cancelled';
 db.prepare("UPDATE analysis_batches SET status=?,started_at=CASE WHEN ?='running' THEN coalesce(started_at,?) ELSE started_at END,finished_at=CASE WHEN ?='cancelled' THEN ? ELSE finished_at END WHERE id=?").run(next,next,now(),next,now(),id);
 return batchDetail(id);
}
export function recoverBatches(){
 // A reserved request may already have been billed. Do not replay it on restart.
 // Successful commits still enter the cache path; paused batches stay paused.
 db.prepare("UPDATE analysis_usage_log SET error='DeepSeek request_uncertain',error_code='request_uncertain' WHERE id IN (SELECT max(u.id) FROM analysis_usage_log u JOIN articles a ON a.id=u.article_id WHERE a.analysis_status='analyzing' GROUP BY u.article_id) AND error_code IS NULL").run();
 db.prepare("UPDATE articles SET analysis_status='failed',analysis_error='DeepSeek request_uncertain',analysis_retry_at=NULL WHERE analysis_status='analyzing'").run();
 db.prepare("UPDATE analysis_batch_items SET status='queued',updated_at=? WHERE status='running'").run(now());
}
export async function workBatchTick(maxItems=2){
 if(processing)return {status:'busy'};
 processing=true;
 let completed=0,failed=0;
 try{
  const batch=db.prepare(`SELECT b.* FROM analysis_batches b WHERE b.status='running'
   AND (NOT EXISTS(SELECT 1 FROM analysis_batch_items i WHERE i.batch_id=b.id AND i.status IN ('queued','running'))
        OR EXISTS(SELECT 1 FROM analysis_batch_items i WHERE i.batch_id=b.id AND i.status='queued' AND (i.next_attempt_at IS NULL OR i.next_attempt_at<=?)))
   ORDER BY b.created_at LIMIT 1`).get(now());
  if(!batch)return {status:'idle'};
  for(let i=0;i<Math.max(1,Math.min(5,maxItems));i++){
   if(db.prepare('SELECT status FROM analysis_batches WHERE id=?').get(batch.id)?.status!=='running')break;
   const item=db.prepare("SELECT * FROM analysis_batch_items WHERE batch_id=? AND status='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY updated_at,article_id LIMIT 1").get(batch.id,now());
   if(!item)break;
   const a=db.prepare('SELECT * FROM articles WHERE id=?').get(item.article_id);
   if(!a){db.prepare("UPDATE analysis_batch_items SET status='failed',error='Article not found',updated_at=? WHERE batch_id=? AND article_id=?").run(now(),batch.id,item.article_id);failed++;continue;}
   const scope=JSON.parse(batch.filter_json||'{}');
   const date=a.publication_date_partial||a.published_online_date||a.publication_date||'';
   if(scope.policy==='trend_candidates'&&(a.article_type!=='original_research'||a.article_type_evidence_json==='{}'||a.relevance_score<3||date.slice(0,4)!==String(scope.yearFrom)||date>publicationToday())){
    db.prepare("UPDATE analysis_batch_items SET status='excluded',error='文章类型、相关性或年份已不符合候选条件',updated_at=? WHERE batch_id=? AND article_id=?").run(now(),batch.id,a.id);continue;
   }
   if(validCached(a)){db.prepare("UPDATE analysis_batch_items SET status='cached',updated_at=? WHERE batch_id=? AND article_id=?").run(now(),batch.id,a.id);completed++;continue;}
   if((a.abstract||'').trim().length<55){db.prepare("UPDATE analysis_batch_items SET status='insufficient_abstract',updated_at=? WHERE batch_id=? AND article_id=?").run(now(),batch.id,a.id);continue;}
   if(a.analysis_status==='failed'||a.analysis_status==='analyzing'||(a.analysis_status!=='analyzed'&&a.analysis_attempts>=5)){
    db.prepare("UPDATE analysis_batch_items SET status='failed',error=?,updated_at=? WHERE batch_id=? AND article_id=?").run(a.analysis_error||'DeepSeek request_uncertain',now(),batch.id,a.id);failed++;continue;
   }
   if(!config.dsKey)break;
   // Preserve historical results unless the input genuinely changed.
   if(a.analysis_status==='analyzed')db.prepare("UPDATE articles SET analysis_status='pending',analysis_attempts=0 WHERE id=?").run(a.id);
   db.prepare("UPDATE analysis_batch_items SET status='running',attempts=attempts+1,updated_at=? WHERE batch_id=? AND article_id=?").run(now(),batch.id,a.id);
   const response=await analyzePending(1,{articleId:a.id,batchId:batch.id});
   if(response.status==='busy'||response.skipped||(!response.analyzed&&!response.failed)){db.prepare("UPDATE analysis_batch_items SET status='queued',attempts=max(0,attempts-1),updated_at=? WHERE batch_id=? AND article_id=?").run(now(),batch.id,a.id);break;}
   const updated=db.prepare('SELECT analysis_status,analysis_retry_at,analysis_attempts,analysis_error FROM articles WHERE id=?').get(a.id);
   if(updated?.analysis_status==='analyzed'){
    db.prepare("UPDATE analysis_batch_items SET status='completed',error='',updated_at=? WHERE batch_id=? AND article_id=?").run(now(),batch.id,a.id);completed++;
   }else if(updated?.analysis_status==='needs_retry'&&updated.analysis_attempts<5){
    db.prepare("UPDATE analysis_batch_items SET status='queued',next_attempt_at=?,error=?,updated_at=? WHERE batch_id=? AND article_id=?").run(updated.analysis_retry_at,updated.analysis_error||'',now(),batch.id,a.id);failed++;
   }else{
    db.prepare("UPDATE analysis_batch_items SET status='failed',error=?,updated_at=? WHERE batch_id=? AND article_id=?").run(updated?.analysis_error||'Unable to analyze',now(),batch.id,a.id);failed++;
   }
  }
  const pending=db.prepare("SELECT COUNT(*) n FROM analysis_batch_items WHERE batch_id=? AND status IN ('queued','running')").get(batch.id).n;
  if(!pending)db.prepare("UPDATE analysis_batches SET status='completed',finished_at=? WHERE id=?").run(now(),batch.id);
  return {status:'ok',batchId:batch.id,completed,failed,pending};
 }finally{processing=false}
}
