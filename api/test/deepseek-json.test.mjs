import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-deepseek-'));
process.env.DATABASE_PATH=path.join(dir,'test.sqlite');
process.env.DEEPSEEK_API_KEY='mock-secret-do-not-log';
process.env.DEEPSEEK_MODEL='deepseek-flash';
process.env.AI_INPUT_CNY_PER_M_TOKENS='1';
process.env.AI_OUTPUT_CNY_PER_M_TOKENS='4';
const {db}=await import('../src/db.mjs');
const {analyzeAbstract,analyzePending,costEstimate}=await import('../src/ai.mjs');
const {createBatch,changeBatch,batchDetail,workBatchTick,recoverBatches}=await import('../src/analysis-batches.mjs');
const original=globalThis.fetch;
const abstract='A cohort of 500 persons was followed using survival analysis. This private abstract must never appear in error logs.';
const article={title:'Synthetic paper',abstract};
const payload={study_design:'cohort',sample_n:500,sample_unit:'person',statistical_methods:['survival','DID'],country:'Invented',evidence:{study_design:{quote:'A cohort of 500 persons',confidence:.9},sample_n:{quote:'500 persons was followed',confidence:.9},sample_unit:{quote:'500 persons was followed',confidence:.9},'method:survival':{quote:'using survival analysis',confidence:.9},'method:DID':{quote:'not in this abstract',confidence:1},country:{quote:'not in this abstract',confidence:1}}};
const reply=(content,finish_reason='stop',usage={prompt_tokens:100,completion_tokens:1800})=>new Response(JSON.stringify({choices:[{finish_reason,message:{content}}],usage}));
function insert(id){db.prepare("INSERT INTO articles(id,journal_id,market,title,abstract,publication_date,discovered_at,source) VALUES(?,'jmir','international',?,?,'2026-01-01',?,'manual')").run(id,article.title,abstract,new Date().toISOString());}
function mock(fn){let calls=0;globalThis.fetch=async(...args)=>{calls++;return fn(...args)};return ()=>calls;}
afterEach(()=>{globalThis.fetch=original;db.exec('DELETE FROM analysis_batch_items; DELETE FROM analysis_batches; DELETE FROM analysis_usage_log; DELETE FROM articles;');});
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});

test('request disables thinking, allows 4096 tokens and includes complete JSON example; evidence standards remain intact',async()=>{
 mock(async(url,opts)=>{
  assert.equal(url,'https://api.deepseek.com/chat/completions');
  const request=JSON.parse(opts.body);assert.equal(request.model,'deepseek-flash');assert.deepEqual(request.thinking,{type:'disabled'});assert.equal(request.max_tokens,4096);assert.deepEqual(request.response_format,{type:'json_object'});
  const example=request.messages[0].content.match(/abstract\): (\{.*?\})\./)[1];
  const parsed=JSON.parse(example);assert.equal(parsed.study_design,'unknown');assert.equal(parsed.sample_n,null);assert.deepEqual(parsed.evidence,{});
  return reply(JSON.stringify(payload));
 });
 const result=await analyzeAbstract(article);assert.equal(result.status,'analyzed');assert.equal(result.analysis.sample_n,500);assert.equal(result.analysis.study_design,'cohort');assert.deepEqual(result.analysis.statistical_methods,['survival']);assert.equal(result.analysis.country,null);assert.equal(result.analysis.extraction_scope,'abstract-only');
 assert.equal(costEstimate(null),.036384);
});

