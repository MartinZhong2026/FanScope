import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';import {once} from 'node:events';import {pathToFileURL} from 'node:url';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-staged-test-'));
Object.assign(process.env,{NODE_ENV:'production',DATABASE_PATH:path.join(dir,'test.sqlite'),ADMIN_KEY:'synthetic-admin-only-long-enough',DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:'',SCAN_ON_START:'false',ALLOWED_ORIGINS:'https://synthetic.example.invalid'});
const {db}=await import('../src/db.mjs');
const {makeServer}=await import('../src/server.mjs');
const {scanAll}=await import('../src/monitor.mjs');
const {createUser}=await import('../src/lab.mjs');
const {createStagedRecoveryServer,runEnglishMonitor}=await import('../src/staged-recovery-server.mjs');
let server;
after(async()=>{if(server)await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});

test('staged HTTP restores Lab login while unsafe write paths and Chinese management stay closed',async()=>{
 createUser({name:'Synthetic',email:'synthetic@example.invalid',password:'Synthetic-password-2026',role:'mentor'});
 server=createStagedRecoveryServer(makeServer);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const login=await fetch(base+'/api/lab/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'synthetic@example.invalid',password:'Synthetic-password-2026'})});
 assert.equal(login.status,200);const {token}=await login.json();
 assert.equal((await fetch(base+'/api/lab/me',{headers:{Authorization:`Bearer ${token}`}})).status,200);
 for(const p of ['/api/admin/analyze','/api/admin/scan','/api/admin/analysis-batches','/api/subscriptions/request','/api/lab/documents'])assert.equal((await fetch(base+p,{method:'POST',headers:{'X-Admin-Key':process.env.ADMIN_KEY,Authorization:`Bearer ${token}`},body:'{}'})).status,503,p);
 const denied=await fetch(base+'/api/admin/analyze',{method:'POST',headers:{Origin:'https://synthetic.example.invalid'},body:'{}'});assert.equal(denied.headers.get('access-control-allow-origin'),'https://synthetic.example.invalid');
 assert.equal((await fetch(base+'/api/admin/chinese-imports/catalog')).status,404);
 assert.equal((await fetch(base+'/api/admin/chinese-jobs',{method:'POST',headers:{'X-Admin-Key':process.env.ADMIN_KEY},body:'{}'})).status,404);
 assert.equal((await fetch(base+'/api/health')).status,200);
});

test('scheduled monitoring targets only enabled English journals and never runs queued work',async()=>{
 db.prepare('UPDATE journals SET enabled=0').run();
 const english=['jmir','ssm'].sort();
 const other=db.prepare("SELECT id FROM journals WHERE market='international' AND id NOT IN ('jmir','ssm') ORDER BY id LIMIT 2").all().map(x=>x.id);
 const chinese=db.prepare("SELECT id FROM journals WHERE market='chinese' ORDER BY id LIMIT 1").get().id;
 for(const id of [...english,...other,chinese])db.prepare('UPDATE journals SET enabled=1 WHERE id=?').run(id);
 for(const id of [...english,other[0]])db.prepare('UPDATE journals SET checkpoint=? WHERE id=?').run('2026-01-01T00:00:00.000Z',id);
 db.prepare("UPDATE journals SET checkpoint=NULL WHERE id=?").run(other[1]);
 db.prepare("INSERT INTO scan_windows(journal_id,mode,range_end,window_start,window_end,cursor,status,updated_at) VALUES(?,'backfill','2026-01-01','2025-01-01','2025-01-02','*','paused','2026-01-01')").run(other[0]);
 const calls=[];const results=await runEnglishMonitor(db,async x=>{calls.push(x.journalId);return {status:'ok'};});
 assert.deepEqual(calls,english);assert.equal(results.length,2);assert.ok(!calls.includes(chinese));
});

test('English monitor uses mocked Crossref, deduplicates and does not fetch the enabled Chinese journal',async()=>{
 for(const id of ['jmir','ssm'])db.prepare('UPDATE journals SET checkpoint=? WHERE id=?').run(new Date(Date.now()-3600000).toISOString(),id);
 const originalFetch=globalThis.fetch,requests=[];
 globalThis.fetch=async input=>{
  const url=String(input);requests.push(url);assert.match(url,/^https:\/\/api\.crossref\.org\/journals\//);
  const issn=url.match(/\/journals\/([^/]+)\/works/)?.[1];assert.ok(issn);
  return new Response(JSON.stringify({message:{items:[{DOI:`10.9999/synthetic-${issn}`,title:['Synthetic health and caregiver study'],type:'journal-article',published:{'date-parts':[[2026,10,24]]},author:[{given:'Synthetic',family:'Author'}]}]}}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 try{
  const first=await runEnglishMonitor(db,scanAll),count=db.prepare("SELECT COUNT(*) n FROM articles WHERE market='international'").get().n;
  assert.equal(first.length,2);assert.ok(first.every(x=>x.result.status==='ok'));assert.equal(count,2);
  const second=await runEnglishMonitor(db,scanAll);assert.ok(second.every(x=>x.result.status==='ok'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM articles WHERE market='international'").get().n,2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM articles WHERE market='chinese'").get().n,0);
  assert.ok(requests.length>=2);
 }finally{globalThis.fetch=originalFetch;}
});

test('pilot startup does not recover a running AI batch or launch outbound requests',async()=>{
 db.prepare("INSERT INTO analysis_batches(id,created_at,status,filter_json,total) VALUES('synthetic-old-running','2026-01-01','running','{}',1)").run();
 const guard=path.join(dir,'guard.mjs');fs.writeFileSync(guard,"globalThis.setInterval=(fn,ms)=>{if(ms<1800000)throw Error('Unexpected worker timer');return {unref(){}}};globalThis.fetch=()=>{throw Error('Unexpected outbound call')};");
 const child=spawn(process.execPath,['--import',pathToFileURL(guard).href,'src/staged-recovery-server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,FANSCOPE_STAGED_RECOVERY:'true',FANSCOPE_ENGLISH_MONITOR:'true',PORT:'0'},stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout '+errors)),10000);child.stdout.on('data',()=>{if(output.includes('\n')){clearTimeout(timer);resolve();}});child.once('exit',c=>{clearTimeout(timer);reject(Error('startup exit '+c+' '+errors));});});
  const info=JSON.parse(output.trim());assert.equal(info.englishMonitor,true);assert.equal(info.historyWorkers,false);assert.equal(info.paid,false);assert.equal(info.mail,false);
  assert.equal(db.prepare("SELECT status FROM analysis_batches WHERE id='synthetic-old-running'").get().status,'running');
 }finally{if(child.exitCode===null&&child.signalCode===null){const finished=once(child,'exit');child.kill();await finished;}}
});

test('pilot fails closed with paid credentials or a missing database',()=>{
 const cwd=path.resolve(import.meta.dirname,'..');
 const badKey=spawnSync(process.execPath,['src/staged-recovery-server.mjs'],{cwd,env:{...process.env,FANSCOPE_STAGED_RECOVERY:'true',DEEPSEEK_API_KEY:'synthetic-key'},encoding:'utf8'});
 assert.notEqual(badKey.status,0);assert.match(badKey.stderr,/credentials must remain empty/);
 const missing=path.join(dir,'not-created.sqlite');
 const noDatabase=spawnSync(process.execPath,['src/staged-recovery-server.mjs'],{cwd,env:{...process.env,FANSCOPE_STAGED_RECOVERY:'true',DATABASE_PATH:missing,DEEPSEEK_API_KEY:''},encoding:'utf8'});
 assert.notEqual(noDatabase.status,0);assert.match(noDatabase.stderr,/Existing database required/);assert.equal(fs.existsSync(missing),false);
});
