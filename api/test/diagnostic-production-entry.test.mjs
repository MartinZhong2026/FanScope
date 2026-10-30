// Paper Diagnostic through the REAL production entry (src/v14-server.mjs), not
// makeServer(): the entry blocks most writes and clears the batch AI key, so
// tests against server.mjs alone cannot show the feature works in production.
// Never starts a run: no model call is possible here.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';
const apiRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-dx-entry-'));
const dbFile=path.join(dir,'prod.sqlite');
const base={...process.env,NODE_ENV:'test',DATABASE_PATH:dbFile,RESEND_API_KEY:'',OPENALEX_API_KEY:'',FANSCOPE_LOG_DIR:path.join(dir,'logs')};
const seed=`const {db}=await import('./src/db.mjs');await import('./src/server.mjs');const {createUser,login}=await import('./src/lab.mjs');
createUser({name:'Student',email:'student@example.edu',role:'member',password:'Synthetic-Password-123'});
console.log(login('student@example.edu','Synthetic-Password-123').token);db.close();`;
const token=execFileSync(process.execPath,['--experimental-sqlite','--input-type=module','-e',seed],{cwd:apiRoot,env:{...base,DEEPSEEK_API_KEY:''},encoding:'utf8'}).trim().split('\n').pop();
const children=[];
after(()=>{for(const c of children)c.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200})});

async function start(env){
 const port=20000+Math.floor(Math.random()*20000);
 const child=spawn(process.execPath,['--experimental-sqlite','src/v14-server.mjs'],{cwd:apiRoot,stdio:'ignore',
  env:{...base,NODE_ENV:'production',FANSCOPE_V14_RUNTIME:'true',FANSCOPE_AI_AUTO_ENABLED:'false',FANSCOPE_ENGLISH_MONITOR:'false',ADMIN_KEY:'synthetic-entry-test-admin-key-000',
   DEEPSEEK_API_KEY:'synthetic-batch-key-must-be-cleared',PORT:String(port),...env}});
 children.push(child);
 const url=`http://127.0.0.1:${port}`;
 for(let i=0;i<100;i++){try{if((await fetch(url+'/api/health')).ok)return {url,child}}catch{}await new Promise(r=>setTimeout(r,100))}
 throw Error('v14 entry did not start');
}
const upload=url=>fetch(url+'/api/diagnostic/submissions',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'text/plain','X-File-Name':'synthetic.txt'},body:'合成稿件：用于验证生产入口放行上传。'.repeat(20)});

test('enabled: production entry accepts diagnostic writes, keeps batch AI off, reports the engine',async()=>{
 const {url,child}=await start({FANSCOPE_DIAGNOSTIC_ENABLED:'true',FANSCOPE_DIAGNOSTIC_PROVIDER:'deepseek',FANSCOPE_DIAGNOSTIC_DEEPSEEK_API_KEY:'synthetic-diagnostic-key'});
 const h=await(await fetch(url+'/api/health')).json();
 assert.equal(h.aiConfigured,false,'batch AI key must stay cleared');
 assert.deepEqual(h.diagnostic,{enabled:true,engine:'deepseek',aiConfigured:true});
 assert.equal((await upload(url)).status,201,'upload must reach the diagnostic route');
 const blocked=await fetch(url+'/api/lab/projects',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}'});
 assert.equal(blocked.status,503,'other writes stay blocked');
 child.kill('SIGKILL');
});
test('disabled (default): diagnostic writes stay blocked and no engine is reported',async()=>{
 const {url,child}=await start({FANSCOPE_DIAGNOSTIC_ENABLED:'false',FANSCOPE_DIAGNOSTIC_DEEPSEEK_API_KEY:''});
 assert.equal((await upload(url)).status,503);
 assert.equal((await(await fetch(url+'/api/health')).json()).diagnostic.aiConfigured,false);
 child.kill('SIGKILL');
});
