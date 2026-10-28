import test from 'node:test';import path from 'node:path';import os from 'node:os';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';
test('v1.2 fixture migrates twice without changing original papers, journal configuration or Lab records',()=>{
const root=path.resolve(import.meta.dirname,'../..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-v13-migration-')),file=path.join(dir,'qa.sqlite');
try{
const env={...process.env,DATABASE_PATH:file,SCAN_ON_START:'false',DEEPSEEK_API_KEY:'',RESEND_API_KEY:''};
const boot=()=>execFileSync(process.execPath,['--experimental-sqlite','--input-type=module','-e',`await import(${JSON.stringify(new URL('../src/lab.mjs',import.meta.url).href)});`],{env,stdio:'pipe'});
let d=new DatabaseSync(file);d.exec(fs.readFileSync(new URL('./fixtures/v12-schema.sql',import.meta.url),'utf8'));d.exec('PRAGMA foreign_keys=ON');
for(let i=0;i<120;i++)d.prepare(`INSERT INTO articles(id,journal_id,market,title,doi,abstract,publication_date,discovered_at,source,analysis_status,analysis_json,ai_summary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('migration-'+i,'jmir','international','Synthetic paper '+i,'10.9999/migration-'+i,'Synthetic abstract retained verbatim '+i+' with sufficiently long cohort methods evidence.','2025-06-01','2026-01-01','crossref',i<40?'analyzed':i<80?'pending':'insufficient_abstract',i<40?JSON.stringify({study_design:'cohort',summary_zh:'原有 AI 结果 '+i}):null,i<40?'原有摘要 '+i:'');
for(let i=0;i<3;i++)d.prepare('INSERT INTO lab_users(id,name,email,role,password_hash,created_at) VALUES(?,?,?,?,?,?)').run('user-'+i,'QA user '+i,`qa-${i}@example.org`,i===0?'mentor':'member','synthetic-unchanged-hash','2026-01-01');
for(let i=0;i<2;i++){
 d.prepare('INSERT INTO lab_projects(id,title,summary,status,next_step,updated_at,created_by) VALUES(?,?,?,?,?,?,?)').run('project-'+i,'QA Project '+i,'Keep summary','active','Keep next step','2026-01-01','user-0');
 d.prepare('INSERT INTO lab_manuscripts(id,title,owner_id,project_id,status,updated_at,created_by) VALUES(?,?,?,?,?,?,?)').run('manuscript-'+i,'QA manuscript '+i,'user-1','project-'+i,'submitted','2026-01-01','user-0');
}
d.exec("UPDATE journals SET enabled=0,source='manual',issn='2096-3211',checkpoint='2026-01-01' WHERE id='jmir'; INSERT INTO journals(id,title,market,source,enabled,issn) VALUES('custom-qa','QA Custom','international','crossref',1,'1353-8292');");
const tables=['articles','journals','lab_users','lab_projects','lab_manuscripts','analysis_batches','analysis_batch_items','analysis_usage_log','journal_backfill_jobs','journal_discovery_jobs'];
const exists=t=>d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const counts=()=>Object.fromEntries(tables.map(t=>[t,exists(t)?d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n:null]));
const retained=tables.slice(0,5),snap=Object.fromEntries(retained.map(t=>[t,d.prepare(`SELECT * FROM ${t} ORDER BY id`).all()]));const before=counts();
d.prepare('VACUUM INTO ?').run(path.join(dir,'pre-v13.sqlite'));d.close();
for(let i=0;i<2;i++)boot();
d=new DatabaseSync(file);const after=counts();
for(const t of retained){const keys=Object.keys(snap[t][0]);assert.deepEqual(d.prepare(`SELECT ${keys.join(',')} FROM ${t} ORDER BY id`).all().filter(r=>t!=='journals'||snap[t].some(old=>old.id===r.id)),snap[t],t+' preserves every v1.2 field');}
assert.equal(d.prepare("SELECT COUNT(*) n FROM articles WHERE analysis_status='analyzed' AND length(analysis_input_hash)=64").get().n,40);
assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(d.prepare('PRAGMA foreign_key_check').all().length,0);
const out={baseline:'13e7d6c5d76952ba9e7002fcbd3bdf42a4e2aaad',migrations:2,before,after,legacyAnalyzed:40,integrity:'ok',foreignKeyViolations:0,allOriginalFieldsPreserved:true};
const addedJournals=JSON.parse(fs.readFileSync(new URL('../config/journals.json',import.meta.url))).filter(j=>!snap.journals.some(old=>old.id===j.id)).length;
assert.deepEqual(after,{...before,journals:before.journals+addedJournals,analysis_batches:0,analysis_batch_items:0,analysis_usage_log:0,journal_backfill_jobs:0,journal_discovery_jobs:0});d.close();
}finally{fs.rmSync(dir,{recursive:true,force:true})}
});
