import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-release-'));
process.env.DATABASE_PATH=path.join(dir,'qa.sqlite');process.env.SCAN_ON_START='false';process.env.AUTO_AI_ANALYSIS='false';
process.env.DEEPSEEK_API_KEY='mock-only';process.env.MAX_AI_DAILY='1000';
process.env.AI_INPUT_CNY_PER_M_TOKENS='1';process.env.AI_OUTPUT_CNY_PER_M_TOKENS='4';
process.env.ADMIN_KEY='qa-only-admin-key-12345678901234567890';
const {db}=await import('../src/db.mjs');const {config}=await import('../src/config.mjs');
const {insertArticle,scanAll}=await import('../src/monitor.mjs');
const {createBatch,changeBatch,batchDetail,workBatchTick,recoverBatches}=await import('../src/analysis-batches.mjs');
const {analysisFingerprint,costEstimate}=await import('../src/ai.mjs');
const {probeJournalSource,parseJournalCandidates}=await import('../src/journal-onboarding.mjs');
const {createBackfill,changeBackfill,workBackfillTick,getBackfill}=await import('../src/journal-backfill.mjs');
const {makeServer}=await import('../src/server.mjs');
const {crossrefPages}=await import('../src/sources.mjs');
const original=globalThis.fetch;let calls=0;
const abstract='A cohort of 500 persons was followed using survival analysis. This synthetic abstract supports regression testing only.';
const reply=(content='{}',usage={prompt_tokens:900,completion_tokens:220})=>new Response(JSON.stringify({choices:[{message:{content}}],usage}));
const paper=(n,year=2025)=>({id:`qa-${n}`,journal_id:'jmir',market:'international',title:`QA article ${n}`,abstract,publication_date:`${year}-06-01`});
function mock(fn=async()=>reply()){calls=0;globalThis.fetch=async(...args)=>{assert.equal(String(args[0]),'https://api.deepseek.com/chat/completions');calls++;return fn(...args)}}
function cancelActive(){for(const b of db.prepare("SELECT id FROM analysis_batches WHERE status IN ('running','paused')").all())changeBatch(b.id,'cancel')}
after(()=>{globalThis.fetch=original;db.close();fs.rmSync(dir,{recursive:true,force:true})});