for(const [code,content,reason] of [
 ['length','{"summary_zh":"truncated','length'],
 ['length','{}','length'],
 ['empty_content','','stop'],
 ['empty_content','  \n','stop'],
 ['empty_content',null,'stop'],
 ['invalid_json','{"unfinished":','stop'],
 ['invalid_json','null','stop'],
 ['invalid_json','[]','stop'],
 ['invalid_json','42','stop'],
 ['unexpected_finish_reason','{}','content_filter']
])test(`${code}: rejects response, records usage and length, and never automatically repeats paid request (${JSON.stringify(content)})`,async()=>{
 insert('failed');const calls=mock(async()=>reply(content,reason));
 const result=await analyzePending(1,{articleId:'failed'});assert.equal(result.failed,1);assert.equal(result.analyzed,0);
 const a=db.prepare('SELECT * FROM articles WHERE id=?').get('failed');assert.equal(a.analysis_status,'failed');assert.equal(a.analysis_retry_at,null);assert.equal(a.analysis_json,null);assert.equal(a.analysis_attempts,1);
 const log=db.prepare('SELECT * FROM analysis_usage_log').get();assert.equal(log.error_code,code);assert.equal(log.finish_reason,reason);assert.equal(log.output_tokens,1800);assert.equal(log.response_length,content?.length||0);assert.equal(log.cost_cny,.0073);assert.equal(log.status,'completed');
 assert.ok(!JSON.stringify(log).includes(process.env.DEEPSEEK_API_KEY));assert.ok(!JSON.stringify(log).includes(abstract));
 await analyzePending(5,{policy:'custom'});assert.equal(calls(),1);assert.equal(db.prepare('SELECT COUNT(*) n FROM analysis_usage_log').get().n,1);
});

test('manual retry preserves successes, stays paused, and adds exactly one usage row for the actual retry',async()=>{
 insert('ok');insert('bad');let n=0;const calls=mock(async()=>reply(++n===1?'{}':'{broken','stop'));
 const batch=createBatch({policy:'custom',yearFrom:2026,yearTo:2026});changeBatch(batch.id,'start');await workBatchTick(5);
 assert.equal(calls(),2);assert.equal(batchDetail(batch.id).counts.completed,1);assert.equal(batchDetail(batch.id).counts.failed,1);
 const success=db.prepare("SELECT * FROM articles WHERE analysis_status='analyzed'").get();
 const paused=changeBatch(batch.id,'retry');assert.equal(paused.status,'paused');assert.equal(paused.counts.completed,1);assert.equal(paused.counts.queued,1);
 recoverBatches();await workBatchTick();assert.equal(calls(),2);assert.equal(batchDetail(batch.id).status,'paused');
 globalThis.fetch=async()=>{n++;return reply('{}')};changeBatch(batch.id,'start');await workBatchTick(5);assert.equal(n,3);
 assert.equal(batchDetail(batch.id).counts.completed,2);assert.equal(batchDetail(batch.id).usage.requests,3);assert.equal(batchDetail(batch.id).usage.outputTokens,5400);
 assert.deepEqual(db.prepare('SELECT * FROM articles WHERE id=?').get(success.id),success);
 const duplicate=createBatch({policy:'custom',yearFrom:2026,yearTo:2026});changeBatch(duplicate.id,'start');await workBatchTick(5);assert.equal(n,3);assert.equal(batchDetail(duplicate.id).counts.cached,2);
});

test('HTTP 503 retries with backoff and stops after five actual requests',async()=>{
 insert('transient');const calls=mock(async()=>new Response('do not log this provider body',{status:503}));
 const batch=createBatch({policy:'custom',yearFrom:2026,yearTo:2026});changeBatch(batch.id,'start');
 for(let attempt=1;attempt<=5;attempt++){
  await workBatchTick();assert.equal(calls(),attempt);
  await workBatchTick();assert.equal(calls(),attempt);
  db.prepare("UPDATE articles SET analysis_retry_at='2000-01-01' WHERE id='transient'").run();
  db.prepare("UPDATE analysis_batch_items SET next_attempt_at='2000-01-01' WHERE batch_id=?").run(batch.id);
 }
 assert.equal(db.prepare("SELECT analysis_status FROM articles WHERE id='transient'").get().analysis_status,'failed');assert.equal(batchDetail(batch.id).counts.failed,1);
 await workBatchTick();assert.equal(calls(),5);assert.equal(batchDetail(batch.id).usage.requests,5);
});

test('invalid HTTP request is terminal and provider body is not logged',async()=>{
 insert('bad-request');const calls=mock(async()=>new Response(process.env.DEEPSEEK_API_KEY+abstract,{status:400}));
 await analyzePending(1,{articleId:'bad-request'});await analyzePending(1,{articleId:'bad-request'});assert.equal(calls(),1);
 const log=db.prepare('SELECT * FROM analysis_usage_log').get();assert.equal(log.error,'DeepSeek http_400');assert.equal(log.error_code,'http_400');
});

