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
const site={[entry.home]:'<html></html>',[entry.base+'/CN/article/showOldVolumn.do']:'<a href="../volumn/volumn_1.shtml">',[entry.base+'/CN/volumn/volumn_1.shtml']:`<a href="${URL1}">`,[URL1]:page};

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
test('the current issue, listed only on the home page, is collected',async()=>{
 const current='https://rkyj.ruc.edu.cn/CN/Y2026/V50/I6/1';
 const fresh=page.replaceAll('再生育计划的双重驱动因素','当前期新论文');
 const t=transport({...site,[entry.home]:`<a href="${current}">`,[current]:fresh});
 const r=await cn.collectJournal(entry,{read:t.read});
 assert.equal(r.added,1);
 assert.equal(db.prepare('SELECT abstract_status s FROM articles WHERE url=?').get(current).s,'available');
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
test('whole-issue PDF entries are not papers',async()=>{
 const {chineseNonPaper}=await import('../src/chinese-ingestion.mjs');
 assert.ok(chineseNonPaper({title:'《社会》2016年第1期整期全文'}));
 assert.ok(!chineseNonPaper({title:'社会学研究的整期全文分析方法'}));
});
test('a changed index layout is a visible failure, not an empty success',async()=>{
 const t=transport({[entry.home]:'<html></html>',[entry.base+'/CN/article/showOldVolumn.do']:'<html></html>'});
 await assert.rejects(cn.collectJournal(entry,{read:t.read}),e=>e.code==='ingest_layout_changed');
});
test('SciOpen: the official archive finds articles Crossref does not have, without duplicates',async()=>{
 const e={title:'公共管理评论',issn:'2096-7713',journal_id:'public-admin-cn',adapter:'sciopen',base:'https://www.sciopen.com',home:'https://www.sciopen.com/journal/2096-7713',journal_key:'9',doi_prefix:'10.26599/cpar'};
 const doi='10.26599/cpar.2025.9680201',page=`https://www.sciopen.com/article/${doi.toUpperCase()}`,archive='https://www.sciopen.com/journal/join_journal/archive?journalId=9&issn=2096-7713';
 const abstract='&lt;p&gt;'+'Hierarchical escalation is a recurrent organizational phenomenon in public administration. '.repeat(2)+'&lt;/p&gt;';
 const article=`<meta name="citation_doi" content="${doi.toUpperCase()}"/><meta name="citation_title" content="Hierarchical Escalation"/><meta name="citation_volume" content="7"/><meta name="citation_issue" content="2"/><meta name="citation_publication_date" content="2025/6/1"/><meta name="citation_author" content="Zhichao LI"/><meta name="citation_author" content="Xiang YU"/><meta name="Description" content="${abstract}"/>`;
 const t=transport({[archive]:'<a href="x?volume=2025&amp;issn=1">',[archive+'&volume=2025']:'<a href="y?issueIndex=77">',['https://www.sciopen.com/journal/join_journal/stage_page?stage=5&id=9&issn=2096-7713&issueIndex=77']:`${doi.toUpperCase()} 10.26599/OTHER.2025.9680201`,[page]:article});
 const r=await cn.collectJournal(e,{read:t.read,json:async()=>{throw Error('HTTP 404')}});
 assert.equal(r.added,1);assert.equal(r.abstracts,1);
 const row=db.prepare('SELECT * FROM articles WHERE journal_id=? AND lower(doi)=?').get('public-admin-cn',doi);
 assert.equal(row.authors,'Zhichao LI, Xiang YU');assert.equal(row.publication_date_partial,'2025-06');assert.equal(row.abstract_source,'sciopen');assert.ok(!/<|&lt;/.test(row.abstract));
 const again=await cn.collectJournal(e,{read:t.read,json:async()=>{throw Error('HTTP 404')}});
 assert.equal(again.added,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM articles WHERE journal_id=?').get('public-admin-cn').n,1);
});
test('SciOpen: a page for another article is refused',()=>{
 assert.throws(()=>cn.sciopenArticle('<meta name="citation_doi" content="10.26599/CPAR.2025.1"/>','10.26599/cpar.2025.2'),e=>e.code==='ingest_identity_mismatch');
});
test('registry: the four priority journals are scheduled, the other 18 are not',()=>{
 assert.equal(CHINESE_STATUS.journals.length,22);
 assert.deepEqual(eligibleChineseJournals().sort(),['candidate-1','candidate-10','candidate-7','public-admin-cn']);
 assert.equal(CHINESE_STATUS.journals.filter(j=>!j.adapter&&['A','B'].includes(j.status)).length,0);
});
