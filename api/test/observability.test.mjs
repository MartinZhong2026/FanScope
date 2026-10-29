import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-observability-test-'));
const logDir=path.join(dir,'logs');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_PATH:path.join(dir,'test.sqlite'),ADMIN_KEY:'synthetic-admin-only-long-enough',DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:'',SCAN_ON_START:'false',FANSCOPE_LOG_LEVEL:'info',FANSCOPE_LOG_DIR:logDir,FANSCOPE_COMMIT:'0123456789abcdef0123456789abcdef01234567'});
const logging=await import('../src/platform/log.mjs');
const {db}=await import('../src/db.mjs');
const {makeServer}=await import('../src/server.mjs');
const lines=[];const restore=logging.setLogSink(line=>lines.push(JSON.parse(line)));
let server;
after(async()=>{logging.setLogSink(restore);if(server)await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});
const secret='sk-synthetic-only-0123456789';

test('redaction removes credentials and replaces research content with length and hash',()=>{
 const out=logging.redact({apiKey:secret,'X-Admin-Key':'synthetic-admin-only-long-enough',password:'p',input_tokens:12,output_tokens:3,
  abstract:'Unpublished manuscript text that must never reach a log line.',nested:{authorization:'Bearer abc.def',detail:`url https://api.example.org/x?api_key=${secret}&q=1 by someone@example.org`}});
 const text=JSON.stringify(out);
 for(const leaked of [secret,'synthetic-admin-only','abc.def','Unpublished manuscript','someone@'])assert.ok(!text.includes(leaked),leaked);
 assert.equal(out.input_tokens,12);assert.equal(out.output_tokens,3);
 assert.equal(out.abstract.redacted,'content');assert.equal(out.abstract.length,61);assert.match(out.abstract.sha256,/^[0-9a-f]{12}$/);
 assert.match(out.nested.detail,/api_key=\[REDACTED\]&q=1/);assert.match(out.nested.detail,/s\*\*\*@example\.org/);
 assert.equal(logging.redactString('x'.repeat(900)).length<=520,true);
});

test('error fields keep class, code, status and upstream but not secrets',()=>{
 const e=Object.assign(new Error(`HTTP 429 Bearer ${secret}`),{status:429,code:'http_429',upstream:{host:'api.crossref.org',status:429,token:secret}});
 const f=logging.errorFields(e);
 assert.equal(f.error_class,'Error');assert.equal(f.error_code,'http_429');assert.equal(f.status,429);assert.equal(f.upstream.host,'api.crossref.org');
 assert.ok(Array.isArray(f.stack)&&f.stack.length>0);assert.ok(!JSON.stringify(f).includes(secret));
 assert.equal('token' in f.upstream,false);
});

test('exception messages that may embed research text or provider bodies are hashed, not logged',()=>{
 const interview='受访者说：我在村里照顾母亲十年';
 let parseError;try{JSON.parse(interview)}catch(e){parseError=e}
 assert.ok(parseError.message.includes(interview),'precondition: V8 echoes the input');
 const f=logging.errorFields(parseError);
 assert.equal(f.message,undefined);assert.equal(f.message_redacted.length,parseError.message.length);assert.ok(!JSON.stringify(f).includes('受访者'));
 const mail=logging.errorFields(new Error('Email provider HTTP 422: {"message":"Draft: Our unpublished finding is that pension reform"}'));
 assert.equal(mail.message,undefined);assert.ok(!JSON.stringify(mail).includes('unpublished'));
 assert.equal(logging.errorFields(new Error('HTTP 503')).message,'HTTP 503');
 assert.equal(logging.errorFields(new Error('DeepSeek request_uncertain')).message,'DeepSeek request_uncertain');
 assert.equal(logging.errorFields(Object.assign(new Error('期刊身份不匹配'),{safeMessage:true})).message,'期刊身份不匹配');
 const fields=logging.redact({source_quote:'原文引用：受访者说……',note:'private note',summary:'论文摘要',journal_id:'ssm'});
 for(const k of ['source_quote','note','summary'])assert.equal(fields[k].redacted,'content',k);
 assert.equal(fields.journal_id,'ssm');
});

test('route templates collapse identifiers and request ids are validated',()=>{
 assert.equal(logging.routeTemplate('/api/admin/analysis-batches/2f1e9c4a-1b2c-4d5e-8f90-1234567890ab/start'),'/api/admin/analysis-batches/:id/start');
 assert.equal(logging.routeTemplate('/api/lab/projects/123'),'/api/lab/projects/:id');
 assert.equal(logging.requestIdFrom('client-trace-0001'),'client-trace-0001');
 assert.match(logging.requestIdFrom('bad id with spaces'),/^[0-9a-f-]{36}$/);
 assert.match(logging.requestIdFrom(''),/^[0-9a-f-]{36}$/);
});

test('HTTP responses carry X-Request-Id, errors return it, and access lines correlate',async()=>{
 server=makeServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 lines.length=0;
 const ok=await fetch(base+'/api/topics',{headers:{'X-Request-Id':'client-trace-0001'}});
 assert.equal(ok.status,200);assert.equal(ok.headers.get('x-request-id'),'client-trace-0001');
 const bad=await fetch(base+'/api/lab/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{not json'});
 assert.equal(bad.status,400);const id=bad.headers.get('x-request-id');const body=await bad.json();
 assert.match(id,/^[0-9a-f-]{36}$/);assert.equal(body.request_id,id);assert.ok(body.error);
 await new Promise(r=>setImmediate(r));
 const access=lines.filter(l=>l.event==='http.request');
 assert.ok(access.some(l=>l.request_id==='client-trace-0001'&&l.route==='/api/topics'&&l.status===200&&typeof l.duration_ms==='number'&&l.method==='GET'));
 assert.ok(access.some(l=>l.request_id===id&&l.status===400));
 assert.ok(lines.some(l=>l.event==='http.client_error'&&l.request_id===id&&l.status===400));
 for(const l of lines){assert.equal(l.commit,process.env.FANSCOPE_COMMIT);assert.ok(l.ts&&l.level&&l.service==='fanscope-api');}
});