test('ambiguous network failure and crash reservation cannot be billed again automatically, including duplicate batches',async()=>{
 insert('uncertain');const calls=mock(async()=>{throw Error(process.env.DEEPSEEK_API_KEY+abstract)});
 const batch=createBatch({policy:'custom',yearFrom:2026,yearTo:2026});changeBatch(batch.id,'start');await workBatchTick();assert.equal(calls(),1);
 const log=db.prepare('SELECT * FROM analysis_usage_log').get();assert.equal(log.error,'DeepSeek request_uncertain');assert.equal(log.status,'uncertain');assert.equal(log.cost_cny,.036384);
 // Simulate a process dying after reserving a request but before committing its result.
 db.prepare("UPDATE articles SET analysis_status='analyzing' WHERE id='uncertain'").run();
 db.prepare("UPDATE analysis_batch_items SET status='running' WHERE batch_id=?").run(batch.id);
 recoverBatches();assert.equal(db.prepare("SELECT analysis_status FROM articles WHERE id='uncertain'").get().analysis_status,'failed');
 const duplicate=createBatch({policy:'custom',yearFrom:2026,yearTo:2026});changeBatch(duplicate.id,'start');await workBatchTick();assert.equal(calls(),1);assert.equal(batchDetail(duplicate.id).counts.failed,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM analysis_usage_log').get().n,1);
});

test('concurrent workers cannot reserve or request the same article twice',async()=>{
 insert('concurrent');let release;const ready=new Promise(r=>{release=r});const calls=mock(async()=>{await ready;return reply('{}')});
 const first=analyzePending(1,{articleId:'concurrent'});assert.equal((await analyzePending(1,{articleId:'concurrent'})).status,'busy');
 const independent=await import('../src/ai.mjs?independent-worker');assert.equal((await independent.analyzePending(1,{articleId:'concurrent'})).attempts,0);
 assert.equal(db.prepare("SELECT analysis_status FROM articles WHERE id='concurrent'").get().analysis_status,'analyzing');
 release();await first;assert.equal(calls(),1);assert.equal(db.prepare('SELECT COUNT(*) n FROM analysis_usage_log').get().n,1);
});


test('partial usage preserves known output tokens and unknown finish reasons never leak provider strings',async()=>{
 insert('partial');mock(async()=>reply('{}',process.env.DEEPSEEK_API_KEY+abstract,{completion_tokens:4096}));
 await analyzePending(1,{articleId:'partial'});
 const log=db.prepare('SELECT * FROM analysis_usage_log').get();assert.equal(log.output_tokens,4096);assert.equal(log.input_tokens,0);assert.equal(log.status,'uncertain');assert.equal(log.finish_reason,'other');assert.equal(log.error_code,'unexpected_finish_reason');assert.ok(!JSON.stringify(log).includes(abstract));assert.ok(!JSON.stringify(log).includes(process.env.DEEPSEEK_API_KEY));
});


test('recovery annotates only the latest reserved request and preserves historical accounting',()=>{
 insert('crash');
 const stmt=db.prepare("INSERT INTO analysis_usage_log(article_id,model,input_tokens,output_tokens,cost_cny,created_at,status) VALUES('crash','deepseek-flash',100,100,.0005,?,'completed')");
 const past=stmt.run(new Date().toISOString()).lastInsertRowid;
 const latest=stmt.run(new Date().toISOString()).lastInsertRowid;
 db.prepare("UPDATE articles SET analysis_status='analyzing' WHERE id='crash'").run();
 recoverBatches();
 assert.equal(db.prepare('SELECT error_code FROM analysis_usage_log WHERE id=?').get(past).error_code,null);
 assert.equal(db.prepare('SELECT error_code FROM analysis_usage_log WHERE id=?').get(latest).error_code,'request_uncertain');
 assert.equal(db.prepare('SELECT SUM(cost_cny) cost FROM analysis_usage_log').get().cost,.001);
});
