// Explicit isolated acceptance run: never uses the default or production DB.
// node --use-env-proxy scripts/backfill-journals.mjs /absolute/work/output-dir
// Re-run the same command to resume the artifact database and job checkpoints.
import fs from 'node:fs';
import path from 'node:path';
const output=process.argv[2];
if(!output||!path.isAbsolute(output))throw Error('An absolute, isolated artifact directory is required');
if(process.env.DATABASE_PATH)throw Error('Unset DATABASE_PATH: this command only creates its own acceptance database');
fs.mkdirSync(output,{recursive:true});
const database=path.join(output,'acceptance.sqlite'),marker=path.join(output,'acceptance-marker.json');
if(fs.existsSync(database)&&!fs.existsSync(marker))throw Error('Refusing to open an unmarked existing database');
fs.writeFileSync(marker,JSON.stringify({purpose:'isolated public metadata acceptance; never production'}));
process.env.DATABASE_PATH=database;process.env.SCAN_ON_START='false';process.env.DEEPSEEK_API_KEY='';process.env.RESEND_API_KEY='';
const {db}=await import('../api/src/db.mjs');
const {journals}=await import('../api/src/config.mjs');
const {probeJournalSource,sourceSummary}=await import('../api/src/journal-onboarding.mjs');
const {createBackfill,changeBackfill,workBackfillTick,getBackfill}=await import('../api/src/journal-backfill.mjs');
const {fetchJson}=await import('../api/src/sources.mjs');
const {scanAll}=await import('../api/src/monitor.mjs');
const results=[];
for(const config of journals.filter(j=>j.market==='international')){
 const issn=config.candidate_issn||config.issn;
 try{
  const verification=await probeJournalSource({id:config.id,issn,enable:true,confirm:true});
  if(!verification.verified)throw Error('Identity not verified');
  // Incremental scan is independently measured. On its first run notifications
  // are silent and these cursors are never used by historical backfill.
  const monitored=db.prepare('SELECT checkpoint FROM journals WHERE id=?').get(config.id).checkpoint;
  const incremental=monitored?{status:'previous_scan_retained'}:await scanAll({journalId:config.id,lookbackDays:1});
  const before=db.prepare('SELECT checkpoint FROM journals WHERE id=?').get(config.id).checkpoint;
  let job=db.prepare('SELECT * FROM journal_backfill_jobs WHERE journal_id=? ORDER BY created_at DESC LIMIT 1').get(config.id);
  if(!job||process.argv.includes('--replay')&&job.status==='completed')job=createBackfill({journalId:config.id,yearFrom:process.argv.includes('--include-2025')?2025:new Date().getUTCFullYear(),yearTo:new Date().getUTCFullYear()});
  if(job.status!=='completed')changeBackfill(job.id,'start');
  const request=async url=>{
   const data=await fetchJson(url,45000);
   // Preserve original public responses separately from normalized metadata.
   fs.appendFileSync(path.join(output,'crossref-pages.jsonl'),JSON.stringify({journalId:config.id,url,at:new Date().toISOString(),data})+'\n');
   return data;
  };
  let ticks=0;
  while(getBackfill(job.id).status==='running'&&ticks++<100){
   const progress=await workBackfillTick({maxPages:4,windowDays:366,pageSize:1000,request});
   console.log(config.id,JSON.stringify(progress));
  }
  job=getBackfill(job.id);
  if(db.prepare('SELECT checkpoint FROM journals WHERE id=?').get(config.id).checkpoint!==before)throw Error('Historical backfill changed incremental checkpoint');
  const counts=db.prepare("SELECT COUNT(*) count,MIN(NULLIF(publication_date,'')) first,MAX(NULLIF(publication_date,'')) last,SUM(date_precision='month') monthPrecision,SUM(date_precision='year') yearPrecision,SUM(notification_eligible) notificationEligible FROM articles WHERE journal_id=?").get(config.id);
  results.push({journalId:config.id,verification,incremental,job,counts});
 }catch(e){results.push({journalId:config.id,error:String(e.message)});console.log(config.id,'FAILED',e.message)}
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2)+'\n');
}
const records=fs.openSync(path.join(output,'articles.jsonl'),'w');
for(const row of db.prepare('SELECT a.*,j.title AS journal_title FROM articles a JOIN journals j ON a.journal_id=j.id ORDER BY a.journal_id,a.publication_date,a.id').iterate())fs.writeSync(records,JSON.stringify(row)+'\n');
fs.closeSync(records);
fs.writeFileSync(path.join(output,'source-status.json'),JSON.stringify(sourceSummary(),null,2)+'\n');
const checks={integrity:db.prepare('PRAGMA integrity_check').get(),aiUsage:db.prepare('SELECT COUNT(*) n FROM analysis_usage_log').get().n,aiBatches:db.prepare('SELECT COUNT(*) n FROM analysis_batches').get().n,deliveries:db.prepare('SELECT COUNT(*) n FROM deliveries').get().n,notificationEligible:db.prepare('SELECT COUNT(*) n FROM articles WHERE notification_eligible=1').get().n};
fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify(checks,null,2)+'\n');db.close();
