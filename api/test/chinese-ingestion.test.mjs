import test,{after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
process.env.DATABASE_PATH=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'cn-ingestion-')),'test.sqlite');process.env.SCAN_ON_START='false';
const {db}=await import('../src/db.mjs');const {citationArticle,importChinese,configureChinese,createChineseJob,stepChineseJob,chineseDiagnostics}=await import('../src/chinese-ingestion.mjs');const {researchReport}=await import('../src/research.mjs');const {insertArticle}=await import('../src/monitor.mjs');
after(()=>{db.close();fs.rmSync(path.dirname(process.env.DATABASE_PATH),{recursive:true,force:true});});
const j=db.prepare("SELECT * FROM journals WHERE id='candidate-1'").get();db.prepare("UPDATE journals SET issn='1000-6087' WHERE id=?").run(j.id);j.issn='1000-6087';
const html=fs.readFileSync(new URL('./fixtures/chinese-official-2026.html',import.meta.url),'utf8'),url='https://rkyj.ruc.edu.cn/CN/Y2026/V50/I5/3';
const article=citationArticle(html,j,url);
test('real public Chinese metadata imports without inventing abstracts or AI; titles/URLs/DOI deduplicate',()=>{
 assert.equal(article.title,'中国失能老年人口规模及老年照护劳动力需求量测算');assert.equal(article.publication_date,'2026-09-29');
 assert.throws(()=>importChinese({journalId:j.id,items:[article]}),/授权/);
 const opts={journalId:j.id,items:[article],authorized:true,evidenceUrl:url};assert.equal(importChinese(opts).added,1);assert.equal(importChinese({...opts,items:[{...article,url:url+'?different=1',title:article.title+'。'}]}).duplicates,1);
 const row=db.prepare('SELECT * FROM articles WHERE journal_id=?').get(j.id);assert.equal(row.analysis_status,'insufficient_abstract');assert.equal(row.analysis_json,null);
 assert.throws(()=>citationArticle(html,{...j,title:'社会'},url),/不匹配/);
 const invalid=importChinese({...opts,items:[{...article,title:'bad date',publication_date:'2026-02-30'},{...article,title:'future',publication_date:'2099-01-01'}]});assert.equal(invalid.rejected.length,2);
});
test('catalog pages resume checkpoints, reject foreign hosts, retain data on failures and allow incremental replay',async()=>{
 const source={journalId:j.id,title:j.title,issn:j.issn,provider:'catalog',url,confirm:true};await configureChinese(source,{read:async()=>html});
 const b=createChineseJob({journalId:j.id});assert.equal(b.status,'paused');
 let calls=0;const failed=await stepChineseJob(b.id,{read:async()=>{calls++;throw Error('private provider error')}});assert.equal(failed.pages,0);assert.equal(failed.queue[0],url);assert.ok(!failed.error.includes('private'));
 const done=await stepChineseJob(b.id,{read:async()=>html});assert.equal(done.status,'completed');assert.equal(done.duplicates,1);assert.equal(done.pages,1);
 const inc=createChineseJob({journalId:j.id,incremental:true});assert.ok(inc.start>=done.start);assert.throws(()=>createChineseJob({journalId:j.id}),/已有/);
 await assert.rejects(configureChinese({...source,url:'https://127.0.0.1/'},{read:async()=>html}),/验证失败/);
 const diagnostics=chineseDiagnostics();assert.equal(diagnostics.items.find(x=>x.id===j.id).rank_verification_status,'pending');assert.equal(diagnostics.coverageAudited,false);
});
test('Chinese and international report denominators, metadata and evidence never cross markets',()=>{
 insertArticle({id:'en-independent',journal_id:'jmir',market:'international',title:'English comparison',publication_date:'2026-09-29',abstract:'A genuine field is unknown here; this is an explicitly synthetic isolation control.',topics:['ai']});
 insertArticle({id:'wrong-market',journal_id:'jmir',market:'chinese',title:'Invalid ownership control',publication_date:'2026-09-29',topics:['ai']});
 const cn=researchReport({period:'180d',market:'chinese'}),en=researchReport({period:'180d',market:'international'});assert.equal(cn.n,1);assert.equal(en.n,1);assert.equal(cn.evidenced,0);assert.equal(cn.known.sample,0);assert.equal(cn.missingAbstract,1);assert.equal(en.missingAbstract,0);assert.throws(()=>researchReport({market:'invalid'}),/market/);
});
test('provider pagination resumes from persisted cursors; late pages cannot double import',async()=>{
 const {cancelChineseJob}=await import('../src/chinese-ingestion.mjs');
 const current=chineseDiagnostics().items.find(x=>x.id===j.id).jobs.find(x=>x.status==='paused');cancelChineseJob(current.id);
 const x={DOI:'10.1234/chinese-live-control',ISSN:[j.issn],title:['中国失能老年人口规模及老年照护劳动力需求量测算'],author:article.authors.split(', ').map(family=>({family})),volume:article.volume,issue:article.issue,type:'journal-article','container-title':[j.title],published:{'date-parts':[[2026,9,29]]}};
 await configureChinese({journalId:j.id,title:j.title,issn:j.issn,provider:'crossref',confirm:true},{json:async()=>({message:{items:[x]}})});
 const b=createChineseJob({journalId:j.id});let seen=[];
 const request=async url=>{const cursor=new URL(url).searchParams.get('cursor');seen.push(cursor);return {message:{items:cursor==='*'?[x]:[],'next-cursor':'next-page'}};};
 const first=await stepChineseJob(b.id,{json:request});assert.equal(first.status,'paused');assert.equal(first.cursor,'next-page');
 const second=await stepChineseJob(b.id,{json:request});assert.equal(second.status,'completed');assert.deepEqual(seen,['*','next-page']);assert.equal(second.duplicates,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM articles WHERE market='chinese' AND journal_id=?").get(j.id).n,1);
});
test('new management APIs require authentication; catalog verification never grants CSSCI status',async()=>{
 const {makeServer}=await import('../src/server.mjs');const server=makeServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{for(const route of ['chinese-source','chinese-import','chinese-jobs','chinese-jobs/unknown']){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/${route}`,{method:'POST',body:'{}'});assert.equal(r.status,401);}
 assert.equal(db.prepare('SELECT rank_verification_status FROM journals WHERE id=?').get(j.id).rank_verification_status,'pending');}finally{await new Promise(r=>server.close(r));}
});
