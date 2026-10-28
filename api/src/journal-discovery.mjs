// Durable operator-triggered Crossref discovery queue. No paid AI calls.
import crypto from 'node:crypto';
import {db,now} from './db.mjs';
import {discoverJournalSource} from './journal-onboarding.mjs';
const invalid=(msg,status=400)=>Object.assign(Error(msg),{status});
let running=false;
export function queueJournalDiscoveries({ids=[]}={}){
 if(!Array.isArray(ids)||ids.length>22)throw invalid('最多22本英文期刊');
 const known=db.prepare("SELECT id FROM journals WHERE market='international' AND enabled=0 ORDER BY title").all().map(j=>j.id);
 const selected=ids.length?[...new Set(ids.map(String))]:known;
 if(!selected.length||selected.some(id=>!known.includes(id)))throw invalid('仅允许对待配置的英文期刊发起来源调查');
 const jobs=[];const t=now();
 const stmt=db.prepare("INSERT INTO journal_discovery_jobs(id,journal_id,created_at,updated_at,status) VALUES(?,?,?,?, 'paused')");
 const skipped=[];
 for(const id of selected){
  const existing=db.prepare("SELECT id FROM journal_discovery_jobs WHERE journal_id=? AND status IN ('paused','queued','running') ORDER BY created_at DESC LIMIT 1").get(id);
  if(existing){skipped.push(id);continue;}
  const jobId=crypto.randomUUID();stmt.run(jobId,id,t,t);jobs.push({id:jobId,journalId:id,status:'paused'});
 }
 return {created:jobs.length,skipped,items:jobs,note:'任务已创建且暂停；管理员明确启动后才会访问 Crossref，绝不自动启用期刊。'};
}
export function getJournalDiscoveries(){
 return {items:db.prepare(`SELECT q.*,j.title FROM journal_discovery_jobs q JOIN journals j ON j.id=q.journal_id ORDER BY q.created_at DESC LIMIT 120`).all().map(x=>({...x,candidates:JSON.parse(x.candidate_json||'[]')}))};
}
export function updateJournalDiscovery(id,action){
 if(!['start','pause','retry'].includes(action))throw invalid('Unknown action');
 const row=db.prepare('SELECT * FROM journal_discovery_jobs WHERE id=?').get(String(id||''));
 if(!row)throw invalid('Unknown task',404);
 if(action==='start'&&row.status!=='paused'||action==='retry'&&row.status!=='failed')throw invalid('Task state does not allow this action',409);
 if(action==='pause'&&!['running','queued'].includes(row.status))throw invalid('Task is not running',409);
 const status=action==='pause'?'paused':'queued';
 db.prepare('UPDATE journal_discovery_jobs SET status=?,updated_at=?,last_error=? WHERE id=?').run(status,now(),status==='queued'?'':row.last_error,id);
 return {id,status};
}
export function startAllJournalDiscoveries(){
 const changed=db.prepare("UPDATE journal_discovery_jobs SET status='queued',updated_at=? WHERE status='paused'").run(now()).changes;
 return {started:changed,note:'待处理的来源调查已排队；仅从 Crossref 获取公开元数据，不调用 DeepSeek，也不会自动启用期刊。'};
}
export function recoverJournalDiscoveries(){
 db.prepare("UPDATE journal_discovery_jobs SET status='queued',updated_at=? WHERE status='running'").run(now());
}
export async function discoveryTick(request){
 if(running)return {status:'busy'};
 const job=db.prepare("SELECT * FROM journal_discovery_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1").get();
 if(!job)return {status:'idle'};
 running=true;
 db.prepare("UPDATE journal_discovery_jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=?").run(now(),job.id);
 try{
  const r=await discoverJournalSource(job.journal_id,request);
  const status=r.candidates.length?'completed':'needs_review';
  // A paused task cannot become completed while an in-flight HTTP call finishes.
  db.prepare("UPDATE journal_discovery_jobs SET status=?,candidate_json=?,updated_at=?,finished_at=?,last_error='' WHERE id=? AND status='running'")
   .run(status,JSON.stringify(r.candidates),now(),now(),job.id);
  return {id:job.id,status,candidates:r.candidates};
 }catch(e){
  db.prepare("UPDATE journal_discovery_jobs SET status='failed',last_error=?,updated_at=? WHERE id=? AND status='running'").run(String(e.message).slice(0,240),now(),job.id);
  return {id:job.id,status:'failed',error:String(e.message).slice(0,240)};
 }finally{running=false;}
}
