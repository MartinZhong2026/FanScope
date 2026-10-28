import test,{after} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-trend-priority-'));
process.env.DATABASE_PATH=path.join(directory,'acceptance.sqlite');process.env.SCAN_ON_START='false';process.env.DEEPSEEK_API_KEY='';
const {db}=await import('../src/db.mjs');const {insertArticle}=await import('../src/monitor.mjs');
const {classifyArticleType,trendWindow,currentResearchYear,publicationBackfillEnd}=await import('../src/publication-policy.mjs');
const {researchReport,researchWhere,comparableYearToDate}=await import('../src/research.mjs');
const {createBatch,changeBatch,setBatchBudget,workBatchTick}=await import('../src/analysis-batches.mjs');
const {analysisFingerprint,analysisIsCurrent}=await import('../src/ai.mjs');
const {supplementArticle,enrichMetadata}=await import('../src/metadata-enrichment.mjs');
const {createBackfill,changeBackfill,workBackfillTick}=await import('../src/journal-backfill.mjs');
after(()=>{db.close();fs.rmSync(directory,{recursive:true,force:true})});
const abstract='Caregiving research follows a cohort of 500 persons using survival analysis. This is a synthetic test abstract, never a real article.';
function add(id,date='2026-10-20',type='original_research',other={}){insertArticle({id,journal_id:'jmir',market:'international',title:'Dementia caregiving '+id,abstract,publication_date:date,source:'manual',topics:['care'],article_type:type,article_type_evidence:{source:'synthetic explicit fixture',raw_labels:[type]},...other});}
test('explicit source types distinguish research/review/abstract/editorial/book review; generic labels and protocols stay unknown',()=>{
 for(const [raw,type] of [['research-article','original_research'],['Review','review'],['meeting-abstract','conference_abstract'],['Editorial','editorial'],['book-review','book_review'],['Journal Article','unknown'],['journal-article','unknown']])assert.equal(classifyArticleType([raw],'fixture').article_type,type);
 assert.equal(classifyArticleType(['research-article','Clinical Trial Protocol']).article_type,'unknown');
 assert.equal(classifyArticleType(['research-article'],'fixture','DETECT: a prospective longitudinal study protocol').article_type,'unknown');
 assert.equal(classifyArticleType(['Review'],'fixture','A systematic review').article_type,'review');
 assert.equal(classifyArticleType(['research-article','Review']).article_type,'unknown');
});
test('2026 default and 30/90/180-day windows, optional 2025, and 2027 rollover preserve the full corpus',()=>{
 add('baseline','2025-06-01');add('recent');add('news','2026-10-20','editorial');
 assert.equal(researchReport({period:'ytd'}).n,2);assert.equal(researchReport({period:'2025'}).n,1);assert.equal(researchReport({period:'all'}).n,3);
 assert.equal(trendWindow('90d',new Date('2026-10-25T12:00:00Z')).start,'2026-07-28');
 assert.equal(trendWindow('180d',new Date('2026-10-25T12:00:00Z')).start,'2026-04-29');
 assert.equal(trendWindow('30d',new Date('2026-01-10T12:00:00Z')).start,'2026-01-01');
 assert.equal(currentResearchYear(new Date('2027-02-01')),2027);assert.equal(trendWindow('ytd',new Date('2027-02-01')).start,'2027-01-01');
 assert.equal(trendWindow('ytd',new Date('2026-12-31T16:30:00Z')).end,'2027-01-01');
 assert.equal(publicationBackfillEnd(2027,new Date('2026-12-31T16:30:00Z')),'2027-01-01T23:59:59.000Z');
});
test('all seven chart denominators share the selected type and show missing evidence without inventing methods',()=>{
 const r=researchReport({period:'ytd',article_type:'original_research'});
 assert.equal(r.n,1);assert.equal(r.type_counts.original_research,1);assert.equal(r.chart_quality.length,7);
 assert.ok(r.chart_quality.every(q=>q.selected_n===1&&q.article_type==='original_research'));
 assert.equal(r.known.methods,0);assert.equal(r.unknown_rates.methods,1);assert.deepEqual(r.methods,{});
});
test('default AI candidate policy is current-year, relevant, abstract-backed, newest-first and capped at 200; never starts',async()=>{
 add('missing','2026-10-22','original_research',{abstract:''});add('unknown','2026-10-22','unknown');add('low','2026-10-22','original_research',{title:'Unrelated title',abstract:'Unrelated text long enough to be abstract content but without any configured research keywords.'});
 const batch=createBatch();assert.equal(batch.status,'paused');assert.equal(batch.filter.yearFrom,2026);assert.equal(batch.filter.limit,150);assert.equal(batch.total,1);
 assert.equal(db.prepare('SELECT article_id FROM analysis_batch_items WHERE batch_id=?').get(batch.id).article_id,'recent');
 assert.throws(()=>createBatch({limit:201}),/最多200/);assert.throws(()=>changeBatch(batch.id,'start'),/key/);
 assert.equal((await workBatchTick()).status,'idle');assert.equal(db.prepare('SELECT COUNT(*) n FROM analysis_usage_log').get().n,0);
});
test('queued candidates are revalidated before spending when source metadata later changes their type',async()=>{
 const batch=createBatch();db.prepare("UPDATE articles SET article_type='unknown' WHERE id='recent'").run();
 db.prepare("UPDATE analysis_batches SET status='running' WHERE id=?").run(batch.id);await workBatchTick(5);
 assert.equal(db.prepare('SELECT status FROM analysis_batch_items WHERE batch_id=?').get(batch.id).status,'excluded');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM analysis_usage_log').get().n,0);db.prepare("UPDATE articles SET article_type='original_research' WHERE id='recent'").run();
});
test('candidate preparation and legacy budget endpoint never trigger paid AI or require prices',()=>{
 const batch=createBatch({costLimitCny:''});assert.equal(batch.status,'paused');assert.equal(batch.estimated_cost_limit_cny,null);
 const before=[process.env.AI_INPUT_CNY_PER_M_TOKENS,process.env.AI_OUTPUT_CNY_PER_M_TOKENS];
 try{
  delete process.env.AI_INPUT_CNY_PER_M_TOKENS;delete process.env.AI_OUTPUT_CNY_PER_M_TOKENS;
  const updated=setBatchBudget(batch.id,{costLimitCny:10});
  assert.equal(updated.status,'paused');
  assert.equal(updated.estimated_cost_limit_cny,null);
  assert.equal(db.prepare('SELECT estimated_cost_limit_cny FROM analysis_batches WHERE id=?').get(batch.id).estimated_cost_limit_cny,null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM analysis_usage_log').get().n,0);
 }finally{for(const [i,key] of ['AI_INPUT_CNY_PER_M_TOKENS','AI_OUTPUT_CNY_PER_M_TOKENS'].entries())if(before[i]===undefined)delete process.env[key];else process.env[key]=before[i];}
});
test('public metadata fills absent abstracts, verifies DOI+ISSN and preserves existing AI/cache; mismatch fails closed',async()=>{
 add('metadata','2026-10-21','unknown',{doi:'10.1234/metadata-fixture',abstract:''});
 const id='doi:10.1234/metadata-fixture';db.prepare("UPDATE articles SET analysis_status='analyzed',analysis_json=?,ai_summary='preserved cached text',analysis_input_hash='old-hash' WHERE id=?").run('{"preserve":true}',id);
 const data={resultList:{result:[{doi:'10.1234/metadata-fixture',id:'fixture',journalInfo:{journal:{issn:'1438-8871',title:'Journal of Medical Internet Research'}},pubTypeList:{pubType:['research-article','Journal Article']},abstractText:abstract}]}};
 const result=await supplementArticle(id,{request:async()=>data});assert.equal(result.status,'verified');assert.equal(result.abstractAdded,true);
 const row=db.prepare('SELECT * FROM articles WHERE id=?').get(id);assert.equal(row.article_type,'original_research');assert.equal(row.abstract_status,'available');assert.equal(row.ai_summary,'preserved cached text');assert.equal(row.analysis_json,'{"preserve":true}');assert.equal(row.analysis_input_hash,'old-hash');
 assert.equal((await supplementArticle(id,{request:async()=>{throw Error('cache must suppress network')}})).status,'cached');
 add('wrong','2026-10-21','unknown',{doi:'10.1234/metadata-wrong',abstract:''});
 const bad=await supplementArticle('doi:10.1234/metadata-wrong',{request:async()=>({resultList:{result:[{...data.resultList.result[0],doi:'10.1234/metadata-wrong',journalInfo:{journal:{issn:'0000-0000'}}}]}})});assert.equal(bad.status,'identity_mismatch');assert.equal(db.prepare('SELECT abstract FROM articles WHERE doi=?').get('10.1234/metadata-wrong').abstract,'');
});
test('metadata failures are recorded and protected from immediate repeated requests; no paid tasks are created',async()=>{
 add('failed','2026-10-21','unknown',{doi:'10.1234/metadata-failed',abstract:''});
 const id='doi:10.1234/metadata-failed';assert.equal((await supplementArticle(id,{request:async()=>{throw Error('synthetic outage')}})).status,'failed');
 assert.equal((await supplementArticle(id,{request:async()=>{throw Error('must not retry immediately')}})).status,'cached');
 assert.match(db.prepare('SELECT abstract_error FROM articles WHERE id=?').get(id).abstract_error,/outage/);assert.equal(db.prepare("SELECT COUNT(*) n FROM analysis_batches WHERE status='running'").get().n,0);
});
test('normalization reuses analyzed 2026 results across formatting and into 2027; substantive content changes invalidate cache',()=>{
 const a={title:'Dementia care',abstract,analysis_status:'analyzed',analysis_json:'{}'};a.analysis_input_hash=analysisFingerprint(a);
 assert.ok(analysisIsCurrent({...a,title:' Dementia   care '}));assert.equal(analysisIsCurrent({...a,abstract:abstract+' Substantive new findings.'}),false);
 assert.notEqual(analysisFingerprint({...a,abstract:'p <0.05 and effect >0.1'}),analysisFingerprint({...a,abstract:'p <0.01 and effect >0.2'}));
 const legacy={...a,analysis_input_hash:'legacy',analysis_normalized_hash:analysisFingerprint(a)};assert.ok(analysisIsCurrent({...legacy,abstract:abstract.replaceAll(' ','  ')}));
 assert.equal(analysisIsCurrent({...legacy,abstract:'Different research content'}),false);
});
test('comparison uses the same month/day cutoff, common journals and types; excludes coarse dates and never reports annual growth',()=>{
 add('comparable-2025','2025-10-20');add('late-baseline','2025-12-01');add('coarse','2026-10','original_research',{publication_date:'',publication_date_partial:'2026-10',date_precision:'month'});
 const r=comparableYearToDate({article_type:'original_research'},new Date('2026-10-25T12:00:00Z'));
 assert.equal(r.baseline.end,'2025-10-25');assert.deepEqual(r.journals,['jmir']);assert.equal(r.baseline.n,2);assert.ok(r.excludedImprecise>0);assert.equal(r.annualGrowth,null);
 assert.throws(()=>comparableYearToDate({article_type:'unknown'}),/文章类型/);
});
test('backfill defaults to 2026 and supports recent windows without deleting optional 2025 data',()=>{
 const b=createBackfill({journalId:'ageing-society'});assert.match(b.from_date,/^2026-01-01/);changeBackfill(b.id,'cancel');
 const recent=createBackfill({journalId:'ageing-society',period:'90d'});assert.equal(recent.from_date.slice(0,10),trendWindow('90d').start);changeBackfill(recent.id,'cancel');
 assert.ok(db.prepare("SELECT COUNT(*) n FROM articles WHERE published_year=2025").get().n>=1);
 const old=createBackfill({journalId:'gerontologist',yearFrom:2025,yearTo:2026});changeBackfill(old.id,'start');
 db.prepare("UPDATE journal_backfill_jobs SET cursor='retained-old-cursor' WHERE id=?").run(old.id);
 const preferred=createBackfill({journalId:'gerontologist'});
 assert.equal(db.prepare('SELECT status FROM journal_backfill_jobs WHERE id=?').get(old.id).status,'paused');
 assert.equal(db.prepare('SELECT cursor FROM journal_backfill_jobs WHERE id=?').get(old.id).cursor,'retained-old-cursor');
 changeBackfill(old.id,'cancel');changeBackfill(preferred.id,'cancel');
});
test('current-year backfill runs before optional 2025 work and keeps independent cursors',async()=>{
 const baseline=createBackfill({journalId:'ssm',yearFrom:2025,yearTo:2025});changeBackfill(baseline.id,'start');
 const current=createBackfill({journalId:'ageing-society'});changeBackfill(current.id,'start');
 let url;const r=await workBackfillTick({maxPages:1,request:async u=>{url=u;return {message:{items:[],'total-results':0}}}});assert.equal(r.id,current.id);assert.match(url,/1469-1779/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM scan_windows').get().n,0);changeBackfill(baseline.id,'cancel');changeBackfill(current.id,'cancel');
});
