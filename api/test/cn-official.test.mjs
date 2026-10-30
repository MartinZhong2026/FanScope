// Chinese publisher adapter. Parser tests use excerpts of real public pages;
// collection tests use a mock transport on an isolated database.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-cn-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_PATH:path.join(dir,'t.sqlite'),DEEPSEEK_API_KEY:'',FANSCOPE_LOG_DIR:path.join(dir,'logs'),FANSCOPE_LOG_LEVEL:'error'});
const {db}=await import('../src/db.mjs');await import('../src/server.mjs');
const cn=await import('../src/ingest/official-cn.mjs');
const {CHINESE_STATUS,eligibleChineseJournals}=await import('../src/ingest/jobs.mjs');
const fixture=n=>fs.readFileSync(new URL(`./fixtures/cn-official/${n}.html`,import.meta.url),'utf8');
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200})});
const entry={title:'人口研究',issn:'1000-6087',journal_id:'candidate-1',adapter:'official-cn',base:'https://rkyj.ruc.edu.cn',home:'https://rkyj.ruc.edu.cn/CN/1000-6087/home.shtml',since:2015,status:'B'};
const page=fixture('rkyj'),URL1='https://rkyj.ruc.edu.cn/CN/Y2026/V50/I5/116';

test('real pages: the full abstract comes from the body, not the truncated meta tag',()=>{
 const a=cn.extractAbstract(page);
 assert.ok(a.startsWith('本文将生育意愿界定为'));assert.ok(a.length>150);assert.ok(!a.includes('...'));assert.ok(!/<|&nbsp;/.test(a));
 assert.ok(cn.extractAbstract(fixture('society')).startsWith('本研究在行政发包制研究的基础上'),'nested <p> in 社会');
 assert.ok(cn.extractAbstract(fixture('shjs')).startsWith('中国社会工作服务处于'));
});
test('no abstract block, or only a stub, yields empty rather than a guess',()=>{
 assert.equal(cn.extractAbstract('<div id="x"></div>'),'');
 assert.equal(cn.extractAbstract('<div id="collapseOne"><strong>摘要：</strong>暂无</div>'),'');
 assert.equal(cn.extractAbstract('<div id="collapseOne"><strong>摘要：</strong>'+'本文研究了很多重要的问题并且得到了结论'.repeat(3)+'...</div>'),'');
});
test('issue and article links parse from both index layouts',()=>{
 const base='https://shjs.ruc.edu.cn';
 assert.deepEqual(cn.issueLinks('<a href="../volumn/volumn_1424.shtml">x</a><a href="https://shjs.ruc.edu.cn/CN/Y2026/V13/I4">y</a>',base),[base+'/CN/volumn/volumn_1424.shtml',base+'/CN/Y2026/V13/I4']);
 assert.deepEqual(cn.articleLinks(`<a href="${base}/CN/Y2026/V13/I4/5">a</a><a href="${base}/CN/Y2026/V13/I4/5">b</a><a href="/other">c</a>`,base),[base+'/CN/Y2026/V13/I4/5']);
});

function transport(pages){const calls=[];return {calls,read:async url=>{calls.push(url);if(!(url in pages))throw Error('HTTP 404');return pages[url]}}}
const site={[entry.base+'/CN/article/showOldVolumn.do']:'<a href="../volumn/volumn_1.shtml">',[entry.base+'/CN/volumn/volumn_1.shtml']:`<a href="${URL1}">`,[URL1]:page};

test('collect fills an existing metadata-only row without duplicating it, and repeats safely',async()=>{
 const ev=JSON.stringify({abstract_policy:'not retained: bibliographic metadata scope only'});
 db.prepare("INSERT INTO articles(id,journal_id,market,title,url,authors,abstract,publication_date,discovered_at,source,topics,matched,analysis_status,demo,source_evidence_json,volume,issue) VALUES('old','candidate-1','chinese','再生育计划的双重驱动因素：基于生育支持与生育意愿的实证研究',?,'贾洪文, 徐颖, 陈园园, 吴继煜','','2026-09-29','2026-10-28','official_catalog','[]',0,'insufficient_abstract',0,?,'50','5')").run(URL1,ev);
 const t=transport(site);
 const first=await cn.collectJournal(entry,{read:t.read});
 assert.equal(first.added,0);assert.equal(first.abstracts,1);
 const r=db.prepare("SELECT * FROM articles WHERE journal_id='candidate-1'").all();
 assert.equal(r.length,1);assert.equal(r[0].id,'old');assert.equal(r[0].abstract_status,'available');assert.equal(r[0].analysis_status,'pending');assert.equal(r[0].abstract_source,'official_page');
 assert.equal(JSON.parse(r[0].source_evidence_json).abstract_policy,'publisher public page');
 const t2=transport(site);await cn.collectJournal(entry,{read:t2.read});
 assert.ok(!t2.calls.includes(URL1),'finished articles are not fetched again');
});
test('a page without an abstract is recorded as a source gap; a failed fetch is not',async()=>{
 const u2='https://rkyj.ruc.edu.cn/CN/Y2025/V49/I1/3',u3='https://rkyj.ruc.edu.cn/CN/Y2025/V49/I1/9';
 const noAbs=page.replace(/id="collapseOne"/,'id="none"').replaceAll('再生育计划的双重驱动因素','另一篇无摘要文章');
 const t=transport({...site,[entry.base+'/CN/volumn/volumn_1.shtml']:`<a href="${u2}"><a href="${u3}">`,[u2]:noAbs});
 const r=await cn.collectJournal(entry,{read:t.read});
 assert.equal(r.noAbstract,1);assert.equal(r.failed,1);
 const row=db.prepare('SELECT abstract_status,source_evidence_json e FROM articles WHERE url=?').get(u2);
 assert.equal(row.abstract_status,'missing');assert.equal(JSON.parse(row.e).abstract_gap,'publisher_page_has_no_abstract');
 assert.equal(db.prepare('SELECT 1 FROM articles WHERE url=?').get(u3),undefined);
});
test('articles older than the window are skipped without a request',async()=>{
 const old='https://rkyj.ruc.edu.cn/CN/Y2003/V27/I1/3';
 const t=transport({...site,[entry.base+'/CN/volumn/volumn_1.shtml']:`<a href="${old}">`});
 const r=await cn.collectJournal(entry,{read:t.read});
 assert.equal(r.skippedOld,1);assert.ok(!t.calls.includes(old));
});
test('a changed index layout is a visible failure, not an empty success',async()=>{
 const t=transport({[entry.base+'/CN/article/showOldVolumn.do']:'<html></html>'});
 await assert.rejects(cn.collectJournal(entry,{read:t.read}),e=>e.code==='ingest_layout_changed');
});
test('registry: the four priority journals are scheduled, the other 18 are not',()=>{
 assert.equal(CHINESE_STATUS.journals.length,22);
 assert.deepEqual(eligibleChineseJournals().sort(),['candidate-1','candidate-10','candidate-7','public-admin-cn']);
 assert.equal(CHINESE_STATUS.journals.filter(j=>!j.adapter&&['A','B'].includes(j.status)).length,0);
});
