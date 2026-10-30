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
const traceId='f789c200-496d-4af5-8eb9-df3d8e9ec305';

test('redaction removes credentials and replaces research content with length and hash',()=>{
 const out=logging.redact({apiKey:secret,'X-Admin-Key':'synthetic-admin-only-long-enough',password:'p',input_tokens:12,output_tokens:3,
  abstract:'Unpublished manuscript text that must never reach a log line.',nested:{authorization:'Bearer abc.def',detail:`url https://api.example.org/x?api_key=${secret}&q=1 by someone@example.org`}});
 const text=JSON.stringify(out);
 for(const leaked of [secret,'synthetic-admin-only','abc.def','Unpublished manuscript','someone@'])assert.ok(!text.includes(leaked),leaked);
 assert.equal(out.input_tokens,12);assert.equal(out.output_tokens,3);
 assert.equal(out.abstract.redacted,'content');assert.equal(out.abstract.length,61);assert.match(out.abstract.sha256,/^[0-9a-f]{12}$/);
 assert.ok(out.redacted_fields.length>0);assert.ok(!text.includes('q=1'));
 assert.equal(logging.redact('x'.repeat(900)).length,900);assert.ok(!JSON.stringify(logging.redact('x'.repeat(900))).includes('x'.repeat(20)));
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
 assert.equal(logging.errorFields(Object.assign(new Error('HTTP 503'),{status:503})).error_code,'http_503');
 assert.equal(logging.errorFields(Object.assign(new Error('DeepSeek request_uncertain'),{code:'request_uncertain'})).error_code,'request_uncertain');
 const marked=logging.errorFields(Object.assign(new Error('期刊身份不匹配'),{safeMessage:true}));
 assert.equal(marked.message,undefined);assert.ok(!JSON.stringify(marked).includes('期刊身份不匹配'));
 const fields=logging.redact({source_quote:'原文引用：受访者说……',note:'private note',summary:'论文摘要',journal_id:'ssm'});
 for(const k of ['source_quote','note','summary'])assert.equal(fields[k].redacted,'content',k);
 assert.equal(fields.journal_id,'ssm');
});

test('route templates collapse identifiers and request ids are validated',()=>{
 assert.equal(logging.routeTemplate('/api/admin/analysis-batches/2f1e9c4a-1b2c-4d5e-8f90-1234567890ab/start'),'/api/admin/analysis-batches/:id/start');
 assert.equal(logging.routeTemplate('/api/lab/projects/123'),'/api/lab/projects/:id');
 assert.equal(logging.requestIdFrom(traceId),traceId);
 assert.match(logging.requestIdFrom('client-trace-0001'),/^[0-9a-f-]{36}$/);
 assert.match(logging.requestIdFrom('bad id with spaces'),/^[0-9a-f-]{36}$/);
 assert.match(logging.requestIdFrom(''),/^[0-9a-f-]{36}$/);
});

const privateSamples=['Private draft finding: pension effect is negative','I hid my interview answer',
 'my_private_query','未发表稿件：养老保险改革降低家庭照护负担','访谈回答：这件事没有告诉导师'];
function noPrivate(value){const text=JSON.stringify(value);for(const sample of privateSamples)assert.ok(!text.includes(sample),sample);return text;}

test('all unknown errors are summarized, including short ASCII, safeMessage and poisoned metadata',()=>{
 for(const sample of privateSamples){
  const e=Object.assign(new Error(sample),{safeMessage:true,name:sample,code:sample,cause:{code:sample},
   upstream:{provider:sample,host:sample,code:sample,request_id:sample,retry_after:sample,status:429,attempts:3}});
  e.stack=`Error: ${sample}\n    at ${sample} (file:///private/${sample}.mjs:1:2)\n    at eval (${sample})`;
  const fields=logging.errorFields(e);
  noPrivate(fields);noPrivate(logging.redact(fields));
  assert.equal(fields.message,undefined);assert.equal(fields.message_redacted.length,sample.length);
  assert.deepEqual(fields.stack,[]);assert.equal(fields.upstream.status,429);assert.equal(fields.upstream.attempts,3);
  noPrivate(logging.errorFields(sample));
 }
});

