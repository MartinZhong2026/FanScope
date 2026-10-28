import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';

test('fresh processes resume AI/cache, backfill cursor and discovery without losing committed progress',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-restart-')),file=path.join(dir,'qa.sqlite');
 const env={...process.env,DATABASE_PATH:file,SCAN_ON_START:'false',AUTO_AI_ANALYSIS:'false',DEEPSEEK_API_KEY:'mock-only',MAX_AI_DAILY:'100',AI_INPUT_CNY_PER_M_TOKENS:'1',AI_OUTPUT_CNY_PER_M_TOKENS:'4'};
 const src=new URL('../src',import.meta.url).href;
 const common=`import assert from 'node:assert/strict';const {db}=await import(${JSON.stringify(src+'/db.mjs')});const batches=await import(${JSON.stringify(src+'/analysis-batches.mjs')});const fills=await import(${JSON.stringify(src+'/journal-backfill.mjs')});const discovery=await import(${JSON.stringify(src+'/journal-discovery.mjs')});const {insertArticle}=await import(${JSON.stringify(src+'/monitor.mjs')});`;
 const run=code=>execFileSync(process.execPath,['--experimental-sqlite','--input-type=module','-e',common+code],{env,encoding:'utf8'});
 try{
  const state=JSON.parse(run(`
   insertArticle({id:'resume-article',journal_id:'jmir',market:'international',title:'Synthetic restart paper',abstract:'A synthetic cohort of 500 persons was followed using survival analysis. Used only for restart acceptance tests.',publication_date:'2025-01-01'});
   const b=batches.createBatch({policy:'custom',yearFrom:2025,yearTo:2026,costLimitCny:1});batches.changeBatch(b.id,'start');
   db.prepare("UPDATE analysis_batch_items SET status='running' WHERE batch_id=?").run(b.id);
   const f=fills.createBackfill({journalId:'ageing-society',yearFrom:2025,yearTo:2026});fills.changeBackfill(f.id,'start');
   await fills.workBackfillTick({maxPages:1,request:async()=>({message:{'total-results':2,'next-cursor':'saved-cursor',items:[{DOI:'10.9999/resume-a',type:'journal-article',title:['QA first page'],published:{'date-parts':[[2025,1,2]]},ISSN:['1469-1779'],'container-title':['Ageing & Society']}]}})});
   const d=discovery.queueJournalDiscoveries({ids:['candidate-21']}).items[0];discovery.updateJournalDiscovery(d.id,'start');db.prepare("UPDATE journal_discovery_jobs SET status='running' WHERE id=?").run(d.id);
   console.log(JSON.stringify({batch:b.id,fill:f.id,discovery:d.id,window:fills.getBackfill(f.id).window_start}));db.close();
  `));
  const result=JSON.parse(run(`
   const state=${JSON.stringify(state)};batches.recoverBatches();discovery.recoverJournalDiscoveries();
   assert.equal(discovery.getJournalDiscoveries().items[0].status,'queued');
   let ai=0;globalThis.fetch=async()=>{ai++;return new Response(JSON.stringify({choices:[{message:{content:'{}'}}],usage:{prompt_tokens:100,completion_tokens:50}}))};await batches.workBatchTick(5);assert.equal(ai,1);
   const copy=batches.createBatch({policy:'custom',yearFrom:2025,yearTo:2026,costLimitCny:1});batches.changeBatch(copy.id,'start');await batches.workBatchTick(5);assert.equal(ai,1);
   const before=fills.getBackfill(state.fill);assert.equal(before.pages_done,1);assert.equal(before.added_articles,1);
   let requested=0;await fills.workBackfillTick({maxPages:1,request:async url=>{requested++;const u=new URL(url);assert.equal(u.searchParams.get('cursor'),'saved-cursor');assert.ok(u.searchParams.get('filter').includes(before.window_start.slice(0,19)));return {message:{'total-results':2,items:[{DOI:'10.9999/resume-a',type:'journal-article',title:['duplicate retained'],published:{'date-parts':[[2025,1,2]]}}]}}}});
   const after=fills.getBackfill(state.fill);assert.equal(after.added_articles,1);assert.equal(after.pages_done,2);assert.equal(requested,1);assert.equal(ai,1);
   assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');console.log(JSON.stringify({aiCalls:ai,pages:after.pages_done,uniqueBackfill:after.added_articles,discovery:'queued'}));db.close();
  `));
  assert.deepEqual(result,{aiCalls:1,pages:2,uniqueBackfill:1,discovery:'queued'});
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
