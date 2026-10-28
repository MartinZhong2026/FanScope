import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-coverage-'));
process.env.DATABASE_PATH=path.join(dir,'acceptance.sqlite');process.env.SCAN_ON_START='false';
const {db}=await import('../src/db.mjs');
const {crossrefToArticle,crossrefPages,parseFeed}=await import('../src/sources.mjs');
const {insertArticle}=await import('../src/monitor.mjs');
const {probeJournalSource,sourceSummary}=await import('../src/journal-onboarding.mjs');
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true})});
const j=db.prepare("SELECT * FROM journals WHERE id='geron-b'").get();
const record=(doi='10.1093/coverage-synthetic')=>({DOI:doi,type:'journal-article',title:['Synthetic regression evidence'],ISSN:['1079-5014','1758-5368'],'container-title':['The Journals of Gerontology, Series B: Psychological Sciences and Social Sciences'],published:{'date-parts':[[2025,6,2]]}});
test('explicit verified Series B alias permits own articles and rejects Series A',async()=>{
 let state;const collected=[];
 for await(const page of crossrefPages(j,{fromDate:'2025-01-01',toDate:'2025-12-31',windowDays:366,request:async()=>({message:{'total-results':2,items:[record(),{...record('10.1093/foreign'),'container-title':['The Journals of Gerontology Series A']}]}}),onState:x=>state=x}))collected.push(...page);
 assert.equal(collected.length,1);assert.equal(state.status,'complete');assert.equal(collected[0].source_verification_status,'verified');
});
test('online and future formal dates remain distinct; DOI replay preserves AI fields',()=>{
 const a=crossrefToArticle({...record(),'published-online':{'date-parts':[[2025,3,4]]},'published-print':{'date-parts':[[2040,1,1]]},volume:'80',issue:'4'},j);
 assert.equal(a.publication_date,'2025-03-04');assert.equal(a.published_print_date,'2040-01-01');assert.ok(insertArticle(a));
 db.prepare("UPDATE articles SET analysis_status='analyzed',analysis_json=?,ai_summary=? WHERE id=?").run('{"preserve":true}','cached output',a.id);
 assert.equal(insertArticle({...a,title:'Replayed metadata'}),false);
 const saved=db.prepare('SELECT * FROM articles WHERE id=?').get(a.id);assert.equal(saved.ai_summary,'cached output');assert.equal(saved.analysis_json,'{"preserve":true}');assert.equal(saved.volume,'80');assert.equal(saved.issue,'4');assert.deepEqual(JSON.parse(saved.issns_json),a.issns);assert.ok(saved.metadata_fetched_at);assert.equal(JSON.parse(saved.missing_fields_json).abstract,'not supplied by source');assert.equal(saved.notification_eligible,0);
});
test('future-only records rejected and indexed timestamp cannot fill missing publication date',()=>{
 assert.equal(crossrefToArticle({...record(),published:{'date-parts':[[2040,1,1]]}},j),null);
 const a=crossrefToArticle({...record(),published:{'date-parts':[[2025,6]]},indexed:{'date-time':'2025-06-15T00:00:00Z'}},j);assert.equal(a.publication_date,'');assert.ok(a.source_evidence.published);assert.ok(a.missing_fields.publication_date);
});
test('historical scope excludes online-before-range but preserves explicit year precision',async()=>{
 let count=0;
 const records=[record('10.1093/in-range'),{...record('10.1093/earlier'),'published-online':{'date-parts':[[2024,12,31]]}},{...record('10.1093/unknown'),published:{'date-parts':[[2025]]}}];
 for await(const page of crossrefPages(j,{fromDate:'2025-01-01',toDate:'2025-12-31',windowDays:366,request:async()=>({message:{'total-results':3,items:records}})}))count+=page.length;
 assert.equal(count,2);
});
test('repeated cursor expiration is bounded and retains replayable window',async()=>{
 let calls=0,state;
 await assert.rejects(async()=>{for await(const page of crossrefPages(j,{fromDate:'2025-01-01',toDate:'2025-01-02',request:async url=>{calls++;if(new URL(url).searchParams.get('cursor')!=='*')throw Error('HTTP 410');return {message:{'total-results':2,'next-cursor':'expired',items:[record()]}}},onState:s=>state=s})){}},/410/);
 assert.equal(calls,6);assert.equal(state.status,'failed');assert.equal(state.window_start,'2025-01-01T00:00:00.000Z');assert.equal(state.cursor,'expired');
});
test('health requires persisted identity and recent monitor success; enabled alone is insufficient',async()=>{
 db.prepare("UPDATE journals SET enabled=1,last_success=?,last_error=NULL WHERE id=?").run(new Date().toISOString(),j.id);
 assert.equal(sourceSummary().items.find(x=>x.id===j.id).status,'unverified');
 await probeJournalSource({id:j.id},async()=>({message:{items:[record()]}}));
 let saved=sourceSummary().items.find(x=>x.id===j.id);assert.equal(saved.status,'healthy');assert.ok(saved.evidence.sample[0].doi);
 db.prepare("UPDATE journals SET last_success='2025-01-01T00:00:00Z' WHERE id=?").run(j.id);assert.equal(sourceSummary().items.find(x=>x.id===j.id).status,'stale');
 db.prepare("UPDATE journals SET issn='1758-5368' WHERE id=?").run(j.id);assert.equal(sourceSummary().items.find(x=>x.id===j.id).verified,false);
});
test('malformed totals and unbounded page sizes fail without advancing cursor',async()=>{
 await assert.rejects(async()=>{for await(const page of crossrefPages(j,{pageSize:1001})){}},/page or window/);
 let state;await assert.rejects(async()=>{for await(const page of crossrefPages(j,{request:async()=>({message:{'total-results':-1,items:[]}}),onState:x=>state=x})){}},/invalid total/);assert.equal(state.processed,0);
});
test('Atom updated timestamp is never treated as its publication date',()=>{
 const rows=parseFeed('<feed><title>人口研究</title><entry><title>测试记录</title><link href="https://rkyj.ruc.edu.cn/article/1"/><updated>2025-06-01</updated></entry></feed>',{id:'candidate-1',title:'人口研究',rss_url:'https://rkyj.ruc.edu.cn/feed'},{verifyIdentity:true});assert.equal(rows.length,0);
});
test('month-only historical metadata is retained without manufacturing a day and remains queryable',async()=>{
 const a=crossrefToArticle({...record('10.1093/month-only'),published:{'date-parts':[[2025,1]]}},j);
 assert.equal(a.publication_date,'');assert.equal(a.publication_date_partial,'2025-01');assert.equal(a.date_precision,'month');assert.ok(insertArticle(a));
 const saved=db.prepare('SELECT publication_date,publication_date_partial,published_year FROM articles WHERE id=?').get(a.id);assert.equal(saved.publication_date,'');assert.equal(saved.published_year,2025);
 const {researchWhere}=await import('../src/research.mjs');const q=researchWhere({period:'2025'});
 assert.ok(db.prepare('SELECT id FROM articles a'+q.where+' AND id=?').get(...q.params,a.id));
});
test('administrator pause supersedes an in-flight Crossref activation',async()=>{
 const {manageRSS}=await import('../src/journal-onboarding.mjs');let complete;const response=new Promise(r=>complete=r);
 const activation=probeJournalSource({id:j.id,issn:'1079-5014',enable:true,confirm:true},()=>response);
 await manageRSS({id:j.id,action:'pause'});complete({message:{items:[record()]}});
 await assert.rejects(activation,/superseded/);assert.equal(db.prepare('SELECT enabled FROM journals WHERE id=?').get(j.id).enabled,0);
});
test('switching ISSN cannot reuse another source incremental cursor',async()=>{
 db.prepare("UPDATE journals SET issn='1758-5368',checkpoint='2025-01-01T00:00:00Z',last_success='2025-01-01T00:00:00Z' WHERE id=?").run(j.id);
 db.prepare("INSERT INTO scan_windows(journal_id,mode,range_end,window_start,window_end,cursor,status,updated_at) VALUES(?,'incremental','2025-01-02','2025-01-01','2025-01-02','old-source-cursor','paused','2025-01-01')").run(j.id);
 await probeJournalSource({id:j.id,issn:'1079-5014',enable:true,confirm:true},async()=>({message:{items:[record()]}}));
 assert.equal(db.prepare('SELECT checkpoint FROM journals WHERE id=?').get(j.id).checkpoint,null);assert.equal(db.prepare('SELECT COUNT(*) n FROM scan_windows WHERE journal_id=?').get(j.id).n,0);
 assert.equal(db.prepare('SELECT last_success FROM journals WHERE id=?').get(j.id).last_success,null);
});
test('a historical job pauses before requesting a changed source ISSN',async()=>{
 const {createBackfill,changeBackfill,workBackfillTick,getBackfill}=await import('../src/journal-backfill.mjs');
 const job=createBackfill({journalId:j.id,yearFrom:2025,yearTo:2025});assert.equal(job.source_identifier,'1079-5014');changeBackfill(job.id,'start');db.prepare("UPDATE journals SET issn='1758-5368' WHERE id=?").run(j.id);
 let requests=0;await workBackfillTick({request:async()=>{requests++;throw Error('must not request')}});assert.equal(requests,0);assert.equal(getBackfill(job.id).status,'paused');assert.match(getBackfill(job.id).error,/ISSN/);
});
test('earlier month-precision online publication wins over a later exact print year',()=>{
 const a=crossrefToArticle({...record('10.1093/partial-online'),'published-online':{'date-parts':[[2024,10]]},'published-print':{'date-parts':[[2025,8,3]]},published:{'date-parts':[[2024,10]]}},j);
 assert.equal(a.publication_date,'');assert.equal(a.publication_date_partial,'2024-10');assert.equal(a.published_print_date,'2025-08-03');assert.equal(a.date_precision,'month');
});
