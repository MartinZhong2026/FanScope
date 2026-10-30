// K5 durable scheduler on a real SQLite database with a simulated clock and
// mock jobs. Covers delivery plan §9-A: unattended runs, restart, source failure,
// release hold, lost lease, concurrency, and the per-journal Chinese registry.
import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-k5-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_PATH:path.join(dir,'app.sqlite'),DEEPSEEK_API_KEY:'',FANSCOPE_LOG_DIR:path.join(dir,'logs'),FANSCOPE_LOG_LEVEL:'error'});
const {createScheduler,readGate,SchedulerHold}=await import('../src/platform/scheduler.mjs');
const logging=await import('../src/platform/log.mjs');
const lines=[];const restore=logging.setLogSink(l=>lines.push(l));
const sqlText=fs.readFileSync(new URL('../migrations/20261030T080000Z_scheduled_jobs.sql',import.meta.url),'utf8');
const MIN=60000,HOUR=60*MIN,DAY=24*HOUR;
let db,clock;
const dump=()=>JSON.stringify(db.prepare('SELECT * FROM scheduled_jobs ORDER BY name').all());
const row=name=>db.prepare('SELECT * FROM scheduled_jobs WHERE name=?').get(name);
const open=()=>({open:true,reason:'open'});
const scheduler=(jobs,extra={})=>createScheduler({db,jobs,gate:open,now:()=>clock,random:()=>0,...extra});
beforeEach(()=>{db=new DatabaseSync(':memory:');db.exec(sqlText);clock=Date.parse('2026-11-01T00:00:00Z');lines.length=0});
after(()=>{logging.setLogSink(restore);fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200})});

test('runs unattended on the persisted due time and records the outcome',async()=>{
 let runs=0;const s=scheduler([{name:'a',intervalMs:HOUR,jitterMs:MIN,run:async()=>{runs++;return {added:3}}}],{random:()=>.5});
 s.tick();await s.idle();
 assert.equal(runs,1);
 const r=row('a');
 assert.equal(r.last_status,'ok');assert.equal(r.lease_owner,'');assert.equal(JSON.parse(r.result_json).added,3);
 assert.equal(Date.parse(r.next_due_at),clock+HOUR+30000,'interval plus jitter');
 clock+=30*MIN;s.tick();await s.idle();assert.equal(runs,1,'not due yet');
 clock+=31*MIN;s.tick();await s.idle();assert.equal(runs,2);
});

test('restart: a live lease of the dead process is respected, then the job catches up once',async()=>{
 const job=fn=>[{name:'a',intervalMs:HOUR,run:fn}];
 let release;const hung=new Promise(r=>release=r);
 const first=scheduler(job(()=>hung));first.tick();
 const lease=Date.parse(row('a').lease_expires_at);
 let runs=0;const second=scheduler(job(async()=>{runs++}));
 second.tick();await second.idle();assert.equal(runs,0,'old lease still valid');
 clock=lease+1;
 for(let i=0;i<3;i++){const again=scheduler(job(async()=>{runs++}));again.tick();await again.idle()}
 assert.equal(runs,1,'overdue work runs once, repeated restarts add nothing');
 const before=dump();release({late:true});await first.idle();
 assert.equal(dump(),before,'the old owner cannot write after losing the lease');
});

test('restarts do not reset the schedule',async()=>{
 const job=[{name:'a',intervalMs:HOUR,run:async()=>{}}];
 const s=scheduler(job);s.tick();await s.idle();const due=row('a').next_due_at;
 clock+=10*MIN;const restarted=scheduler(job);restarted.tick();await restarted.idle();
 assert.equal(row('a').next_due_at,due);
});

test('source failure backs off exponentially to 24h, recovery resets it, the loop survives',async()=>{
 let fail=true,runs=0;const s=scheduler([{name:'a',intervalMs:HOUR,run:async()=>{runs++;if(fail)throw Object.assign(Error('upstream 503'),{code:'source_http_503'})}}]);
 const delays=[];
 for(let i=0;i<8;i++){s.tick();await s.idle();const r=row('a');delays.push(Date.parse(r.next_due_at)-clock);clock=Date.parse(r.next_due_at)}
 assert.deepEqual(delays.slice(0,4),[2*HOUR,4*HOUR,8*HOUR,16*HOUR]);
 assert.equal(delays.at(-1),DAY,'capped at 24h');
 assert.equal(row('a').last_error_code,'source_http_503');assert.equal(row('a').consecutive_failures,8);
 fail=false;s.tick();await s.idle();
 assert.equal(row('a').consecutive_failures,0);assert.equal(row('a').last_status,'ok');assert.equal(runs,9);
});

