import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
process.env.DATABASE_PATH=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-quality-')),'test.sqlite');
process.env.SCAN_ON_START='false';process.env.DEEPSEEK_API_KEY='mock-only';
const {db,now}=await import('../src/db.mjs');
const {insertArticle}=await import('../src/monitor.mjs');
const {makeServer}=await import('../src/server.mjs');
const {researchReport}=await import('../src/research.mjs');
const {analysisFingerprint}=await import('../src/ai.mjs');
const {createBatch,batchDetail,changeBatch,workBatchTick}=await import('../src/analysis-batches.mjs');
const {publicationToday,trendWindow}=await import('../src/publication-policy.mjs');
const {sourceDistribution}=await import('../../web/research-visuals.mjs');
let server;
after(async()=>{if(server)await new Promise(r=>server.close(r));db.close();fs.rmSync(path.dirname(process.env.DATABASE_PATH),{recursive:true,force:true});});
const day=d=>new Date(Date.parse(publicationToday()+'T00:00:00Z')+d*86400000).toISOString().slice(0,10);
const add=(id,fields={})=>{insertArticle({id,journal_id:'jmir',market:'international',title:id,publication_date:day(0),...fields});return db.prepare('SELECT * FROM articles WHERE id=?').get(id)};
const mark=(a,x,hash=analysisFingerprint(a))=>db.prepare("UPDATE articles SET analysis_status='analyzed',analysis_json=?,analysis_normalized_hash=?,analysis_input_hash=? WHERE id=?").run(JSON.stringify(x),hash,hash,a.id);

test('home query uses 90 publication days, excludes uncertain/invalid/future dates and ignores discovery order',async()=>{
 for(const [id,d] of [['latest',0],['second',-1],['third',-2],['boundary',-89],['backfilled',-90],['future',1]])add('home-'+id,{publication_date:day(d)});
 add('home-year',{publication_date_partial:publicationToday().slice(0,4),date_precision:'year'});
 add('home-month',{publication_date_partial:publicationToday().slice(0,7),date_precision:'month'});
 add('home-invalid',{publication_date:publicationToday().slice(0,4)+'-02-30',date_precision:'day'});
 add('home-unknown',{publication_date:'',date_precision:'unknown'});
 add('home-demo',{demo:true});db.prepare("UPDATE articles SET demo=1 WHERE id='home-demo'").run();
 db.prepare("UPDATE articles SET discovered_at='2099-01-01' WHERE id='home-backfilled'").run();
 server=makeServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const query='/api/articles?period=90d&precise_date=1&view=publication&limit=3&q=home-';
 const r=await (await fetch(base+query)).json();
 assert.equal(r.total,4);assert.deepEqual(r.items.map(x=>x.id),['home-latest','home-second','home-third']);
 const none=await (await fetch(base+query+'&journal=candidate-1')).json();assert.equal(none.total,0);assert.deepEqual(none.items,[]);
 assert.equal(trendWindow('90d').start,day(-89));
});

test('dimension counts deduplicate labels, require current validated evidence and retain undated distributions',()=>{
 const abstract='A cohort of 500 persons was followed using survival analysis and public administrative data. This is isolated test evidence.';
 const e=quote=>({quote,confidence:.9});
 const valid={provider:'original-provider',model:'original-model',extracted_at:'2002-01-01T00:00:00Z',study_design:'cohort',statistical_methods:['survival','survival'],sample_n:500,sample_unit:'person',data_source_type:'administrative',evidence:{study_design:e('A cohort of 500 persons'),'method:survival':e('using survival analysis'),sample_n:e('500 persons was followed'),sample_unit:e('500 persons was followed'),data_source_type:e('public administrative data')}};
 const a=add('quality evidence valid',{abstract,topics:['care','care']});mark(a,valid);
 const undated=add('quality evidence undated',{abstract,publication_date:'',topics:[]});mark(undated,{...valid,study_design:'unknown',statistical_methods:[],sample_n:null});
 const weak=add('quality evidence weak',{abstract,topics:[]});mark(weak,{...valid,sample_n:600,data_source_type:'unknown',study_design:'unknown',statistical_methods:[],evidence:{sample_n:e('500 persons was followed'),sample_unit:e('500 persons was followed')}});
 const stale=add('quality evidence stale',{abstract,topics:[]});mark(stale,valid,'obsolete');
 const unknown=add('quality evidence unknown',{abstract,topics:[]});mark(unknown,{study_design:'unknown',evidence:{study_design:e('A cohort of 500 persons')}});
 const low=add('quality evidence confidence',{abstract,topics:[]});mark(low,{...valid,statistical_methods:[],sample_n:null,study_design:'cohort',data_source_type:'unknown',evidence:{study_design:{quote:'A cohort of 500 persons',confidence:.2}}});
 const empty=researchReport({period:'all',q:'no matching quality record'});assert.equal(empty.coverage,null);assert.equal(empty.unknown_rates.sample,null);assert.equal(empty.chart_quality[0].missing_ratio,null);
 const r=researchReport({period:'all',q:'quality evidence'});
 assert.equal(r.evidence[0].analysis.provider,'original-provider');assert.equal(r.evidence[0].analysis.model,'original-model');assert.equal(r.evidence[0].analysis.extracted_at,'2002-01-01T00:00:00Z');
 assert.equal(r.n,6);assert.equal(r.analyzed,6);assert.equal(r.evidenced,2);assert.equal(r.coverage,2/6);
 assert.deepEqual(r.known,{date:5,topics:1,design:1,methods:1,data:2,sample:1,matrix:1});
 assert.deepEqual(r.dated,{topics:1,methods:1,data:1});assert.equal(r.totals.topics.care,1);assert.equal(r.totals.methods.survival,1);
 assert.equal(r.totals.sources.administrative,2);assert.equal(r.unknown_rates.data,1-2/6);
 assert.equal(r.chart_quality[5].valid_n,1);assert.equal(r.chart_quality[6].valid_n,1);
 const sources=sourceDistribution(r);assert.equal(sources.reduce((n,x)=>n+x.n,0),6);assert.equal(sources.find(x=>x.name==='unknown').n,4);
});