test('100-paper batch: pause, resume, usage, concurrent duplicate batch cache and changed abstract',async()=>{
 for(let i=0;i<100;i++)insertArticle(paper(i));
 const opts={policy:'custom',yearFrom:2025,yearTo:2025,limit:100,costLimitCny:10};
 const b=createBatch(opts),duplicate=createBatch(opts);assert.equal(b.status,'paused');assert.equal(b.total,100);
 mock();assert.equal((await workBatchTick()).status,'idle');assert.equal(calls,0);
 changeBatch(b.id,'start');await workBatchTick(5);assert.equal(calls,5);
 changeBatch(b.id,'pause');await workBatchTick();assert.equal(calls,5);
 changeBatch(b.id,'start');for(let i=0;i<19;i++)await workBatchTick(5);
 assert.equal(batchDetail(b.id).status,'completed');assert.equal(calls,100);
 assert.equal(batchDetail(b.id).usage.inputTokens,90000);assert.equal(batchDetail(b.id).usage.outputTokens,22000);
 assert.ok(Math.abs(batchDetail(b.id).usage.estimatedCostCny-0.178)<1e-9);
 changeBatch(duplicate.id,'start');for(let i=0;i<20;i++)await workBatchTick(5);assert.equal(calls,100);assert.equal(batchDetail(duplicate.id).counts.cached,100);
 db.prepare("UPDATE articles SET abstract=abstract||' Changed evidence.' WHERE id='qa-0'").run();
 const changed=createBatch(opts);assert.equal(changed.counts.queued,1);assert.equal(changed.counts.cached,99);
 changeBatch(changed.id,'start');await workBatchTick(5);assert.equal(calls,101);
 const a=db.prepare("SELECT * FROM articles WHERE id='qa-0'").get();assert.equal(a.analysis_input_hash,analysisFingerprint(a));
});
test('network failures preserve uncertain usage and require manual retry across restart',async()=>{
 insertArticle(paper('network',2026));const b=createBatch({policy:'custom',yearFrom:2026,yearTo:2026,costLimitCny:0.03});
 mock(async()=>{throw Error('simulated disconnected response')});changeBatch(b.id,'start');await workBatchTick();assert.equal(calls,1);
 assert.equal(batchDetail(b.id).usage.estimatedCostCny,0.036384);
 assert.equal(db.prepare('SELECT status FROM analysis_usage_log WHERE batch_id=?').get(b.id).status,'uncertain');
 recoverBatches();
 await workBatchTick();assert.equal(calls,1);assert.equal(batchDetail(b.id).status,'completed');assert.equal(batchDetail(b.id).counts.failed,1);cancelActive();
});
test('invalid AI JSON still records returned token costs; explicit failure retry is paused',async()=>{
 insertArticle(paper('invalid',2026));db.prepare("UPDATE articles SET analysis_attempts=4,journal_id='ssm' WHERE id='qa-invalid'").run();
 const b=createBatch({policy:'custom',yearFrom:2026,yearTo:2026,journalId:'ssm',costLimitCny:2});mock(async()=>reply('broken-json'));changeBatch(b.id,'start');await workBatchTick(5);
 assert.ok(batchDetail(b.id).usage.requests>=1);assert.ok(batchDetail(b.id).usage.estimatedCostCny>0);
 assert.ok(batchDetail(b.id).counts.failed>=1);if(batchDetail(b.id).status==='running')changeBatch(b.id,'pause');const retried=changeBatch(b.id,'retry');assert.equal(retried.status,'paused');
 mock();changeBatch(b.id,'start');for(let i=0;i<3;i++)await workBatchTick(5);assert.equal(batchDetail(b.id).status,'completed');
 assert.equal(db.prepare("SELECT analysis_status FROM articles WHERE id='qa-invalid'").get().analysis_status,'analyzed');cancelActive();
});
test('explicitly started work ignores daily counters, previous batch caps and missing price estimates',async()=>{
 insertArticle({...paper('pricing',2026),journal_id:'candidate-29'});
 const day=new Date().toISOString().slice(0,10);
 db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('ai-budget:'+day,'99999');
 const opts={policy:'custom',yearFrom:2026,yearTo:2026,journalId:'candidate-29',costLimitCny:0.00001};
 const b=createBatch(opts);
 db.prepare('UPDATE analysis_batches SET estimated_cost_limit_cny=0.00001 WHERE id=?').run(b.id);
 const rate=process.env.AI_INPUT_CNY_PER_M_TOKENS;
 delete process.env.AI_INPUT_CNY_PER_M_TOKENS;
 try{
  mock();changeBatch(b.id,'start');await workBatchTick();
  assert.equal(calls,1);assert.equal(batchDetail(b.id).status,'completed');
  assert.equal(batchDetail(b.id).usage.requests,1);
  assert.equal(costEstimate(null),null);
 }finally{process.env.AI_INPUT_CNY_PER_M_TOKENS=rate}
 assert.equal(costEstimate({prompt_tokens:-1,completion_tokens:1}),0.036384);
 assert.equal(costEstimate(null),0.036384);cancelActive();
});
test('cancelled work never invokes AI; interrupted successful work recovers using cache',async()=>{
 const b=createBatch({policy:'custom',yearFrom:2026,yearTo:2026,costLimitCny:1});changeBatch(b.id,'start');changeBatch(b.id,'cancel');mock();await workBatchTick();assert.equal(calls,0);
 const b2=createBatch({policy:'custom',yearFrom:2026,yearTo:2026,journalId:'candidate-29',costLimitCny:1});db.prepare("UPDATE analysis_batch_items SET status='running' WHERE batch_id=?").run(b2.id);recoverBatches();changeBatch(b2.id,'start');await workBatchTick(5);assert.equal(calls,0);cancelActive();
});
const row=(doi='10.1234/valid',title='Health &amp; Place',issn='1353-8292')=>({DOI:doi,ISSN:[issn],type:'journal-article',title:['QA evidence'],publisher:'Elsevier BV','container-title':[title]});
test('source verification handles real HTML entities, publisher and duplicate DOI evidence',async()=>{
 const req=async()=>({message:{items:[row(),row(),row('10.1234/second')]}});
 const r=await probeJournalSource({id:'candidate-29',issn:'1353-8292'},req);assert.equal(r.verified,true);assert.equal(r.sample.length,2);assert.equal(r.sample[0].publisher,'Elsevier BV');assert.equal(r.enabled,false);
 assert.equal(parseJournalCandidates(await req(),'Health & Place')[0].evidenceCount,2);
});
test('wrong ISSN checksum, malformed DOI, foreign journal and upstream failures never enable a journal',async()=>{
 await assert.rejects(probeJournalSource({id:'candidate-29',issn:'1353-8293'},async()=>({})),/ISSN/);
 for(const record of [row('10.1234/has whitespace'),row('10.1234/'),row('10.1234/a','Other Journal'),row('10.1234/a','Health & Place','1471-2318')]){
  await assert.rejects(probeJournalSource({id:'candidate-29',issn:'1353-8292',enable:true,confirm:true},async()=>({message:{items:[record]}})),/identity/);
 }
 for(const message of ['HTTP 429','timeout','offline'])await assert.rejects(probeJournalSource({id:'candidate-29',issn:'1353-8292',enable:true,confirm:true},async()=>{throw Error(message)}),new RegExp(message));
 await assert.rejects(probeJournalSource({id:'candidate-29',issn:'1353-8292'},async()=>({message:{}})),/malformed/);
 assert.equal(db.prepare("SELECT enabled FROM journals WHERE id='candidate-29'").get().enabled,0);
});
test('backfill pause/cancel during HTTP stops at a committed page and never overwrites cancellation',async()=>{
 for(const action of ['pause','cancel']){
  const year=action==='pause'?2025:2026;const b=createBackfill({journalId:'ageing-society',yearFrom:year,yearTo:year});changeBackfill(b.id,'start');let requested=0;
  await workBackfillTick({maxPages:4,request:async()=>{requested++;changeBackfill(b.id,action);return {message:{'total-results':2,'next-cursor':'next',items:[{...row(`10.1234/${action}`,'Ageing & Society','1469-1779'),published:{'date-parts':[[year,1,1]]}}]}}}});
  const saved=getBackfill(b.id);assert.equal(requested,1);assert.equal(saved.status,action==='pause'?'paused':'cancelled');assert.equal(saved.cursor,'next');assert.equal(saved.pages_done,1);
  assert.equal(db.prepare('SELECT notification_eligible FROM articles WHERE doi=?').get(`10.1234/${action}`).notification_eligible,0);
 }
});
test('backfill excludes another journal and does not alter daily checkpoints or call DeepSeek',async()=>{
 db.prepare("UPDATE journal_backfill_jobs SET status='cancelled' WHERE status='paused'").run();
 const before=db.prepare("SELECT checkpoint FROM journals WHERE id='jmir'").get();const b=createBackfill({journalId:'jmir',yearFrom:2025,yearTo:2026});changeBackfill(b.id,'start');mock();
 await workBackfillTick({maxPages:1,request:async()=>({message:{'total-results':1,items:[row('10.1234/wrong-journal')]}})});
 assert.equal(db.prepare("SELECT COUNT(*) n FROM articles WHERE doi='10.1234/wrong-journal'").get().n,0);assert.deepEqual(db.prepare("SELECT checkpoint FROM journals WHERE id='jmir'").get(),before);assert.equal(calls,0);changeBackfill(b.id,'cancel');
});
test('all administrator route families reject missing/wrong credentials; legacy manual imports cannot bypass staging',async()=>{
 globalThis.fetch=original;const s=makeServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${s.address().port}`;
 const post=(route,payload, key)=>fetch(base+'/api/admin/'+route,{method:'POST',headers:{'Content-Type':'application/json',...(key?{'X-Admin-Key':key}:{})},body:JSON.stringify(payload)});
 try{
  for(const route of ['journal-source/discover','journal-discoveries','journal-discoveries/start-all','journal-source/test','journal-source/activate','journal-backfills','analysis-batches','journal-review','research-brief','enrich-openalex','analyze','scan','import','digest'])for(const key of [undefined,'wrong','é'.repeat(config.adminKey.length)])assert.equal((await post(route,{},key)).status,401,route);
  const item={journal_id:'candidate-1',title:'<img src=x onerror=alert(1)> 中文测试',url:'https://example.org/qa',abstract:"'; DROP TABLE articles; --",doi:'10.9999/csv-qa',publication_date:'2025-06-01'};
  const payload={items:[item,{...item,url:'javascript:alert(1)',doi:''},{...item,journal_id:'jmir'},{...item,doi:'invalid'},{...item,publication_date:'2025-02-30'}]};
  for(const route of ['import','chinese-import']){
   assert.equal((await post(route,payload,config.adminKey)).status,409);
   assert.equal((await post(route,{items:Array(51).fill(item)},config.adminKey)).status,409);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM articles WHERE doi='10.9999/csv-qa'").get().n,0);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 }finally{await new Promise(r=>s.close(r))}
});

test('malformed pagination never advances processed count across repeated retries',async()=>{
 const journal=db.prepare("SELECT * FROM journals WHERE id='jmir'").get();let state;
 const request=async()=>({message:{'total-results':3,items:[{DOI:'10.9999/replay',type:'journal-article',title:['QA replay']}]}});
 for(let i=0;i<4;i++){
  await assert.rejects(async()=>{for await(const page of crossrefPages(journal,{initial:true,lookbackDays:1,state,request,onState:x=>state=x})){}},/cursor/);
  assert.equal(state.processed,0);assert.equal(state.cursor,'*');assert.equal(state.status,'failed');
 }
});

test('monitoring with AUTO_AI_ANALYSIS=false and a configured mock key never calls AI',async()=>{
 const urls=[];globalThis.fetch=async url=>{urls.push(String(url));assert.match(String(url),/^https:\/\/api\.crossref\.org\//);return new Response(JSON.stringify({message:{items:[],'total-results':0}}))};
 const result=await scanAll({journalId:'jmir',lookbackDays:1});assert.equal(result.status,'ok');assert.ok(urls.length>0);assert.equal(result.ai.status,'independent_queue');
});

test('entire 2025–2026-to-date range completes through every fixed window with DOI deduplication and no AI or notifications',async()=>{
 const journal=db.prepare("SELECT * FROM journals WHERE id='jmir'").get();
 const checkpoint=journal.checkpoint,usage=db.prepare('SELECT COUNT(*) n FROM analysis_usage_log').get().n;
 const b=createBackfill({journalId:'jmir',yearFrom:2025,yearTo:2026});assert.equal(b.status,'paused');changeBackfill(b.id,'start');mock();
 let windows=0,lastEnd='',complete=false;
 const request=async url=>{const f=new URL(url).searchParams.get('filter'),start=/from-pub-date:([^,]+)/.exec(f)[1],end=/until-pub-date:([^,]+)/.exec(f)[1];if(lastEnd)assert.equal(start,lastEnd);lastEnd=end;windows++;
  const record=doi=>({DOI:doi,type:'journal-article',ISSN:[journal.issn],'container-title':[journal.title],title:['Synthetic full-range backfill'],abstract,published:{'date-parts':[start.slice(0,10).split('-').map(Number)]}});
  return {message:{'total-results':3,items:[record('10.9999/full-'+start.slice(0,10)),record('10.9999/full-'+start.slice(0,10)),record('10.9999/full-shared')]}};
 };
 for(let i=0;i<200;i++){if((await workBackfillTick({maxPages:1,request})).status==='completed'){complete=true;break}}
 const done=getBackfill(b.id);assert.ok(complete);assert.equal(lastEnd,done.to_date.slice(0,19));assert.equal(done.pages_done,windows);assert.equal(done.added_articles,windows+1);assert.equal(calls,0);
 assert.equal(db.prepare("SELECT checkpoint FROM journals WHERE id='jmir'").get().checkpoint,checkpoint);assert.equal(db.prepare('SELECT COUNT(*) n FROM analysis_usage_log').get().n,usage);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM articles WHERE doi LIKE '10.9999/full-%' AND notification_eligible=1").get().n,0);
});