test('release hold: zero writes past two hours, alert only, catches up after open',async()=>{
 let runs=0;const job=[{name:'a',intervalMs:HOUR,run:async()=>{runs++}}];
 scheduler(job).tick();const open1=scheduler(job);open1.tick();await open1.idle();
 clock=Date.parse(row('a').next_due_at)+MIN;
 const before=dump(),alertAfter=new Date(clock+2*HOUR).toISOString();
 let gate={open:false,reason:'release',generation:7,alertAfter};
 const s=scheduler(job,{gate:()=>gate});
 for(let i=0;i<300;i++){clock+=MIN;s.tick()}
 await s.idle();
 assert.equal(dump(),before,'no claim, lease or status write during the hold');
 assert.equal(lines.filter(l=>l.includes('scheduler.hold_overdue')).length,1,'one alert, gate stays closed');
 const ran=runs;gate={open:true,reason:'open'};s.tick();await s.idle();
 assert.equal(runs,ran+1,'one catch-up run, not one per missed interval');
});

test('a job stops at its checkpoint when the gate closes and writes nothing',async()=>{
 let isOpen=true,reached=false;
 const s=scheduler([{name:'a',intervalMs:HOUR,run:async({checkpoint})=>{checkpoint();isOpen=false;reached=true;checkpoint();assert.fail('must stop')}}],{gate:()=>({open:isOpen,reason:'release'})});
 s.tick();const claimed=dump();await s.idle();
 assert.ok(reached);assert.equal(dump(),claimed,'lease left to expire: status writes are also forbidden');
});

test('a job that lost its lease stops at the next checkpoint',async()=>{
 const s=scheduler([{name:'a',intervalMs:HOUR,run:async({checkpoint})=>{db.exec("UPDATE scheduled_jobs SET lease_owner='other'");checkpoint()}}]);
 s.tick();await s.idle();
 assert.equal(row('a').lease_owner,'other');assert.equal(row('a').last_status,'');
});

test('stop() ends a running job at its next checkpoint and frees the lease without a failure',async()=>{
 let release;const wait=new Promise(r=>release=r);
 const s=scheduler([{name:'a',intervalMs:HOUR,run:async({checkpoint})=>{await wait;checkpoint();assert.fail('must stop')}}]);
 s.tick();const due=row('a').next_due_at;
 const stopped=s.stop();release();await stopped;
 const r=row('a');
 assert.equal(r.lease_owner,'');assert.equal(r.last_status,'');assert.equal(r.next_due_at,due,'still due after restart');
});

test('at most two jobs run at once; each job has one row and one lease',async()=>{
 let running=0,peak=0,started=0;const release=[];
 const job=name=>({name,intervalMs:HOUR,run:()=>new Promise(r=>{running++;started++;peak=Math.max(peak,running);release.push(()=>{running--;r()})})});
 const s=scheduler(['a','b','c'].map(job));
 s.tick();s.tick();
 assert.equal(started,2);
 release.splice(0).forEach(f=>f());await s.idle();
 s.tick();assert.equal(started,3,'the third runs when a slot frees');
 release.splice(0).forEach(f=>f());await s.idle();
 assert.equal(peak,2);
});

test('gate file: missing, corrupt, unknown and blocked are all closed; production requires one',()=>{
 const file=path.join(dir,'gate.json');
 assert.equal(readGate(file).open,false,'missing');
 fs.writeFileSync(file,'{broken');assert.equal(readGate(file).open,false,'corrupt');
 fs.writeFileSync(file,'{"state":"weird"}');assert.equal(readGate(file).open,false,'unknown');
 fs.writeFileSync(file,'{"state":"blocked","generation":3,"reason_code":"release"}');assert.deepEqual(readGate(file),{open:false,reason:'release',generation:3,alertAfter:null});
 fs.writeFileSync(file,'{"state":"open","generation":3}');assert.equal(readGate(file).open,true);
 const env=process.env.NODE_ENV;process.env.NODE_ENV='production';
 try{assert.equal(readGate('').open,false,'production without a configured gate stays closed')}finally{process.env.NODE_ENV=env}
});

test('Chinese registry: all 22 listed, unverified journals are never automatic',async()=>{
 const {db:app}=await import('../src/db.mjs');
 const {CHINESE_STATUS,eligibleChineseJournals,ingestFreshness}=await import('../src/ingest/jobs.mjs');
 assert.equal(CHINESE_STATUS.journals.length,22);
 assert.equal(new Set(CHINESE_STATUS.journals.map(j=>j.issn)).size,22);
 assert.equal(CHINESE_STATUS.journals.filter(j=>['A','B'].includes(j.status)).length,0,'the matrix has no A/B journal yet');
 assert.deepEqual(eligibleChineseJournals(),[]);
 const f=ingestFreshness();
 assert.equal(f.chinese.total,22);assert.equal(f.chinese.automatic,0);
 assert.equal(Object.values(f.chinese.byStatus).reduce((a,b)=>a+b),22);
 // A verified source alone is not enough while the reviewed status is not A/B.
 const j=app.prepare("SELECT id FROM journals WHERE market='chinese' AND issn=?").get(CHINESE_STATUS.journals[0].issn);
 if(j){app.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run('cn-source:'+j.id,'{"verified":true}');assert.deepEqual(eligibleChineseJournals(),[]);app.prepare('DELETE FROM meta WHERE key=?').run('cn-source:'+j.id)}
 app.close();
});

test('SchedulerHold is distinguishable from a job failure',()=>{assert.equal(new SchedulerHold('x').code,'scheduler_hold')});
