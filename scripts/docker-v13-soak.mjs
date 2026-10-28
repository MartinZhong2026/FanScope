import fs from 'node:fs';import assert from 'node:assert/strict';
process.env.DATABASE_PATH='/tmp/qa-soak.sqlite';process.env.DEEPSEEK_API_KEY='mock-only';process.env.AI_INPUT_CNY_PER_M_TOKENS='1';process.env.AI_OUTPUT_CNY_PER_M_TOKENS='4';process.env.MAX_AI_DAILY='2000';process.env.AUTO_AI_ANALYSIS='false';
const {db}=await import('/app/src/db.mjs');const {insertArticle}=await import('/app/src/monitor.mjs');const {researchReport}=await import('/app/src/research.mjs');const {createBatch,changeBatch,workBatchTick,batchDetail}=await import('/app/src/analysis-batches.mjs');
const abstract='A synthetic cohort of 500 persons was followed using survival analysis. '.repeat(150);
for(let i=0;i<1000;i++)insertArticle({id:'soak-'+i,journal_id:'jmir',market:'international',title:'Synthetic soak article '+i,abstract,publication_date:'2025-06-01'});
let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:'{}'}}],usage:{prompt_tokens:900,completion_tokens:220}}))};
const opts={yearFrom:2025,yearTo:2026,limit:1000,costLimitCny:10};let b=createBatch(opts);changeBatch(b.id,'start');for(let i=0;i<200;i++)await workBatchTick(5);assert.equal(batchDetail(b.id).status,'completed');assert.equal(calls,1000);
const started=Date.now(),samples=[];let cycles=0;
while(Date.now()-started<120000){b=createBatch(opts);assert.equal(b.counts.cached,1000);changeBatch(b.id,'start');for(let i=0;i<200;i++)await workBatchTick(5);assert.equal(researchReport().n,1000);assert.equal(calls,1000);cycles++;samples.push({at:Date.now()-started,rss:process.memoryUsage().rss});await new Promise(r=>setTimeout(r,3000))}
let peak=null;try{peak=Number(fs.readFileSync('/sys/fs/cgroup/memory.peak','utf8'))}catch{}
console.log(JSON.stringify({durationMs:Date.now()-started,articles:1000,requests:calls,cachedCycles:cycles,maxRss:Math.max(...samples.map(x=>x.rss)),cgroupPeak:peak,integrity:db.prepare('PRAGMA integrity_check').get().integrity_check},null,2));db.close();