test('nested content, arrays, generic detail and unknown keys cannot bypass the metadata schema',()=>{
 for(const sample of privateSamples){
  const value={message:sample,query:[sample,{text:sample}],messages:[{role:'user',content:sample}],
   upstream:{detail:{message:sample},status:503,host:'api.crossref.org',request_id:sample},
   stage:sample,error_code:sample,other:{[sample]:sample},[sample]:{message:sample}};
  const clean=logging.redact(value);
  noPrivate(clean);assert.equal(clean.upstream.status,503);assert.equal(clean.upstream.host,'api.crossref.org');
  assert.equal(clean.query.redacted,'content');assert.equal(clean.messages.redacted,'content');
  noPrivate(logging.redact([sample,{message:sample}]));
 }
});

test('English and Chinese JSON parse errors and nested Error objects never emit their input',()=>{
 for(const sample of privateSamples){
  let e;try{JSON.parse(sample)}catch(error){e=error}
  assert.ok(e instanceof SyntaxError);
  const fields=logging.errorFields(e);noPrivate(fields);
  assert.equal(fields.error_class,'SyntaxError');assert.equal(fields.message_redacted.length,e.message.length);
  noPrivate(logging.redact({upstream:{code:e,request_id:e},message:[e,sample]}));
 }
});

test('trusted diagnostics, safe source locations and correlation survive stdout and volume logging',()=>{
 const e=Object.assign(new Error(privateSamples[0]),{code:'scan_budget_paused',status:503,cause:{code:'ECONNRESET'},
  upstream:{provider:'crossref',host:'api.crossref.org',code:'rate_limit_exceeded',status:429,retry_after:'120',request_id:traceId,attempts:3}});
 const fields=logging.errorFields(e);assert.ok(fields.stack.some(s=>s.startsWith('test/observability.test.mjs:')));
 lines.length=0;
 logging.withRequestContext({request_id:traceId},()=>logging.log('warn','test.secure_diagnostic',{
  ...fields,job_id:17,llm_call_id:traceId,stage:'fetch',duration_ms:42,detail:{nested:privateSamples[1]}}));
 const item=lines.find(l=>l.event==='test.secure_diagnostic');
 noPrivate(item);assert.equal(item.request_id,traceId);assert.equal(item.commit,process.env.FANSCOPE_COMMIT);
 assert.equal(item.error_code,'scan_budget_paused');assert.equal(item.cause_code,'ECONNRESET');assert.equal(item.status,503);
 assert.equal(item.upstream.code,'rate_limit_exceeded');assert.equal(item.upstream.request_id,traceId);assert.equal(item.upstream.retry_after,120);
 assert.equal(item.job_id,17);assert.equal(item.llm_call_id,traceId);assert.equal(item.stage,'fetch');assert.equal(item.duration_ms,42);
 assert.deepEqual(item.stack,fields.stack);
 const file=path.join(logDir,`fanscope-${new Date().toISOString().slice(0,10)}.jsonl`);
 const persisted=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse).find(l=>l.event==='test.secure_diagnostic');
 noPrivate(persisted);assert.deepEqual(persisted,item);
});

test('mail provider failures carry HTTP and provider codes without copying provider text',async()=>{
 const {config}=await import('../src/config.mjs');const {sendMail}=await import('../src/mail.mjs');
 const before={resendKey:config.resendKey,emailFrom:config.emailFrom,apiUrl:config.apiUrl},originalFetch=globalThis.fetch;
 Object.assign(config,{resendKey:'synthetic-mail-key',emailFrom:'test@example.org',apiUrl:'https://example.org'});
 try{
  for(const body of [JSON.stringify({name:'validation_error',message:privateSamples[0]}),privateSamples[1]]){
   globalThis.fetch=async()=>new Response(body,{status:422,headers:{'x-request-id':privateSamples[2]}});
   let error;try{await sendMail('test@example.org','synthetic','synthetic')}catch(e){error=e}
   assert.ok(error);assert.equal(error.status,422);noPrivate({message:error.message,fields:logging.errorFields(error)});
   assert.equal(logging.errorFields(error).upstream.status,422);
   if(body.startsWith('{'))assert.equal(logging.errorFields(error).upstream.code,'validation_error');
  }
 }finally{globalThis.fetch=originalFetch;Object.assign(config,before);}
});

