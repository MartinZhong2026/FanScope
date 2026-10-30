// Experimental staged recovery: interactive login and English metadata monitoring.
// No historical worker, paid API, email dispatch or CSV workbench is enabled.
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {config} from './config.mjs';
import {log,errorFields,requestIdFrom,routeTemplate} from './platform/log.mjs';

export function createStagedRecoveryServer(makeServer,{allowAutoControl=false,allowDiagnostic=false}={}){
 const server=makeServer(),listeners=server.listeners('request');
 if(listeners.length!==1)throw Error('Unexpected API request handler');
 server.removeAllListeners('request');
 server.on('request',(req,res)=>{
  let p;try{p=new URL(req.url,'http://localhost').pathname;}catch{res.writeHead(400);return res.end();}
  // Delegate these paths to the existing production hard-404 guard for all methods.
  if(p.startsWith('/api/admin/chinese-')||p==='/api/admin/import')return listeners[0].call(server,req,res);
  const allowedRead=['GET','HEAD','OPTIONS'].includes(req.method);
  const allowedWrite=req.method==='POST'&&(['/api/lab/login','/api/lab/logout','/api/lab/password','/api/subscriptions/unsubscribe'].includes(p)||allowAutoControl&&p==='/api/admin/ai-auto'||allowDiagnostic&&p.startsWith('/api/diagnostic/'));
  if(allowedRead||allowedWrite)return listeners[0].call(server,req,res);
  const origin=req.headers.origin;if(origin&&config.origins.includes(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Expose-Headers','X-Request-Id');}
  // Blocked writes never reach the main handler, so record them here.
  const request_id=requestIdFrom(req.headers['x-request-id']);res.setHeader('X-Request-Id',request_id);
  log('info','http.request',{request_id,method:req.method,route:routeTemplate(p),status:503,blocked:'staged-recovery'});
  res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify({error:'恢复验证期间此操作暂不可用'}));
 });
 return server;
}

export async function runEnglishMonitor(db,scanAll){
 // An unset checkpoint or a non-incremental unfinished window could restart
 // historical ingestion. Leave those journals for explicit operator review.
 const ids=db.prepare(`SELECT j.id FROM journals j LEFT JOIN scan_windows w ON w.journal_id=j.id
  WHERE j.market='international' AND j.enabled=1 AND COALESCE(j.checkpoint,'')<>''
    AND (w.journal_id IS NULL OR w.status='complete' OR w.mode='incremental') ORDER BY j.id`).all().map(r=>r.id);
 const results=[];
 for(const journalId of ids)results.push({journalId,result:await scanAll({journalId})});
 return results;
}

async function start(){
 if(process.env.NODE_ENV!=='production'||process.env.FANSCOPE_STAGED_RECOVERY!=='true')throw Error('Explicit production recovery mode required');
 if(config.adminKey.length<24)throw Error('ADMIN_KEY missing');
 if(config.dsKey||config.resendKey||process.env.OPENALEX_API_KEY)throw Error('Paid and mail credentials must remain empty');
 if(!fs.existsSync(config.dbPath)||fs.statSync(config.dbPath).size===0)throw Error('Existing database required');
 if(!Number.isFinite(config.intervalMinutes)||config.intervalMinutes<30)throw Error('Invalid monitoring interval');
 const {makeServer}=await import('./server.mjs');
 const {db}=await import('./db.mjs');
 const {scanAll}=await import('./monitor.mjs');
 const server=createStagedRecoveryServer(makeServer);
 let active=null,stopping=false;
 if(process.env.FANSCOPE_ENGLISH_MONITOR==='true'){
  // No startup scan; historical and paid queues are never recovered or scheduled.
  setInterval(()=>{
   if(active||stopping)return;
   active=runEnglishMonitor(db,scanAll).then(results=>log('info','ingest.monitor_cycle',{market:'international',journals:results.length,partial:results.filter(x=>x.result.status!=='ok').length}))
    .catch(e=>log('error','ingest.monitor_cycle_failed',errorFields(e))).finally(()=>{active=null;});
  },config.intervalMinutes*60000).unref();
 }
 server.listen(config.port,'0.0.0.0',()=>log('notice','service.start',{entry:'staged-recovery',englishMonitor:process.env.FANSCOPE_ENGLISH_MONITOR==='true',paid:false,mail:false,historyWorkers:false}));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;server.close(async()=>{if(active)await active;db.close();process.exit(0);});});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await start();
