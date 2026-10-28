import test,{after,afterEach} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-auto-v14-'));
Object.assign(process.env,{DATABASE_PATH:path.join(dir,'test.sqlite'),NODE_ENV:'test',FANSCOPE_AI_AUTO_ENABLED:'true',DEEPSEEK_API_KEY:'synthetic-key',RESEND_API_KEY:'',ADMIN_KEY:'synthetic-admin-secret-long-enough',AI_INPUT_CNY_PER_M_TOKENS:'',AI_OUTPUT_CNY_PER_M_TOKENS:''});
const {db}=await import('../src/db.mjs');const {automaticTick,automaticStatus,changeAutomatic,automaticBatchId}=await import('../src/automatic-ai.mjs');
const {makeServer}=await import('../src/server.mjs');const {createStagedRecoveryServer}=await import('../src/staged-recovery-server.mjs');
const originalFetch=globalThis.fetch;const abstract='A cohort of 500 persons was followed using survival analysis. '+('The synthetic participants completed a longitudinal survey about health and caregiving. ').repeat(4);
const content={study_design:'cohort',statistical_methods:['survival'],sample_n:500,sample_unit:'person',evidence:{study_design:{quote:'A cohort of 500 persons',confidence:.9},sample_n:{quote:'500 persons was followed',confidence:.9},sample_unit:{quote:'500 persons was followed',confidence:.9},'method:survival':{quote:'using survival analysis',confidence:.9}}};
const reply=()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:100,completion_tokens:80}}));
function add(id,days=1,changes={}){const date=new Date(Date.now()-days*86400000).toISOString().slice(0,10);const row={id,journal_id:'jmir',market:'international',title:'Synthetic '+id,abstract,publication_date:date,date_precision:'day',discovered_at:new Date().toISOString(),source:'crossref',source_verification_status:'verified',source_evidence_json:'{"synthetic":true}',abstract_status:'available',doi:'10.9999/'+id,url:'https://doi.org/10.9999/'+id,...changes};const keys=Object.keys(row);db.prepare('INSERT INTO articles('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...Object.values(row));}
function mock(fn=reply){let calls=0,titles=[];globalThis.fetch=async(url,opts)=>{assert.equal(url,'https://api.deepseek.com/chat/completions');calls++;titles.push(JSON.parse(opts.body).messages[1].content.match(/^Title: (.*)/)[1]);return fn();};return {calls:()=>calls,titles};}
function clearDelay(){const r=db.prepare("SELECT value FROM meta WHERE key='ai-auto:v14:control'").get();const c=JSON.parse(r.value);c.nextAllowedAt=null;db.prepare("UPDATE meta SET value=? WHERE key='ai-auto:v14:control'").run(JSON.stringify(c));}
afterEach(()=>{globalThis.fetch=originalFetch;db.exec("DELETE FROM analysis_batch_items;DELETE FROM analysis_batches;DELETE FROM analysis_usage_log;DELETE FROM articles;DELETE FROM meta WHERE key LIKE 'ai-auto:v14:%';");});
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});

