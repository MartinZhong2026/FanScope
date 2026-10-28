import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-cn-bulk-'));
process.env.DATABASE_PATH=path.join(dir,'test.sqlite');process.env.SCAN_ON_START='false';process.env.DEEPSEEK_API_KEY='';
const {db}=await import('../src/db.mjs');
const {importChinese,chineseIdentity,configureChinese,createChineseBatch,changeChineseBatch,stepChineseBatch,chineseCatalogLinks,chineseDiagnostics,createChineseJob,stepChineseJob}=await import('../src/chinese-ingestion.mjs');
const {chineseTransport}=await import('../src/chinese-transport.mjs');
const {researchReport}=await import('../src/research.mjs');
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
db.prepare("UPDATE journals SET issn='1000-6087' WHERE id='candidate-1'").run();
const paper={title:'[合成测试] 同题论文',authors:'作者甲',volume:'50',issue:'5',publication_date:'2026-09-29',url:'https://rkyj.ruc.edu.cn/test/a',source:'official_catalog',source_verification_status:'verified'};
const ingest=items=>importChinese({journalId:'candidate-1',items,authorized:true,evidenceUrl:'https://rkyj.ruc.edu.cn/robots.txt'});
test('annual contents and notices cannot inflate the paper count',()=>{
 const r=ingest([{...paper,title:'《社会》2025年总目录'}]);assert.equal(r.added,0);assert.match(r.rejected[0].reason,/非论文/);
});
test('exact composite identity separates same-title authors/issues and repeat pages are idempotent',()=>{
 const a=paper,b={...paper,authors:'作者乙',url:'https://rkyj.ruc.edu.cn/test/b'},c={...paper,issue:'4',url:'https://rkyj.ruc.edu.cn/test/c'};
 assert.notEqual(chineseIdentity(a),chineseIdentity(b));assert.equal(ingest([a,b,c]).added,3);
 assert.equal(ingest([a,b,c]).duplicates,3);assert.equal(db.prepare("SELECT COUNT(*) n FROM articles WHERE journal_id='candidate-1'").get().n,3);
 const enriched={...a,doi:'10.1234/synthetic-bulk',abstract:'This is explicitly synthetic evidence for a regression test. It is not a real research paper.'};
 assert.equal(ingest([enriched]).updated,1);assert.equal(ingest([enriched]).updated,0);
 assert.equal(ingest([{...enriched,title:'Conflicting title'}]).rejected.length,1);
});
test('month precision is retained; discovery and provider updates never substitute for publication',()=>{
 const result=ingest([{...paper,title:'[合成测试] 月精度',url:'https://rkyj.ruc.edu.cn/test/month',publication_date:'',publication_date_partial:'2026-06',date_precision:'month',source_updated_at:'2026-10-25T00:00:00Z'},{...paper,title:'[合成测试] 无日期',publication_date:'',url:'https://rkyj.ruc.edu.cn/test/unknown'}]);
 assert.equal(result.added,1);assert.equal(result.rejected.length,1);
 const row=db.prepare("SELECT * FROM articles WHERE url LIKE '%/month'").get();assert.equal(row.publication_date,'');assert.equal(row.date_precision,'month');assert.equal(row.analysis_status,'insufficient_abstract');assert.equal(row.analysis_json,null);
 assert.equal(chineseDiagnostics().items.find(j=>j.id==='candidate-1').quality.exactDates,3);
});
test('archive traversal bounds years, follows published links only, and rejects out-of-window article years',()=>{
 const html='<tr><th>2026 Vol.50</th><td><a href="../volumn/volumn_2.shtml">No.2</a></td></tr><tr><th>2022 Vol.46</th><td><a href="../volumn/volumn_1.shtml">No.1</a></td></tr>';
 assert.deepEqual(chineseCatalogLinks(html,'https://rkyj.ruc.edu.cn/CN/article/showOldVolumn.do','2023-10-27','2026-10-26'),['https://rkyj.ruc.edu.cn/CN/volumn/volumn_2.shtml']);
 assert.equal(chineseCatalogLinks('<a href="/CN/Y2022/V1/I1/1">old</a><a href="/CN/Y2026/V1/I1/1">new</a><a href="/file.pdf">fulltext</a>','https://rkyj.ruc.edu.cn/','2023-10-27','2026-10-26').length,1);
 assert.deepEqual(chineseCatalogLinks('<a href="../volumn/volumn_1.shtml">上一期</a>','https://rkyj.ruc.edu.cn/CN/volumn/volumn_2.shtml','2023-10-27','2026-10-26'),[]);
});
test('page import and checkpoint commit roll back together on failure',()=>{
 const before=db.prepare('SELECT COUNT(*) n FROM articles').get().n;
 assert.throws(()=>importChinese({journalId:'candidate-1',items:[{...paper,title:'[合成测试] 回滚',url:'https://rkyj.ruc.edu.cn/test/rollback'}],authorized:true,evidenceUrl:'https://rkyj.ruc.edu.cn/'},()=>{throw Error('checkpoint write failed')}),/checkpoint/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM articles').get().n,before);
});
test('failed journal pauses without blocking a different journal; tasks support three-year fixed windows',async()=>{
 for(const [id,issn] of [['candidate-1','1000-6087'],['public-admin-cn','2096-7713']])await configureChinese({journalId:id,title:db.prepare('SELECT title FROM journals WHERE id=?').get(id).title,issn,provider:'crossref',confirm:true},{json:async()=>({message:{items:[{DOI:'10.1234/probe-'+id,title:['[synthetic] source probe'],ISSN:[issn],'container-title':[db.prepare('SELECT title FROM journals WHERE id=?').get(id).title],published:{'date-parts':[[2026,9,29]]}}]}})});
 const b=createChineseBatch({journalIds:['candidate-1','public-admin-cn','candidate-14'],days:1096,maxSteps:10});assert.equal(b.blocked.length,1);changeChineseBatch(b.id,'resume');
 let result;for(let i=0;i<4;i++){result=await stepChineseBatch(b.id,{json:async url=>{if(url.includes('1000-6087'))throw Error('HTTP 503');return {message:{items:[]}};}});if(result.status!=='running')break;}
 assert.equal(result.status,'partial');assert.equal(result.items.find(j=>j.journalId==='public-admin-cn').status,'completed');const failed=result.items.find(j=>j.journalId==='candidate-1');assert.equal(failed.cursor,'*');assert.equal(failed.pages,0);assert.equal(failed.failures,1);assert.equal(failed.days,1096);
 const guarded=createChineseBatch({journalIds:['public-admin-cn'],blockedSources:[{journalId:'public-admin-cn',error:'Fresh source recheck failed'}]});assert.equal(guarded.jobs.length,0);assert.equal(guarded.blocked.length,1);
});
test('HTTP request budget counts retries; authentication and long Retry-After stop without retries',async()=>{
 let calls=0;const waits=[];const t=chineseTransport({maxRequests:2,minIntervalMs:1000,sleep:async ms=>{waits.push(ms)},clock:()=>5000,fetcher:async()=>{calls++;return calls===1?new Response('{}',{status:429,headers:{'retry-after':'2'}}):new Response('{"ok":true}');}});
 assert.equal((await t.json('https://api.crossref.org/journals/1000-6087')).ok,true);assert.equal(t.requests,2);assert.ok(waits.includes(2000));await assert.rejects(t.json('https://api.crossref.org/works'),/budget/);
 const denied=chineseTransport({sleep:async()=>{},fetcher:async()=>new Response('{}',{status:401})});await assert.rejects(denied.json('https://api.crossref.org/works'),/401/);assert.equal(denied.requests,1);
 const later=chineseTransport({sleep:async()=>{},fetcher:async()=>new Response('{}',{status:429,headers:{'retry-after':'120'}})});await assert.rejects(later.json('https://api.crossref.org/works'),/Retry-After/);assert.equal(later.requests,1);
});
test('server backoff persists across process-style reloads and forbids an early request',async()=>{
 const {db:shared}=await import('../src/db.mjs');
 const job=shared.prepare("SELECT key,value FROM meta WHERE key LIKE 'cn-job:%' ORDER BY key").all().map(x=>({...x,job:JSON.parse(x.value)})).find(x=>x.job.journalId==='candidate-1'&&x.job.status==='paused');
 assert.ok(job);const state=job.job;state.nextRetryAt=new Date(Date.now()+120000).toISOString();shared.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(state),job.key);
 let requests=0;await assert.rejects(stepChineseJob(state.id,{json:async()=>{requests++;return {message:{items:[]}}}}),/退避期/);assert.equal(requests,0);
 state.nextRetryAt=null;shared.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(state),job.key);
});
test('public listing/search exposes real source links and keeps Chinese/international denominators isolated',async()=>{
 const {makeServer}=await import('../src/server.mjs');const server=makeServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 try{const list=await (await fetch(base+'/api/articles?market=chinese&period=all&q='+encodeURIComponent('同题论文'))).json();assert.equal(list.total,3);assert.ok(list.items.every(x=>x.market==='chinese'&&x.analysis_status!=='analyzed'));
  const en=await (await fetch(base+'/api/research?market=international&period=all')).json();assert.equal(en.n,0);
  const sources=await (await fetch(base+'/api/journal-source-status')).json();assert.equal(sources.metadataConnected,1);assert.equal(sources.items.find(j=>j.id==='candidate-1').collection_status,'metadata_ready');
  assert.equal(researchReport({market:'chinese',period:'all'}).n,4);
  assert.equal((await fetch(base+'/api/admin/chinese-batches',{method:'POST',body:'{}'})).status,401);
 }finally{await new Promise(r=>server.close(r));}
});
