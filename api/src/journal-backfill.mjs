// Durable, operator-started historical Crossref backfill. No AI calls.
// Each job stores its own cursor; normal incremental scan_windows remain untouched.
import crypto from 'node:crypto';
import {db,now} from './db.mjs';
import {crossrefPages} from './sources.mjs';
import {currentResearchYear,trendWindow,publicationBackfillEnd} from './publication-policy.mjs';
import {insertArticle} from './monitor.mjs';
const bad=(message,status=400)=>Object.assign(new Error(message),{status});
let processing=false;
export function createBackfill({journalId,yearFrom=currentResearchYear(),yearTo=currentResearchYear(),period}={}){
 const from=Number(yearFrom),to=Number(yearTo);
 if(!Number.isInteger(from)||!Number.isInteger(to)||from<2000||to>currentResearchYear()||to<from||to-from>2)throw bad('请选择不超过3年的已开始年度范围');
 const j=db.prepare('SELECT * FROM journals WHERE id=?').get(String(journalId||''));
 if(!j||!j.enabled||j.source!=='crossref'||!j.issn)throw bad('仅支持已核验启用且具有 ISSN 的 Crossref 期刊',409);
 if(period&&!['30d','90d','180d','ytd'].includes(period))throw bad('回填时间窗口仅支持 30d/90d/180d/ytd');
 const rangeStart=period?trendWindow(period).start+'T00:00:00.000Z':`${from}-01-01T00:00:00.000Z`;
 const toExclusive=publicationBackfillEnd(period?currentResearchYear():to);
 const overlaps=db.prepare("SELECT id,from_date FROM journal_backfill_jobs WHERE journal_id=? AND status IN ('paused','running') AND NOT(to_date<=? OR from_date>=?)").all(j.id,rangeStart,toExclusive);
 const currentStart=`${currentResearchYear()}-01-01T00:00:00.000Z`;
 const deferred=rangeStart>=currentStart&&overlaps.every(x=>x.from_date<currentStart);
 if(overlaps.length&&!deferred)throw bad('该期刊已有重叠年份的待处理任务，请继续原任务',409);
 const id=crypto.randomUUID(),created=now();
 // A paused mixed 2025–2026 job must not force the operator to finish 2025
 // before starting a 2026-only job. Its checkpoint and records stay intact.
 for(const old of overlaps)db.prepare("UPDATE journal_backfill_jobs SET status='paused',error='已让位当前年度优先回填；旧历史范围与检查点保留，可选恢复',updated_at=? WHERE id=?").run(now(),old.id);
 db.prepare(`INSERT INTO journal_backfill_jobs
 (id,journal_id,from_date,to_date,status,created_at,updated_at,source_identifier)
 VALUES(?,?,?,?,?,?,?,?)`).run(id,j.id,rangeStart,toExclusive,'paused',created,created,j.issn);
 return getBackfill(id);
}
export function getBackfill(id){const j=db.prepare('SELECT * FROM journal_backfill_jobs WHERE id=?').get(String(id));if(!j)throw bad('任务不存在',404);return j}
export function backfillSummary(){
 const rows=db.prepare('SELECT b.*,j.title AS journal_title FROM journal_backfill_jobs b JOIN journals j ON j.id=b.journal_id ORDER BY created_at DESC LIMIT 200').all();
 return {items:rows,active:db.prepare("SELECT COUNT(*) n FROM journal_backfill_jobs WHERE status='running'").get().n};
}
export function changeBackfill(id,action){
 if(!['start','pause','cancel'].includes(action))throw bad('无效任务操作');
 const job=getBackfill(id);
 if(['completed','cancelled'].includes(job.status))throw bad('已经结束的任务不能再次启动',409);
 const state=action==='start'?'running':action==='pause'?'paused':'cancelled';
 db.prepare(`UPDATE journal_backfill_jobs SET status=?,started_at=CASE WHEN ?='running' THEN coalesce(started_at,?) ELSE started_at END,finished_at=CASE WHEN ?='cancelled' THEN ? ELSE finished_at END,updated_at=?,error='' WHERE id=?`).run(state,state,now(),state,now(),now(),id);
 return getBackfill(id);
}
export async function workBackfillTick({maxPages=2,request,windowDays=7,pageSize=100}={}){
 if(processing)return {status:'busy'};
 processing=true;
 try {
  const job=db.prepare("SELECT * FROM journal_backfill_jobs WHERE status='running' ORDER BY CASE WHEN from_date>=strftime('%Y-01-01','now') THEN 0 ELSE 1 END,created_at LIMIT 1").get();
  if(!job)return {status:'idle'};
  const j=db.prepare('SELECT * FROM journals WHERE id=?').get(job.journal_id);
  if(!j||!j.enabled||j.source!=='crossref'){db.prepare("UPDATE journal_backfill_jobs SET status='paused',error='期刊不再启用 Crossref 来源',updated_at=? WHERE id=?").run(now(),job.id);return {status:'paused',id:job.id};}
  if(job.source_identifier!==j.issn){db.prepare("UPDATE journal_backfill_jobs SET status='paused',error='来源 ISSN 已更改或旧任务缺少来源快照；请取消旧任务后重新创建',updated_at=? WHERE id=?").run(now(),job.id);return {status:'paused',id:job.id};}
  let added=0,pages=0;let last=null;
  const old=job.range_end?{
   mode:'backfill',range_end:job.range_end,window_start:job.window_start,
   window_end:job.window_end,cursor:job.cursor,processed:job.processed,total:job.total,
   attempts:job.attempts,status:job.status,error:job.error
  }:null;
  const onState=state=>{
   last=state;
   db.prepare(`UPDATE journal_backfill_jobs SET mode=?,range_end=?,window_start=?,window_end=?,cursor=?,processed=?,total=?,attempts=?,error=?,updated_at=? WHERE id=?`)
     .run(state.mode,state.range_end,state.window_start,state.window_end,state.cursor,state.processed,state.total,state.attempts,state.error||'',now(),job.id);
  };
  try{
   for await(const records of crossrefPages(j,{initial:true,fromDate:job.from_date,toDate:job.to_date,state:old,onState,shouldContinue:()=>getBackfill(job.id).status==='running',maxPages:Math.min(4,Math.max(1,maxPages)),windowDays,pageSize,strictPageBudget:true,...(request?{request}:{})})){
    // Stop at the page boundary. Committed article rows precede cursor updates.
    let pageAdded=0;
    db.exec('BEGIN IMMEDIATE');try{
     for(const record of records)if(insertArticle({...record,scan_mode:'backfill'}))pageAdded++;
     db.prepare('UPDATE journal_backfill_jobs SET added_articles=added_articles+?,pages_done=pages_done+1,updated_at=? WHERE id=?').run(pageAdded,now(),job.id);
     db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e}
    added+=pageAdded;pages++;
   }
   if(last?.status==='complete'){
    db.prepare("UPDATE journal_backfill_jobs SET status='completed',finished_at=?,error='',updated_at=? WHERE id=? AND status='running'").run(now(),now(),job.id);
   }
   return {status:last?.status==='complete'?'completed':'progress',id:job.id,pages,added};
  }catch(e){
   // Do not automatically retry failed jobs: operator reviews error first.
   db.prepare("UPDATE journal_backfill_jobs SET status=CASE WHEN status='running' THEN 'paused' ELSE status END,error=?,updated_at=? WHERE id=?")
     .run(String(e.message).slice(0,230),now(),job.id);
   return {status:'paused',id:job.id,error:String(e.message).slice(0,230),pages,added};
  }
 } finally{processing=false;}
}
