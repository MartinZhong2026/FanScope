// K5 jobs: what the durable scheduler runs on the production server.
// English journals reuse the existing incremental monitor and its persistent
// scan_windows cursors; Chinese journals run only when BOTH the reviewed source
// registry and the verified source record allow it; diagnostic retention purge.
import fs from 'node:fs';
import {db} from '../db.mjs';
import {config} from '../config.mjs';
import {readGate} from '../platform/scheduler.mjs';
import {log,errorFields} from '../platform/log.mjs';

const MINUTE=60000,HOUR=60*MINUTE;
export const CHINESE_STATUS=JSON.parse(fs.readFileSync(new URL('../../config/chinese-source-status.json',import.meta.url),'utf8'));
const AUTOMATIC=new Set(['A','B']);

// A journal counts as automatic only with a reviewed A/B status AND a verified
// source for the journal row with the same ISSN. Nothing is inferred from
// reachability or from existing rows.
export function eligibleChineseJournals(){
 const verified=new Map(db.prepare("SELECT key,value FROM meta WHERE key LIKE 'cn-source:%'").all().map(r=>{try{return [r.key.slice(10),JSON.parse(r.value)]}catch{return [r.key.slice(10),null]}}));
 const byIssn=new Map(db.prepare("SELECT id,issn FROM journals WHERE market='chinese' AND enabled=1").all().map(j=>[j.issn,j.id]));
 return CHINESE_STATUS.journals.filter(j=>AUTOMATIC.has(j.status)&&verified.get(byIssn.get(j.issn))?.verified).map(j=>byIssn.get(j.issn));
}

export async function runEnglishJob({checkpoint}){
 const {scanAll}=await import('../monitor.mjs');
 // Same safety filter as the V1.4 monitor: never start a historical backfill here.
 const ids=db.prepare(`SELECT j.id FROM journals j LEFT JOIN scan_windows w ON w.journal_id=j.id
  WHERE j.market='international' AND j.enabled=1 AND COALESCE(j.checkpoint,'')<>''
   AND (w.journal_id IS NULL OR w.status='complete' OR w.mode='incremental') ORDER BY j.id`).all().map(r=>r.id);
 let failed=0,added=0;
 for(const journalId of ids){
  checkpoint();
  const r=await scanAll({journalId});
  if(r.status!=='ok')failed++;
  added+=r.newCount||0;
 }
 if(ids.length&&failed===ids.length)throw Object.assign(Error('Every journal failed this cycle'),{code:'ingest_all_failed'});
 return {journals:ids.length,failed,added};
}

const MAX_STEPS=200;
export async function runChineseJob({checkpoint}){
 const ids=eligibleChineseJournals();
 if(!ids.length)return {journals:0,reason:'no_verified_sources'};
 const {createChineseJob,stepChineseJob}=await import('../chinese-ingestion.mjs');
 let failed=0,added=0;
 for(const journalId of ids){
  checkpoint();
  try{
   // A previous paused job keeps its cursor and resumes after a restart.
   const open=db.prepare("SELECT value FROM meta WHERE key LIKE 'cn-job:%'").all().map(r=>JSON.parse(r.value)).find(j=>j.journalId===journalId&&['paused','running'].includes(j.status));
   let job=open||createChineseJob({journalId,incremental:true});
   for(let i=0;i<MAX_STEPS&&['paused','running'].includes(job.status);i++){checkpoint();job=await stepChineseJob(job.id)}
   added+=job.added||0;
  }catch(e){
   if(e?.code==='scheduler_hold')throw e;
   failed++;log('warn','ingest.source_failed',{market:'chinese',journal_id:journalId,...errorFields(e)});
  }
 }
 if(failed===ids.length)throw Object.assign(Error('Every journal failed this cycle'),{code:'ingest_all_failed'});
 return {journals:ids.length,failed,added};
}

export function schedulerJobs(){
 return [
  {name:'ingest:english',intervalMs:config.intervalMinutes*MINUTE,jitterMs:5*MINUTE,timeoutMs:60*MINUTE,run:runEnglishJob},
  {name:'ingest:chinese',intervalMs:24*HOUR,jitterMs:30*MINUTE,timeoutMs:60*MINUTE,run:runChineseJob},
  {name:'lifecycle:dx-purge',intervalMs:HOUR,jitterMs:5*MINUTE,timeoutMs:10*MINUTE,run:async()=>{
   const {enabled,purgeDue}=await import('../diagnostic/service.mjs');
   return enabled()?purgeDue():{skipped:'diagnostic_disabled'};
  }},
 ];
}

// Public, read-only: no secrets, no private text. Absent table means the
// scheduler migration has not been applied on this database yet.
export function ingestFreshness(){
 const hasJobs=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_jobs'").get();
 const jobs=hasJobs?db.prepare('SELECT name,next_due_at,last_started_at,last_finished_at,last_status,last_error_code,consecutive_failures FROM scheduled_jobs ORDER BY name').all():[];
 const english=db.prepare("SELECT COUNT(*) journals,MAX(last_success) last_success,SUM(COALESCE(last_error,'')<>'') failing FROM journals WHERE market='international' AND enabled=1").get();
 const eligible=new Set(eligibleChineseJournals());
 const ids=new Map(db.prepare("SELECT id,issn FROM journals WHERE market='chinese'").all().map(j=>[j.issn,j.id]));
 const journals=CHINESE_STATUS.journals.map(j=>({...j,automatic:eligible.has(ids.get(j.issn))}));
 const summary={};for(const j of journals)summary[j.status]=(summary[j.status]||0)+1;
 return {scheduler:process.env.FANSCOPE_SCHEDULER==='true'?'on':'off',gate:readGate().reason,jobs,english,
  chinese:{total:journals.length,automatic:journals.filter(j=>j.automatic).length,byStatus:summary,reviewedAt:CHINESE_STATUS.reviewedAt,journals}};
}