test('health reports runtime versions, is not access-logged when healthy, and reads never write',async()=>{
 const base=`http://127.0.0.1:${server.address().port}`;
 const before=db.prepare('SELECT total_changes() AS n').get().n;lines.length=0;
 const h=await (await fetch(base+'/api/health')).json();
 for(const p of ['/api/topics','/api/journals','/api/stats?period=all','/api/research?period=90d'])assert.equal((await fetch(base+p)).status,200,p);
 assert.equal(h.status,'ok');assert.equal(h.commit,process.env.FANSCOPE_COMMIT);assert.equal(h.node,process.versions.node);
 assert.match(h.sqlite,/^\d+\.\d+\.\d+$/);assert.ok(h.schema.count>0&&typeof h.schema.latest==='string');assert.ok(h.startedAt);
 assert.equal(h.aiConfigured,false);assert.equal(h.emailConfigured,false);
 await new Promise(r=>setImmediate(r));
 assert.ok(!lines.some(l=>l.route==='/api/health'));
 // The release controller fingerprints the database after startup; logging must not write.
 assert.equal(db.prepare('SELECT total_changes() AS n').get().n,before);
});

test('warn and error lines persist to the log directory with redaction; info stays on stdout only',()=>{
 logging.log('info','test.info_only',{marker:'info-marker'});
 logging.log('notice','service.start',{marker:'notice-marker'});
 logging.log('warn','test.persisted',{marker:'warn-marker',apiKey:secret});
 const file=path.join(logDir,`fanscope-${new Date().toISOString().slice(0,10)}.jsonl`);
 const text=fs.readFileSync(file,'utf8');
 assert.ok(text.includes('warn-marker'));assert.ok(text.includes('notice-marker'));assert.ok(!text.includes('info-marker'));assert.ok(!text.includes(secret));
 if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
});

test('log retention prunes only dated FanScope files older than the window',()=>{
 const d=fs.mkdtempSync(path.join(dir,'prune-'));
 for(const n of ['fanscope-2026-01-01.jsonl','fanscope-2026-10-20.jsonl','other.txt'])fs.writeFileSync(path.join(d,n),'x');
 assert.equal(logging.pruneLogFiles(d,14,Date.parse('2026-10-29T12:00:00Z')),1);
 assert.deepEqual(fs.readdirSync(d).sort(),['fanscope-2026-10-20.jsonl','other.txt']);
});

test('logging never throws, even for circular or hostile values',()=>{
 const circular={};circular.self=circular;
 assert.doesNotThrow(()=>logging.log('warn','test.circular',{circular,big:10n,fn:()=>1}));
 assert.doesNotThrow(()=>logging.log('nonsense-level','test.ignored',{}));
});

async function freePort(){return new Promise(r=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>r(port));});});}

test('production V1.4 entry still clears the DeepSeek key before config loads and logs structured startup',async()=>{
 const childDir=fs.mkdtempSync(path.join(dir,'v14-'));const dbFile=path.join(childDir,'v14.sqlite');
 const apiRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const seeded=spawnSync(process.execPath,['--experimental-sqlite','--input-type=module','-e',"const {db}=await import('./src/db.mjs');db.close();"],{cwd:apiRoot,env:{...process.env,NODE_ENV:'test',DATABASE_PATH:dbFile},encoding:'utf8'});
 assert.equal(seeded.status,0,seeded.stderr);
 const port=await freePort();
 const child=spawn(process.execPath,['--experimental-sqlite','src/v14-server.mjs'],{cwd:apiRoot,env:{...process.env,NODE_ENV:'production',FANSCOPE_V14_RUNTIME:'true',FANSCOPE_AI_AUTO_ENABLED:'false',FANSCOPE_ENGLISH_MONITOR:'false',DEEPSEEK_API_KEY:secret,DATABASE_PATH:dbFile,PORT:String(port),FANSCOPE_LOG_LEVEL:'info',FANSCOPE_LOG_DIR:path.join(childDir,'logs')},stdio:['ignore','pipe','pipe']});
 let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
 try{
  let health;
  for(let i=0;i<100&&!health;i++){await new Promise(r=>setTimeout(r,100));try{const r=await fetch(`http://127.0.0.1:${port}/api/health`);if(r.ok)health=await r.json();}catch{}}
  assert.ok(health,`v14 did not start: ${err.slice(0,400)}`);
  assert.equal(health.aiConfigured,false);assert.equal(health.commit,process.env.FANSCOPE_COMMIT);
  const blocked=await fetch(`http://127.0.0.1:${port}/api/admin/scan`,{method:'POST',headers:{'X-Request-Id':'blocked-trace-01'}});
  assert.equal(blocked.status,503);assert.equal(blocked.headers.get('x-request-id'),'blocked-trace-01');
  await new Promise(r=>setTimeout(r,100));
  const events=out.trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
  assert.ok(events.some(e=>e.event==='service.start'&&e.entry==='v14'&&e.aiEnabled===false));
  assert.ok(events.some(e=>e.event==='http.request'&&e.request_id==='blocked-trace-01'&&e.blocked==='staged-recovery'));
  assert.ok(!(out+err).includes(secret));
 }finally{child.kill();}
});