test('200 and 164 item progress, partial prices and failure reasons are read-only projections',()=>{
 for(let i=0;i<200;i++)add('batch-quality-'+i,{publication_date:'2002-01-01',abstract:'A long enough synthetic abstract for isolated batch accounting tests. No findings are claimed.'});
 const a=createBatch({policy:'custom',yearFrom:2002,yearTo:2002,limit:200}),b=createBatch({policy:'custom',yearFrom:2002,yearTo:2002,limit:164});
 const items=db.prepare('SELECT article_id FROM analysis_batch_items WHERE batch_id=? ORDER BY article_id').all(a.id);
 for(let i=0;i<items.length;i++)db.prepare('UPDATE analysis_batch_items SET status=?,error=? WHERE batch_id=? AND article_id=?').run(i<100?'completed':i<164?'failed':i===164?'running':'queued',i>=100&&i<164?'DeepSeek invalid_json':'',a.id,items[i].article_id);
 db.prepare("UPDATE analysis_batch_items SET status='cached' WHERE batch_id=?").run(b.id);
 const usage=db.prepare('INSERT INTO analysis_usage_log(article_id,batch_id,model,input_tokens,output_tokens,cost_cny,created_at,status) VALUES(?,?,?,?,?,?,?,?)');
 usage.run(items[0].article_id,a.id,'mock',100,10,.0002,now(),'completed');usage.run(items[1].article_id,a.id,'mock',0,0,.02,now(),'uncertain');usage.run(items[2].article_id,a.id,'mock',0,0,null,now(),'uncertain');
 const before=db.prepare('SELECT total_changes() n').get().n;
 const r=batchDetail(a.id),s=batchDetail(b.id);
 assert.equal(r.progress.settled,164);assert.equal(r.progress.percent,82);assert.equal(r.progress.running,1);assert.equal(r.progress.evidenced,0);
 assert.equal(r.usage.requests,3);assert.equal(r.usage.estimatedCostCny,null);assert.equal(r.usage.reportedCostCny,.0002);assert.equal(r.usage.reservedCostCny,.02);assert.equal(r.usage.uncertainRequests,2);assert.equal(r.usage.unpricedRequests,1);
 assert.equal(r.failures[0].code,'invalid_json');assert.equal(r.failures[0].count,64);assert.equal(r.failures[0].mayHaveCost,true);
 assert.equal(s.progress.settled,164);assert.equal(s.progress.percent,100);assert.equal(s.usage.requests,0);assert.equal(s.usage.estimatedCostCny,0);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
});

test('overlapping batches share a successful cache even when the response has no usable evidence',async()=>{
 add('overlap',{publication_date:'2003-01-01',abstract:'A synthetic abstract long enough for an isolated model call. No supported research facts are supplied.'});
 const opts={policy:'custom',yearFrom:2003,yearTo:2003,limit:1};const a=createBatch(opts),b=createBatch(opts);
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:'{}'}}],usage:{prompt_tokens:100,completion_tokens:10}}));};
 try{changeBatch(a.id,'start');await workBatchTick();changeBatch(b.id,'start');await workBatchTick();assert.equal(calls,1);assert.equal(batchDetail(b.id).counts.cached,1);assert.equal(batchDetail(b.id).usage.requests,0);assert.equal(batchDetail(a.id).progress.withoutEvidence,1);}finally{globalThis.fetch=original;}
});
