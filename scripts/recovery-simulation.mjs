// Synthetic-only recovery audit. Run in a network-isolated container; never open a supplied database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

if(process.env.FANSCOPE_ISOLATED_SIMULATION!=='yes')throw Error('Explicit isolated simulation required');
if(fs.existsSync(fileURLToPath(new URL('../api/.env',import.meta.url))))throw Error('Refuse environment-owned credentials');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-recovery-synthetic-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_PATH:path.join(dir,'test.sqlite'),SCAN_ON_START:'false',
 DEEPSEEK_API_KEY:'synthetic-deepseek',RESEND_API_KEY:'synthetic-resend',OPENALEX_API_KEY:'',
 EMAIL_FROM:'FanScope <mock@example.invalid>',PUBLIC_API_URL:'https://fan.example.invalid',ADMIN_KEY:'synthetic-admin-key-not-production'});
let aiCalls=0,mailCalls=0;
globalThis.fetch=async input=>{
 const url=String(input);
 if(url==='https://api.deepseek.com/chat/completions'){aiCalls++;throw Error('simulated ambiguous provider failure');}
 if(url==='https://api.resend.com/emails'){mailCalls++;return new Response('{"id":"synthetic-mail"}',{status:200});}
 throw Error('Unexpected network request in simulation');
};
const {db}=await import('../api/src/db.mjs');
const {createBatch,changeBatch,recoverBatches,workBatchTick}=await import('../api/src/analysis-batches.mjs');
const {urgentDispatch}=await import('../api/src/mail.mjs');
try{
 const add=db.prepare('INSERT INTO articles(id,journal_id,market,title,abstract,publication_date,discovered_at,source,topics,matched) VALUES(?,?,?,?,?,?,?,?,?,?)');
 const abstract='A purely synthetic abstract that contains enough characters for testing the paid analysis queue without calling a real provider.';
 for(const id of ['synthetic-uncertain','synthetic-queued'])add.run(id,'jmir','international',id,abstract,'2026-01-01',new Date().toISOString(),'synthetic','[]',1);
 const batch=createBatch({policy:'custom',yearFrom:2026,yearTo:2026,limit:2});
 changeBatch(batch.id,'start');
 db.prepare("UPDATE articles SET analysis_status='analyzing' WHERE id='synthetic-uncertain'").run();
 db.prepare("UPDATE analysis_batch_items SET status='running' WHERE batch_id=? AND article_id='synthetic-uncertain'").run(batch.id);
 db.prepare("INSERT INTO analysis_usage_log(article_id,batch_id,model,input_tokens,output_tokens,cost_cny,created_at,status) VALUES(?,?,?,0,0,0,?,'uncertain')").run('synthetic-uncertain',batch.id,'synthetic-model',new Date().toISOString());
 recoverBatches();
 const uncertainState=db.prepare("SELECT analysis_status,analysis_error FROM articles WHERE id='synthetic-uncertain'").get();
 assert.equal(uncertainState.analysis_status,'failed');assert.equal(uncertainState.analysis_error,'DeepSeek request_uncertain');
 assert.equal(db.prepare('SELECT status FROM analysis_batches WHERE id=?').get(batch.id).status,'running');
 await workBatchTick(2);
 assert.equal(aiCalls,1,'The old running batch should demonstrate one simulated new request');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM analysis_usage_log WHERE article_id='synthetic-uncertain'").get().n,1,'Uncertain item must not automatically retry');

 db.prepare("INSERT INTO subscribers(id,email,topics,markets,urgent,daily,confirmed,created_at) VALUES('synthetic-sub','test@example.invalid','[]','[\"international\"]',1,0,1,?)").run(new Date().toISOString());
 add.run('synthetic-mail-paper','jmir','international','Synthetic paper',abstract,'2026-01-01',new Date().toISOString(),'synthetic','[]',1);
 db.exec("CREATE TRIGGER simulate_delivery_commit_failure BEFORE INSERT ON deliveries BEGIN SELECT RAISE(FAIL,'synthetic ledger failure'); END");
 const oldError=console.error;console.error=()=>{};
 try{await urgentDispatch(['synthetic-mail-paper']);await urgentDispatch(['synthetic-mail-paper']);}finally{console.error=oldError;}
 assert.equal(mailCalls,2,'Accepted mail can be resent when ledger writes fail');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM deliveries WHERE subscriber_id='synthetic-sub'").get().n,0);
 db.exec('DROP TRIGGER simulate_delivery_commit_failure');
 await urgentDispatch(['synthetic-mail-paper']);await urgentDispatch(['synthetic-mail-paper']);
 assert.equal(mailCalls,3,'A persisted successful delivery prevents a normal duplicate');
 console.log(JSON.stringify({isolated:true,externalNetworkUsed:false,syntheticOnly:true,
  ai:{uncertainItemRetriedAutomatically:false,oldRunningBatchContinued:true,simulatedNewProviderCalls:aiCalls},
  email:{providerAcceptedBeforeLedgerFailures:2,normalPersistedDeliveryDeduplicated:true},
  productionReadyForAutomaticRecovery:false},null,2));
}finally{db.close();}
