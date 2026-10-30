// K5: durable in-process scheduler. One tick per minute claims due rows from
// scheduled_jobs with a conditional UPDATE (lease), runs them, and writes the
// outcome only while it still owns the lease.
//
// Release safety: the host controller owns a gate file (read-only here). Unless
// it says "open", the scheduler performs no database write at all: no claims,
// no lease renewal, no status updates. Missing or unreadable means closed. The
// gate is never opened from this side, and a long hold only raises an alert.
//
// Off by default (FANSCOPE_SCHEDULER). Nothing here runs at import time.
import crypto from 'node:crypto';
import fs from 'node:fs';
import {log,errorFields} from './log.mjs';

const DAY=86400000;
export class SchedulerHold extends Error{constructor(reason){super('Scheduler stopped this job');this.name='SchedulerHold';this.code='scheduler_hold';this.reason=reason}}

export function readGate(file=process.env.FANSCOPE_RELEASE_GATE_FILE){
 if(!file)return process.env.NODE_ENV==='production'?{open:false,reason:'gate_unconfigured'}:{open:true,reason:'no_gate_outside_production'};
 try{
  const g=JSON.parse(fs.readFileSync(file,'utf8'));
  if(g?.state==='open')return {open:true,reason:'open',generation:g.generation};
  if(g?.state==='blocked')return {open:false,reason:g.reason_code||'blocked',generation:g.generation,alertAfter:g.alert_after||null};
  return {open:false,reason:'gate_invalid'};
 }catch{return {open:false,reason:'gate_unreadable'}}
}

export function createScheduler({db,jobs,gate=readGate,now=()=>Date.now(),random=Math.random,maxConcurrent=2,leaseMs=120000,tickMs=60000}){
 const active=new Map(),byName=new Map(jobs.map(j=>[j.name,j]));
 const iso=ms=>new Date(ms).toISOString();
 let timer=null,stopped=false,holdAlerted=null,lastGate=null;
 const owns=(name,token)=>{const r=db.prepare('SELECT lease_owner,lease_expires_at FROM scheduled_jobs WHERE name=?').get(name);return r?.lease_owner===token&&Date.parse(r.lease_expires_at)>now()};
 const nextDue=(job,base)=>base+job.intervalMs+Math.floor(random()*(job.jitterMs||0));

 function claim(job,token){
  const t=now();
  return db.prepare("UPDATE scheduled_jobs SET lease_owner=?,lease_expires_at=?,last_started_at=? WHERE name=? AND next_due_at<=? AND (lease_owner='' OR lease_expires_at<=?)")
   .run(token,iso(t+leaseMs),iso(t),job.name,iso(t),iso(t)).changes===1;
 }

 async function execute(job,token){
  const controller=new AbortController(),{signal}=controller,started=now();
  const abort=reason=>{if(!signal.aborted)controller.abort(new SchedulerHold(reason))};
  const timeout=setTimeout(()=>abort('timeout'),job.timeoutMs||30*60000);timeout.unref?.();
  // A renewal is a write: it happens only with the gate open and the lease held.
  const renew=setInterval(()=>{
   try{
    if(!gate().open)return abort('gate_closed');
    if(!db.prepare('UPDATE scheduled_jobs SET lease_expires_at=? WHERE name=? AND lease_owner=?').run(iso(now()+leaseMs),job.name,token).changes)abort('lease_lost');
   }catch(e){abort('renew_failed');log('error','scheduler.renew_failed',{job:job.name,...errorFields(e)})}
  },Math.floor(leaseMs/3));renew.unref?.();
  const checkpoint=()=>{
   if(signal.aborted)throw signal.reason;
   const g=gate();if(!g.open)throw new SchedulerHold('gate_closed');
   if(!owns(job.name,token))throw new SchedulerHold('lease_lost');
  };
  const finish=(sql,...args)=>{if(gate().open)db.prepare(sql).run(...args)};
  try{
   const result=await job.run({signal,checkpoint})??{};
   const t=now();
   finish("UPDATE scheduled_jobs SET lease_owner='',lease_expires_at=NULL,last_finished_at=?,last_status='ok',last_error_code='',consecutive_failures=0,next_due_at=?,result_json=? WHERE name=? AND lease_owner=?",
    iso(t),iso(nextDue(job,t)),JSON.stringify(result),job.name,token);
   log('info','scheduler.job_done',{job:job.name,duration_ms:t-started});
  }catch(e){
   const t=now();
   if(e instanceof SchedulerHold){
    // Not a failure: keep next_due_at, so the job catches up once when allowed.
    finish("UPDATE scheduled_jobs SET lease_owner='',lease_expires_at=NULL WHERE name=? AND lease_owner=?",job.name,token);
    log('notice','scheduler.job_stopped',{job:job.name,reason:e.reason,duration_ms:t-started});
   }else{
    const code=/^[a-z0-9_]{1,60}$/.test(e?.code||'')?e.code:'job_failed';
    const row=db.prepare('SELECT consecutive_failures n FROM scheduled_jobs WHERE name=?').get(job.name),failures=(row?.n||0)+1;
    const delay=Math.min(DAY,job.intervalMs*2**Math.min(failures,16));
    finish("UPDATE scheduled_jobs SET lease_owner='',lease_expires_at=NULL,last_finished_at=?,last_status='failed',last_error_code=?,consecutive_failures=?,next_due_at=? WHERE name=? AND lease_owner=?",
     iso(t),code,failures,iso(t+delay),job.name,token);
    log('warn','scheduler.job_failed',{job:job.name,failures,retry_in_ms:delay,duration_ms:t-started,...errorFields(e),error_code:code});
   }
  }finally{clearTimeout(timeout);clearInterval(renew)}
 }

 function tick(){
  if(stopped)return;
  const g=lastGate=gate();
  if(!g.open){
   if(g.alertAfter&&now()>=Date.parse(g.alertAfter)&&holdAlerted!==g.generation){holdAlerted=g.generation;log('error','scheduler.hold_overdue',{generation:g.generation,reason:g.reason})}
   if(g.reason.startsWith('gate_')&&holdAlerted!==g.reason){holdAlerted=g.reason;log('error','scheduler.gate_unavailable',{reason:g.reason})}
   return;
  }
  holdAlerted=null;
  const seed=db.prepare('INSERT OR IGNORE INTO scheduled_jobs(name,next_due_at) VALUES(?,?)');
  for(const job of jobs)seed.run(job.name,iso(now()));
  const due=db.prepare('SELECT name FROM scheduled_jobs WHERE next_due_at<=? ORDER BY next_due_at').all(iso(now()));
  for(const {name} of due){
   if(active.size>=maxConcurrent)break;
   const job=byName.get(name);
   if(!job||active.has(name))continue;
   const token=crypto.randomUUID();
   if(!claim(job,token))continue;
   active.set(name,execute(job,token).finally(()=>active.delete(name)));
  }
 }
 const safeTick=()=>{try{tick()}catch(e){log('error','scheduler.tick_failed',errorFields(e))}};

 return {
  tick:safeTick,
  idle:()=>Promise.allSettled([...active.values()]),
  start(){if(timer)return;setImmediate(safeTick);timer=setInterval(safeTick,tickMs);timer.unref?.()},
  async stop(){stopped=true;clearInterval(timer);timer=null;await Promise.allSettled([...active.values()])},
  status:()=>({running:[...active.keys()],gate:lastGate?.reason??'not_checked'}),
 };
}
