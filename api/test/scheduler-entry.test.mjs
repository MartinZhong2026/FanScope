// K5 through the REAL production entry (src/v14-server.mjs) with a real gate file.
// The fresh database has no monitored journal, so no job reaches the network.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const apiRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-k5-entry-'));
const dbFile=path.join(dir,'prod.sqlite'),gateFile=path.join(dir,'gate.json');
const base={...process.env,NODE_ENV:'test',DATABASE_PATH:dbFile,DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:'',FANSCOPE_LOG_DIR:path.join(dir,'logs')};
execFileSync(process.execPath,['--experimental-sqlite','--input-type=module','-e',"const {db}=await import('./src/db.mjs');await import('./src/server.mjs');db.close();"],{cwd:apiRoot,env:base});
const children=[];
after(()=>{for(const c of children)c.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200})});
const rows=()=>{const db=new DatabaseSync(dbFile,{readOnly:true});try{return db.prepare('SELECT name FROM scheduled_jobs ORDER BY name').all().map(r=>r.name)}finally{db.close()}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function start(){
 const port=20000+Math.floor(Math.random()*20000);
 const child=spawn(process.execPath,['--experimental-sqlite','src/v14-server.mjs'],{cwd:apiRoot,stdio:'ignore',
  env:{...base,NODE_ENV:'production',FANSCOPE_V14_RUNTIME:'true',FANSCOPE_AI_AUTO_ENABLED:'false',FANSCOPE_ENGLISH_MONITOR:'true',FANSCOPE_SCHEDULER:'true',
   FANSCOPE_RELEASE_GATE_FILE:gateFile,ADMIN_KEY:'synthetic-entry-test-admin-key-000',PORT:String(port)}});
 children.push(child);
 const url=`http://127.0.0.1:${port}`;
 for(let i=0;i<100;i++){try{if((await fetch(url+'/api/health')).ok)return {url,child}}catch{}await sleep(100)}
 throw Error('v14 entry did not start');
}

test('blocked gate: the entry serves requests with zero scheduler writes',async()=>{
 fs.writeFileSync(gateFile,JSON.stringify({state:'blocked',generation:1,reason_code:'release'}));
 const {url,child}=await start();
 await sleep(500);
 assert.deepEqual(rows(),[]);
 const f=await(await fetch(url+'/api/ingest/freshness')).json();
 assert.equal(f.scheduler,'on');assert.equal(f.gate,'release');assert.equal(f.chinese.total,22);assert.equal(f.chinese.automatic,4);
 child.kill('SIGKILL');
});
test('missing gate file behaves as closed',async()=>{
 fs.rmSync(gateFile);
 const {child}=await start();
 await sleep(500);
 assert.deepEqual(rows(),[]);
 child.kill('SIGKILL');
});
test('open gate: first tick seeds and runs jobs without any HTTP traffic to them',async()=>{
 fs.writeFileSync(gateFile,JSON.stringify({state:'open',generation:1}));
 const {child}=await start();
 let names=[];for(let i=0;i<50&&names.length<3;i++){await sleep(100);names=rows()}
 assert.deepEqual(names,['ingest:chinese','ingest:english','lifecycle:dx-purge']);
 child.kill('SIGKILL');
});
