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

// A journal runs automatically only with a reviewed adapter and an A/B status.
// Reachability or existing rows never count.
export const automaticChinese=()=>CHINESE_STATUS.journals.filter(j=>j.adapter&&AUTOMATIC.has(j.status));
export const eligibleChineseJournals=()=>automaticChinese().map(j=>j.journal_id);

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

// Last outcome per journal, so a collection failure is never shown as "no data".
const recordRun=(entry,value)=>db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
 .run('cn-run:'+entry.issn,JSON.stringify({...value,at:new Date().toISOString()}));
const lastRun=issn=>{try{return JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get('cn-run:'+issn)?.value||'null')}catch{return null}};

export async function runChineseJob({checkpoint}){
 const entries=automaticChinese();
 if(!entries.length)return {journals:0,reason:'no_verified_sources'};
 const {chineseTransport}=await import('../chinese-transport.mjs');
 const {collectJournal}=await import('./official-cn.mjs');
 let failed=0,added=0,abstracts=0;
 for(const entry of entries){
  checkpoint();
  // One budget per journal per run: a long backfill resumes from its saved issue list.
  const transport=chineseTransport({maxRequests:300,minIntervalMs:1500});
  try{
   const r=await collectJournal(entry,{read:transport.read,json:transport.json,checkpoint});
   added+=r.added;abstracts+=r.abstracts;
   recordRun(entry,{status:r.failed?'partial':'ok',failed:r.failed});
  }catch(e){
   if(e?.code==='scheduler_hold')throw e;
   if(/budget exhausted/.test(e?.message)){recordRun(entry,{status:'continuing'});continue}
   recordRun(entry,{status:'failed',code:/^[a-z0-9_]{1,60}$/.test(e?.code||'')?e.code:'source_unreachable'});
   failed++;log('warn','ingest.source_failed',{market:'chinese',journal_id:entry.journal_id,...errorFields(e)});
  }
 }
 if(failed===entries.length)throw Object.assign(Error('Every journal failed this cycle'),{code:'ingest_all_failed'});
 return {journals:entries.length,failed,added,abstracts};
}

export function schedulerJobs(){
 return [
  {name:'ingest:english',intervalMs:config.intervalMinutes*MINUTE,jitterMs:5*MINUTE,timeoutMs:60*MINUTE,run:runEnglishJob},
  {name:'ingest:chinese',intervalMs:6*HOUR,jitterMs:30*MINUTE,timeoutMs:60*MINUTE,run:runChineseJob},
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
 // Real counts per journal, whatever the source state. Titles are the stable join:
 // most journal rows have no ISSN until an adapter has confirmed one.
 const counts=new Map(db.prepare(`SELECT j.title,COUNT(a.id) articles,SUM(length(trim(a.abstract))>=55) abstracts,
  MAX(COALESCE(NULLIF(a.publication_date,''),a.publication_date_partial)) latest,
  SUM(json_extract(a.source_evidence_json,'$.abstract_gap') IS NOT NULL) no_source_abstract
  FROM journals j LEFT JOIN articles a ON a.journal_id=j.id AND a.demo=0 WHERE j.market='chinese' GROUP BY j.id`).all().map(r=>[r.title,r]));
 const journals=CHINESE_STATUS.journals.map(({home,base,journal_key,doi_prefix,...j})=>{const c=counts.get(j.title);
  return {...j,automatic:eligible.has(j.journal_id),articles:c?.articles||0,abstracts:c?.abstracts||0,no_source_abstract:c?.no_source_abstract||0,latest:c?.latest||null,last_run:lastRun(j.issn)}});
 const summary={};for(const j of journals)summary[j.status]=(summary[j.status]||0)+1;
 return {scheduler:process.env.FANSCOPE_SCHEDULER==='true'?'on':'off',gate:readGate().reason,jobs,english,
  chinese:{total:journals.length,automatic:journals.filter(j=>j.automatic).length,withArticles:journals.filter(j=>j.articles).length,articles:journals.reduce((n,j)=>n+j.articles,0),abstracts:journals.reduce((n,j)=>n+j.abstracts,0),byStatus:summary,reviewedAt:CHINESE_STATUS.reviewedAt,journals}};
}
