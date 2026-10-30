// V1.4: English metadata monitoring + explicitly enabled continuous English AI.
// Never recover legacy batches, historical ingestion, document AI or email workers.
import fs from 'node:fs';
import {log,errorFields} from './platform/log.mjs';
if(process.env.NODE_ENV!=='production'||process.env.FANSCOPE_V14_RUNTIME!=='true')throw Error('Explicit V1.4 production runtime required');
const aiEnabled=process.env.FANSCOPE_AI_AUTO_ENABLED==='true';
if(!aiEnabled)process.env.DEEPSEEK_API_KEY='';
process.env.RESEND_API_KEY='';process.env.OPENALEX_API_KEY='';
const {config}=await import('./config.mjs');
if(config.adminKey.length<24||!fs.existsSync(config.dbPath)||!fs.statSync(config.dbPath).size)throw Error('Existing database and administrator configuration required');
if(aiEnabled&&!config.dsKey)throw Error('AI enabled but DeepSeek key is missing');
if(config.resendKey||process.env.OPENALEX_API_KEY)throw Error('Email and OpenAlex must stay disabled');
if(!Number.isFinite(config.intervalMinutes)||config.intervalMinutes<30)throw Error('Invalid monitoring interval');
const {makeServer}=await import('./server.mjs');const {db}=await import('./db.mjs');
const {createStagedRecoveryServer,runEnglishMonitor}=await import('./staged-recovery-server.mjs');
const {scanAll}=await import('./monitor.mjs');const {automaticTick}=await import('./automatic-ai.mjs');
const {diagnosticStatus,startPurgeTimer}=await import('./diagnostic/service.mjs');
const server=createStagedRecoveryServer(makeServer,{allowAutoControl:true,allowDiagnostic:diagnosticStatus().enabled});
let stopping=false,monitor=null,ai=null;const timers=[];
if(process.env.FANSCOPE_ENGLISH_MONITOR==='true')timers.push(setInterval(()=>{if(!stopping&&!monitor)monitor=runEnglishMonitor(db,scanAll).then(r=>log('info','ingest.monitor_cycle',{market:'international',journals:r.length,partial:r.filter(x=>x.result.status!=='ok').length})).catch(e=>log('error','ingest.monitor_cycle_failed',errorFields(e))).finally(()=>{monitor=null;});},config.intervalMinutes*60000));
if(aiEnabled){
 const seconds=Number(process.env.AI_AUTO_INTERVAL_SECONDS||15);if(!Number.isFinite(seconds)||seconds<5||seconds>3600)throw Error('AI interval must be 5–3600 seconds');
 timers.push(setInterval(()=>{if(!stopping&&!ai)ai=automaticTick().catch(e=>log('error','ai.auto_tick_failed',errorFields(e))).finally(()=>{ai=null;});},seconds*1000));
}
{const purge=startPurgeTimer();if(purge)timers.push(purge);}
for(const timer of timers)timer.unref();
server.listen(config.port,'0.0.0.0',()=>log('notice','service.start',{entry:'v14',version:'1.4',aiEnabled,mail:false,legacyWorkers:false,englishMonitor:process.env.FANSCOPE_ENGLISH_MONITOR==='true',intervalMinutes:config.intervalMinutes,node:process.versions.node}));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{log('notice','service.stopping',{signal,inFlight:{ai:!!ai,monitor:!!monitor}});stopping=true;for(const timer of timers)clearInterval(timer);server.close(async()=>{await Promise.allSettled([ai,monitor].filter(Boolean));db.close();process.exit(0);});});