test('HTTP responses carry X-Request-Id, errors return it, and access lines correlate',async()=>{
 server=makeServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 lines.length=0;
 const ok=await fetch(base+'/api/topics',{headers:{'X-Request-Id':traceId}});
 assert.equal(ok.status,200);assert.equal(ok.headers.get('x-request-id'),traceId);
 const bad=await fetch(base+'/api/lab/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{not json'});
 assert.equal(bad.status,400);const id=bad.headers.get('x-request-id');const body=await bad.json();
 assert.match(id,/^[0-9a-f-]{36}$/);assert.equal(body.request_id,id);assert.ok(body.error);
 await new Promise(r=>setImmediate(r));
 const access=lines.filter(l=>l.event==='http.request');
 assert.ok(access.some(l=>l.request_id===traceId&&l.route==='/api/topics'&&l.status===200&&typeof l.duration_ms==='number'&&l.method==='GET'));
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
 const ledger=db.prepare("SELECT 1 FROM sqlite_master WHERE name='fanscope_migrations'").get()?db.prepare('SELECT id FROM fanscope_migrations ORDER BY id').all().map(r=>r.id):[];
 assert.deepEqual(h.migrations,{runner:1,applied:ledger.length,latest:ledger.at(-1)??null});
 assert.equal(h.aiConfigured,false);assert.equal(h.emailConfigured,false);
 await new Promise(r=>setImmediate(r));
 assert.ok(!lines.some(l=>l.route==='/api/health'));
 // The release controller fingerprints the database after startup; logging must not write.
 assert.equal(db.prepare('SELECT total_changes() AS n').get().n,before);
});

test('HTTP private queries, arbitrary path segments, malformed JSON and correlation headers stay out of access logs',async()=>{
 const base=`http://127.0.0.1:${server.address().port}`;lines.length=0;
 const r=await fetch(base+'/api/lab/login?query='+encodeURIComponent(privateSamples[0]),{method:'POST',
  headers:{'Content-Type':'application/json','X-Request-Id':privateSamples[2]},body:privateSamples[3]});
 assert.equal(r.status,400);const body=await r.json(),id=r.headers.get('x-request-id');assert.match(id,/^[0-9a-f-]{36}$/);assert.equal(body.request_id,id);
 await fetch(base+'/api/'+privateSamples[2]);
 await new Promise(r=>setImmediate(r));noPrivate(lines);
 assert.ok(lines.some(l=>l.event==='http.request'&&l.request_id===id&&l.route==='/api/lab/login'));
 assert.ok(lines.some(l=>l.route==='/api/:id'));
});

test('warn and error lines persist to the log directory with redaction; info stays on stdout only',()=>{
 logging.log('info','test.info_only',{stage:'fetch'});
 logging.log('notice','service.start',{entry:'v14'});
 logging.log('warn','test.persisted',{stage:'parse',apiKey:secret});
 const file=path.join(logDir,`fanscope-${new Date().toISOString().slice(0,10)}.jsonl`);
 const text=fs.readFileSync(file,'utf8');
 const entries=text.trim().split('\n').map(JSON.parse);
 assert.ok(entries.some(e=>e.event==='test.persisted'&&e.stage==='parse'));assert.ok(entries.some(e=>e.event==='service.start'&&e.entry==='v14'));
 assert.ok(!entries.some(e=>e.event==='test.info_only'));assert.ok(!text.includes(secret));
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
 lines.length=0;
 logging.log('warn','test.hostile_fields',{constructor:privateSamples[0],redacted_fields:privateSamples[1],password:secret});
 assert.ok(lines.some(l=>l.event==='test.hostile_fields'));noPrivate(lines);assert.ok(!JSON.stringify(lines).includes(secret));
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
  const blocked=await fetch(`http://127.0.0.1:${port}/api/admin/scan`,{method:'POST',headers:{'X-Request-Id':traceId}});
  assert.equal(blocked.status,503);assert.equal(blocked.headers.get('x-request-id'),traceId);
  await new Promise(r=>setTimeout(r,100));
  const events=out.trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
  assert.ok(events.some(e=>e.event==='service.start'&&e.entry==='v14'&&e.aiEnabled===false));
  assert.ok(events.some(e=>e.event==='http.request'&&e.request_id===traceId&&e.blocked==='staged-recovery'));
  assert.ok(!(out+err).includes(secret));
 }finally{child.kill();}
});
