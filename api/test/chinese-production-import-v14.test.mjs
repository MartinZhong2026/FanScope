import test,{after,afterEach} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-cn-production-'));const file=path.join(dir,'target.sqlite');process.env.DATABASE_PATH=file;process.env.DEEPSEEK_API_KEY='';process.env.RESEND_API_KEY='';
const {db}=await import('../src/db.mjs');
const ids=['candidate-1','candidate-7'];const journals=db.prepare("SELECT id,title,market FROM journals WHERE id IN ('candidate-1','candidate-7') ORDER BY id").all().map((j,i)=>({...j,issn:['1000-6087','1004-8804'][i]}));
function row(n,j=0){return {id:'synthetic-'+n,journal_id:ids[j],market:'chinese',demo:0,title:'合成导入测试 '+n,authors:n===0?'':'Synthetic author',publication_date:'2026-01-02',date_precision:'day',doi:'',url:'https://example.invalid/paper/'+n,abstract:'',source:'official_catalog',issns:[journals[j].issn],source_evidence:{url:'https://example.invalid/paper/'+n,syntheticTest:true}};}
function run(records,{sha='auto'}={}){const data=JSON.stringify({schemaVersion:1,authorization:{kind:'user_confirmation',statement:'Synthetic local test authorization'},journals,records});const p=path.join(dir,'input-'+crypto.randomUUID()+'.json');fs.writeFileSync(p,data);const digest=sha==='auto'?crypto.createHash('sha256').update(data).digest('hex'):sha;return spawnSync(process.execPath,['--experimental-sqlite','src/chinese-production-import.mjs','--db='+file,'--package='+p,'--sha256='+digest,'--apply'],{cwd:path.resolve(import.meta.dirname,'..'),env:process.env,encoding:'utf8'});}
afterEach(()=>{db.exec("DELETE FROM analysis_batch_items;DELETE FROM analysis_batches;DELETE FROM articles;DELETE FROM meta WHERE key LIKE 'cn-production-import:%';");db.prepare("UPDATE journals SET issn='' WHERE id IN ('candidate-1','candidate-7')").run();});
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});

test('multiple import batches commit atomically, preserve English AI/history and audit raw fields; repeat adds zero',()=>{
 db.prepare("INSERT INTO articles(id,journal_id,market,title,discovered_at,source,analysis_status,analysis_json) VALUES('original','jmir','international','Original','2026-01-01','crossref','analyzed','{\"preserve\":true}')").run();const original=db.prepare("SELECT * FROM articles WHERE id='original'").get();
 db.prepare("INSERT INTO analysis_batches(id,created_at,status,filter_json,total) VALUES('legacy','2026-01-01','paused','{}',0)").run();
 const rows=Array.from({length:205},(_,i)=>row(i,i===204?1:0));const first=run(rows);assert.equal(first.status,0,first.stderr);const a=JSON.parse(first.stdout);assert.equal(a.added,205);assert.equal(a.journalIssnsFilled,2);assert.equal(a.protectedDataUnchanged,true);
 const again=run(rows);assert.equal(again.status,0,again.stderr);assert.equal(JSON.parse(again.stdout).added,0);assert.equal(JSON.parse(again.stdout).duplicates,205);
 assert.deepEqual(db.prepare("SELECT * FROM articles WHERE id='original'").get(),original);assert.equal(db.prepare("SELECT status FROM analysis_batches WHERE id='legacy'").get().status,'paused');
 const audit=db.prepare("SELECT value FROM meta WHERE key LIKE 'cn-production-import:%:record:synthetic-0' LIMIT 1").get();assert.equal(JSON.parse(audit.value).original.authors,'');assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});
test('later DOI conflict rolls back earlier batches and ISSN changes without touching English',()=>{
 db.prepare("INSERT INTO articles(id,journal_id,market,title,doi,discovered_at,source) VALUES('foreign','jmir','international','Original','10.9999/conflict','2026-01-01','crossref')").run();
 const rows=Array.from({length:151},(_,i)=>row(i));rows[150].doi='10.9999/conflict';
 const result=run(rows);assert.notEqual(result.status,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM articles WHERE market='chinese'").get().n,0);assert.equal(db.prepare("SELECT issn FROM journals WHERE id='candidate-1'").get().issn,'');assert.equal(db.prepare("SELECT COUNT(*) n FROM meta WHERE key LIKE 'cn-production-import:%'").get().n,0);assert.equal(db.prepare("SELECT title FROM articles WHERE id='foreign'").get().title,'Original');
});
test('mismatched checksum, invalid row and foreign market fail before any import',()=>{
 assert.notEqual(run([row(0)],{sha:'wrong'}).status,0);assert.notEqual(run([{...row(0),market:'international'}]).status,0);assert.notEqual(run([{...row(0),title:'目录'}]).status,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM articles').get().n,0);
});