test('recent verified English papers first; preserve old results, Chinese and legacy batches; no abstract means no request',async()=>{
 add('recent',1);add('less-recent',90);add('history',400);add('short',2,{abstract:'too short',abstract_status:'missing'});add('unverified',1,{source_verification_status:'unverified'});add('chinese',1,{market:'chinese',journal_id:'candidate-1'});
 add('complete',1,{analysis_status:'analyzed',analysis_json:'{"preserve":"original"}',ai_summary:'Original result'});const before=db.prepare("SELECT * FROM articles WHERE id='complete'").get();
 add('old-queue',1);db.prepare("INSERT INTO analysis_batches(id,created_at,status,filter_json,total) VALUES('legacy','2026-01-01','running','{}',1)").run();db.prepare("INSERT INTO analysis_batch_items(batch_id,article_id,status,updated_at) VALUES('legacy','old-queue','queued','2026-01-01')").run();
 const m=mock();assert.equal((await automaticTick()).status,'paused');assert.equal(m.calls(),0);changeAutomatic('resume');for(let n=0;n<3;n++)await automaticTick();
 assert.deepEqual(m.titles,['Synthetic recent','Synthetic less-recent','Synthetic history']);assert.deepEqual(db.prepare("SELECT * FROM articles WHERE id='complete'").get(),before);assert.equal(db.prepare("SELECT status FROM analysis_batches WHERE id='legacy'").get().status,'running');assert.equal(automaticStatus().counts.completed,3);
});
for(const code of [401,402,403])test('HTTP '+code+' stops new claims and retains queued work',async()=>{
 add('one',1);add('two',2);const m=mock(()=>new Response('synthetic',{status:code}));changeAutomatic('resume');await automaticTick();assert.equal(automaticStatus().state,'blocked');assert.equal(automaticStatus().reason,'http_'+code);await automaticTick();assert.equal(m.calls(),1);assert.equal(automaticStatus().counts.queued,2);
 mock();changeAutomatic('resume');await automaticTick();assert.equal(automaticStatus().counts.completed,1);
});
test('persistent 429 pauses the whole worker with backoff and no unbounded retry',async()=>{
 for(let i=0;i<4;i++)add('rate-'+i,i+1);const m=mock(()=>new Response('synthetic',{status:429}));changeAutomatic('resume');await automaticTick();await automaticTick();assert.equal(m.calls(),1);
 clearDelay();await automaticTick();clearDelay();await automaticTick();assert.equal(m.calls(),3);assert.equal(automaticStatus().state,'blocked');assert.equal(automaticStatus().reason,'persistent_rate_limit');await automaticTick();assert.equal(m.calls(),3);
});
test('persistent server errors stop claims, retries remain finite per article',async()=>{
 for(let i=0;i<4;i++)add('server-'+i,i+1);const m=mock(()=>new Response('synthetic',{status:503}));changeAutomatic('resume');for(let i=0;i<3;i++)await automaticTick();assert.equal(m.calls(),3);assert.equal(automaticStatus().state,'blocked');await automaticTick();assert.equal(m.calls(),3);
});
test('unknown network result is terminal until review and is not automatically billed again',async()=>{
 add('uncertain');const m=mock(()=>{throw Error('synthetic timeout')});changeAutomatic('resume');await automaticTick();assert.equal(automaticStatus().reason,'request_uncertain');assert.equal(automaticStatus().state,'blocked');changeAutomatic('resume');await automaticTick();assert.equal(m.calls(),1);assert.equal(automaticStatus().counts.failed,1);
});
test('database lease prevents another process taking the same work; pause/stop preserve an in-flight result',async()=>{
 add('one',1);add('two',2);let release;const pending=new Promise(r=>{release=r});const m=mock(async()=>{await pending;return reply()});changeAutomatic('resume');const first=automaticTick();assert.equal(m.calls(),1);
 const child=execFileSync(process.execPath,['--experimental-sqlite','--input-type=module','-e',"globalThis.fetch=()=>{throw Error('must not call provider')};const a=await import('./src/automatic-ai.mjs');console.log(JSON.stringify(await a.automaticTick()));const{db}=await import('./src/db.mjs');db.close();"],{cwd:path.resolve(import.meta.dirname,'..'),env:process.env,encoding:'utf8'});assert.equal(JSON.parse(child).status,'busy');
 changeAutomatic('pause');release();await first;assert.equal(automaticStatus().state,'paused');assert.equal(automaticStatus().counts.completed,1);await automaticTick();assert.equal(m.calls(),1);changeAutomatic('stop');assert.equal((await automaticTick()).status,'stopped');
});
test('restart quarantines only interrupted automatic work, never legacy running work',async()=>{
 add('crashed');changeAutomatic('resume');db.prepare("INSERT INTO analysis_batch_items(batch_id,article_id,status,updated_at) VALUES(?,?,'running',?)").run(automaticBatchId,'crashed',new Date().toISOString());db.prepare("UPDATE articles SET analysis_status='analyzing' WHERE id='crashed'").run();db.prepare("INSERT INTO analysis_usage_log(article_id,batch_id,model,input_tokens,output_tokens,created_at,status) VALUES('crashed',?,'synthetic',0,0,?,'uncertain')").run(automaticBatchId,new Date().toISOString());
 db.prepare("INSERT INTO meta(key,value) VALUES('ai-auto:v14:lease',?)").run(JSON.stringify({owner:'dead',expiresAt:0}));const m=mock();await automaticTick();assert.equal(m.calls(),0);assert.equal(automaticStatus().state,'blocked');assert.equal(automaticStatus().counts.failed,1);assert.equal(db.prepare("SELECT analysis_error FROM articles WHERE id='crashed'").get().analysis_error,'DeepSeek request_uncertain');
});
test('restart before HTTP claim safely resumes; completed result bookkeeping is recovered without resubmit',async()=>{
 add('before-http');changeAutomatic('resume');db.prepare("INSERT INTO analysis_batch_items(batch_id,article_id,status,updated_at) VALUES(?,'before-http','running',?)").run(automaticBatchId,new Date().toISOString());const m=mock();await automaticTick();assert.equal(m.calls(),1);db.prepare("UPDATE analysis_batch_items SET status='running' WHERE batch_id=?").run(automaticBatchId);await automaticTick();assert.equal(m.calls(),1);assert.equal(automaticStatus().counts.completed,1);
});
test('discovery pages do not impose a cumulative paper cap',async()=>{
 db.exec('BEGIN');for(let i=0;i<550;i++)add('many-'+i,1);db.exec('COMMIT');const m=mock();changeAutomatic('resume');await automaticTick();await automaticTick();assert.equal(automaticStatus().total,550);assert.equal(m.calls(),2);assert.equal(automaticStatus().budgetEnforced,false);
});
test('protected control API and public progress reflect new AI JSON and statistics',async()=>{
 add('http');const server=createStagedRecoveryServer(makeServer,{allowAutoControl:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await originalFetch(base+'/api/admin/ai-auto',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"resume"}'})).status,401);
  const r=await originalFetch(base+'/api/admin/ai-auto',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':process.env.ADMIN_KEY},body:'{"action":"resume"}'});assert.equal(r.status,200);const m=mock();await automaticTick();assert.equal(m.calls(),1);
  const status=await(await originalFetch(base+'/api/ai-auto-status')).json();assert.equal(status.counts.completed,1);assert.ok(!JSON.stringify(status).includes(process.env.DEEPSEEK_API_KEY));
  const stats=await(await originalFetch(base+'/api/stats?market=international&period=all&article_type=all')).json();assert.equal(stats.analyzed,1);const a=db.prepare("SELECT analysis_json FROM articles WHERE id='http'").get();assert.equal(JSON.parse(a.analysis_json).sample_n,500);
 }finally{await new Promise(r=>server.close(r));}
});
