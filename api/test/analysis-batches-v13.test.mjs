import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
process.env.DATABASE_PATH=path.join(os.tmpdir(),`fanscope-v13-batches-${process.pid}.sqlite`);
process.env.DEEPSEEK_API_KEY='mock-secret-not-real';
process.env.MAX_AI_DAILY='40';
process.env.AI_INPUT_CNY_PER_M_TOKENS='1.00';
process.env.AI_OUTPUT_CNY_PER_M_TOKENS='4.00';
process.env.SCAN_ON_START='false';
const {db}=await import('../src/db.mjs');
const {insertArticle}=await import('../src/monitor.mjs');
const {createBatch,batchDetail,changeBatch,workBatchTick,recoverBatches,coverage}=await import('../src/analysis-batches.mjs');
const {analysisFingerprint}=await import('../src/ai.mjs');
after(()=>{db.close();for(const ext of ['','-wal','-shm'])fs.rmSync(process.env.DATABASE_PATH+ext,{force:true});});
const abstract='An extensive cohort analysis of 500 persons was followed using survival analysis. The study includes clear measurements.';
const fake=()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
 study_design:'cohort',statistical_methods:['survival'],data_source_type:'unknown',sample_n:500,sample_unit:'person',
 evidence:{study_design:{quote:'cohort analysis of 500 persons',confidence:0.93},'method:survival':{quote:'using survival analysis',confidence:0.94},sample_n:{quote:'500 persons was followed',confidence:0.92},sample_unit:{quote:'500 persons was followed',confidence:0.92}}
})}}],usage:{prompt_tokens:900,completion_tokens:220,total_tokens:1120}}));

test('batch is initially paused; caches old analyses; persists token usage and avoids second call',async()=>{
 insertArticle({id:'v13-1',journal_id:'jmir',market:'international',title:'Sample',abstract,publication_date:'2025-06-01',topics:['aging']});
 insertArticle({id:'v13-2',journal_id:'jmir',market:'international',title:'No abstract',publication_date:'2026-01-01',topics:[]});
 const b=createBatch({policy:'custom',yearFrom:2025,yearTo:2026,limit:2,costLimitCny:2});
 assert.equal(b.status,'paused');assert.equal(b.counts.queued,1);assert.equal(b.counts.insufficient_abstract,1);
 assert.equal((await workBatchTick()).status,'idle');
 changeBatch(b.id,'start');let calls=0;const orig=globalThis.fetch;globalThis.fetch=async()=>{calls++;return fake()};
 try{const r=await workBatchTick(4);assert.equal(r.completed,1);assert.equal(calls,1)}finally{globalThis.fetch=orig}
 const finished=batchDetail(b.id);assert.equal(finished.status,'completed');assert.equal(finished.usage.requests,1);assert.equal(finished.usage.inputTokens,900);assert.ok(finished.usage.estimatedCostCny>0);
 const a=db.prepare('SELECT * FROM articles WHERE id=?').get('v13-1');assert.equal(a.analysis_input_hash,analysisFingerprint(a));
 const b2=createBatch({policy:'custom',yearFrom:2025,yearTo:2026});assert.equal(b2.counts.cached,1);
 const c=coverage({period:'all'});assert.ok(c.validDesign>=1);assert.ok(c.missingAbstract>=1);
});
test('interrupted tasks recover without restarting completed work',()=>{
 insertArticle({id:'v13-3',journal_id:'jmir',market:'international',title:'Another sample',abstract,publication_date:'2026-06-12',topics:[]});
 const b=createBatch({policy:'custom',yearFrom:2026,yearTo:2026});
 db.prepare("UPDATE analysis_batch_items SET status='running' WHERE batch_id=? AND article_id='v13-3'").run(b.id);
 recoverBatches();assert.equal(db.prepare("SELECT status FROM analysis_batch_items WHERE batch_id=? AND article_id='v13-3'").get(b.id).status,'queued');
 changeBatch(b.id,'cancel');assert.throws(()=>changeBatch(b.id,'start'),/cannot be restarted/);
});
test('invalid filters and budget without pricing are rejected',()=>{
 assert.throws(()=>createBatch({policy:'custom',yearFrom:2027,yearTo:2025}),/year range/);
 assert.throws(()=>createBatch({policy:'custom',limit:1001}),/Limit/);
 assert.throws(()=>createBatch({policy:'custom',journalId:'unknown'}),/Unknown journal/);
});
