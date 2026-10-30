// Paper Diagnostic (D1/D2): private manuscript upload, consent, diagnosis runs,
// reports, sharing, retention and deletion. Off unless FANSCOPE_DIAGNOSTIC_ENABLED.
//
// Privacy rules enforced here (not in the browser):
//  - Access: canAccess() only — owner, explicit share, or the group's single
//    trusted mentor (designated by a lab_admin, disclosed at upload/consent).
//    Everyone else, including other mentor accounts, gets 403.
//  - Retention: original file + extracted text 14 days, reports 90 days from
//    upload. Expiry is enforced on every read (410) even if purge lags;
//    purgeDue() then removes files/text/report bodies idempotently.
//  - Manuscript text, prompts and model output are never logged; logs carry ids
//    and error codes only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {db} from '../db.mjs';
import {config} from '../config.mjs';
import {auth,extractText} from '../lab.mjs';
import {log,errorFields} from '../platform/log.mjs';
import {dbLedger} from '../platform/llm-ledger.mjs';
import {normalizeReport} from './report.mjs';
import {providerFor,PROMPT_VERSION,MAX_INPUT_CHARS} from './providers.mjs';

const DAY=86400000;
export const ORIGINAL_DAYS=14,REPORT_DAYS=90,STALE_RUN_MS=15*60000;
export const CONSENT_VERSION='dx-consent-v1';
const ACTIVE=['queued','structuring','diagnosing'];
const MIME={'.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.txt':'text/plain','.md':'text/markdown'};

// Injectable clock for retention tests.
let clock=()=>Date.now();
export function setClock(fn){const previous=clock;clock=fn;return previous}
const iso=ms=>new Date(ms).toISOString();
const nowIso=()=>iso(clock());

export const enabled=()=>process.env.FANSCOPE_DIAGNOSTIC_ENABLED==='true';
export function engineName(){
 const configured=process.env.FANSCOPE_DIAGNOSTIC_PROVIDER;
 if(configured)return configured;
 return process.env.NODE_ENV==='production'?'none':'rules';
}
export const diagnosticStatus=()=>({enabled:enabled(),engine:engineName(),aiConfigured:enabled()&&engineName()==='deepseek'&&!!config.dxKey});
const storageDir=()=>path.join(path.dirname(config.dbPath),'diagnostic-uploads');
const error=(status,message,code)=>Object.assign(new Error(message),{status,code});

export function consentTerms(engine=engineName()){
 const external=engine==='deepseek',mentor=trustedMentor();
 const visibility=mentor?`课题组导师（${mentor.name}）可以查看你上传的稿件信息和诊断报告；其他成员只有在你主动共享后才能查看。`:'目前未指定可查看稿件的导师；其他成员只有在你主动共享后才能查看。';
 return {version:CONSENT_VERSION,engine,external,originalDays:ORIGINAL_DAYS,reportDays:REPORT_DAYS,visibility,mentor,
  backupNote:process.env.FANSCOPE_DIAGNOSTIC_BACKUP_NOTE||'删除后，数据仍可能保留在服务器加密备份中，直至备份按运维策略轮换（计划不超过 35 天）。',
  text:external
   ?`我确认上传的是我本人有权处理的稿件，并同意将稿件全文发送给 DeepSeek（深度求索）的模型接口以生成诊断报告。原稿与提取文本保留 ${ORIGINAL_DAYS} 天，诊断报告保留 ${REPORT_DAYS} 天，我可随时删除。${visibility}`
   :`我确认上传的是我本人有权处理的稿件。当前诊断引擎为“${engine==='rules'?'规则演示引擎（不调用任何外部 AI）':engine}”。原稿与提取文本保留 ${ORIGINAL_DAYS} 天，诊断报告保留 ${REPORT_DAYS} 天，我可随时删除。${visibility}`};
}

// --- Trusted mentor -------------------------------------------------------------
// The group has one supervising mentor. A lab_admin designates that account;
// mentors cannot designate themselves or others, members cannot at all.
const MENTOR_KEY='diagnostic:trusted-mentor';
export function trustedMentor(){
 let id;try{id=JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get(MENTOR_KEY)?.value||'{}').user_id}catch{return null}
 return id?db.prepare("SELECT id,name FROM lab_users WHERE id=? AND role='mentor' AND active=1").get(id)||null:null;
}
export function setTrustedMentor(user,{user_id}){
 if(user.role!=='lab_admin')throw error(403,'仅课题组管理员可以指定导师','dx_admin_only');
 if(user_id===null||user_id===''){db.prepare('DELETE FROM meta WHERE key=?').run(MENTOR_KEY)}
 else{
  const mentor=db.prepare("SELECT id FROM lab_users WHERE id=? AND role='mentor' AND active=1").get(String(user_id||''));
  if(!mentor)throw error(400,'请选择一个有效的导师账号','dx_bad_member');
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(MENTOR_KEY,JSON.stringify({user_id:mentor.id,set_by:user.id,set_at:nowIso()}));
 }
 log('notice','diagnostic.trusted_mentor_changed',{mentor_id:user_id||null,actor_id:user.id});
 return trustedMentor();
}

// --- Access -------------------------------------------------------------------
export function canAccess(user,sub){
 if(!user||!sub)return false;
 if(sub.owner_id===user.id)return true;
 if(db.prepare('SELECT 1 FROM dx_shares WHERE submission_id=? AND user_id=?').get(sub.id,user.id))return true;
 return trustedMentor()?.id===user.id;
}
function submissionFor(user,id){
 const sub=db.prepare('SELECT * FROM dx_submissions WHERE id=?').get(String(id||''));
 if(!sub)throw error(404,'稿件不存在','dx_not_found');
 if(!canAccess(user,sub))throw error(403,'无权访问这份稿件','dx_forbidden');
 return sub;
}
const ownerOnly=(user,sub)=>{if(sub.owner_id!==user.id)throw error(403,'只有上传者本人可以执行此操作','dx_owner_only')};

// --- Lifecycle ------------------------------------------------------------------
const originalAvailable=sub=>!sub.deleted_at&&!sub.original_purged_at&&clock()<Date.parse(sub.original_expires_at);
const reportsAvailable=sub=>!sub.deleted_at&&clock()<Date.parse(sub.report_expires_at);
function insideStorage(file){const dir=path.resolve(storageDir()),abs=path.resolve(file);return abs.startsWith(dir+path.sep)}

// Idempotent: safe to repeat after a crash at any step.
export function purgeDue(){
 const now=nowIso();let originals=0,reports=0;
 for(const s of db.prepare('SELECT id,file_path FROM dx_submissions WHERE original_purged_at IS NULL AND (original_expires_at<=? OR deleted_at IS NOT NULL)').all(now)){
  if(s.file_path&&insideStorage(s.file_path))fs.rmSync(s.file_path,{force:true});
  db.prepare("UPDATE dx_submissions SET file_path=NULL,text_content=NULL,original_purged_at=? WHERE id=? AND original_purged_at IS NULL").run(now,s.id);originals++;
 }
 for(const r of db.prepare(`SELECT r.id FROM dx_runs r JOIN dx_submissions s ON s.id=r.submission_id WHERE r.report_purged_at IS NULL AND (s.report_expires_at<=? OR s.deleted_at IS NOT NULL)`).all(now)){
  db.prepare('UPDATE dx_runs SET structure_json=NULL,report_json=NULL,report_purged_at=? WHERE id=? AND report_purged_at IS NULL').run(now,r.id);reports++;
 }
 // After report expiry nothing private remains; drop the descriptive fields too.
 db.prepare("UPDATE dx_submissions SET title='',filename='' WHERE (report_expires_at<=? OR deleted_at IS NOT NULL) AND (title<>'' OR filename<>'')").run(now);
 if(originals||reports)log('info','diagnostic.purged',{originals,reports});
 return {originals,reports};
}

// --- Views ----------------------------------------------------------------------
function runView(r,sub,{withReport=false}={}){
 // Lazy recovery: a run whose worker died (restart/crash) is shown as interrupted;
 // nothing is written at startup.
 const beat=Date.parse(r.heartbeat_at||r.created_at);
 const status=ACTIVE.includes(r.status)&&clock()-beat>STALE_RUN_MS?'interrupted':r.status;
 const view={id:r.id,status,provider:r.provider,model:r.model,prompt_version:r.prompt_version,error_code:r.error_code||null,created_at:r.created_at,finished_at:r.finished_at,truncated:!!r.truncated,input_chars:r.input_chars};
 if(withReport){
  if(!reportsAvailable(sub)||r.report_purged_at)throw error(410,'诊断报告已过保留期或已删除','dx_report_gone');
  view.report=r.report_json?JSON.parse(r.report_json):null;
 }
 return view;
}
function submissionView(user,sub,{runs=true}={}){
 const view={id:sub.id,title:sub.title,filename:sub.filename,mime:sub.mime,size_bytes:sub.size_bytes,text_length:sub.text_length,created_at:sub.created_at,
  original_expires_at:sub.original_expires_at,report_expires_at:sub.report_expires_at,original_available:originalAvailable(sub),reports_available:reportsAvailable(sub),
  deleted:!!sub.deleted_at,consented:sub.consent_version===CONSENT_VERSION&&sub.consent_provider===engineName(),consent_provider:sub.consent_provider,
  is_owner:sub.owner_id===user.id,owner:db.prepare('SELECT id,name FROM lab_users WHERE id=?').get(sub.owner_id)||{id:sub.owner_id,name:''}};
 if(runs)view.runs=db.prepare('SELECT * FROM dx_runs WHERE submission_id=? ORDER BY created_at DESC').all(sub.id).map(r=>runView(r,sub));
 if(sub.owner_id===user.id)view.shares=db.prepare('SELECT s.user_id,u.name,s.created_at FROM dx_shares s LEFT JOIN lab_users u ON u.id=s.user_id WHERE s.submission_id=? ORDER BY s.created_at').all(sub.id);
 return view;
}
export function listSubmissions(user){
 const rows=db.prepare(`SELECT * FROM dx_submissions s WHERE s.deleted_at IS NULL AND (s.owner_id=?
  OR EXISTS(SELECT 1 FROM dx_shares x WHERE x.submission_id=s.id AND x.user_id=?)
  OR ?=1)
  ORDER BY s.created_at DESC LIMIT 200`).all(user.id,user.id,trustedMentor()?.id===user.id?1:0);
 return rows.filter(s=>canAccess(user,s)&&reportsAvailable(s)).map(s=>submissionView(user,s));
}

// --- Commands -------------------------------------------------------------------
export async function createSubmission(user,{filename,mime,buffer}){
 const ext=path.extname(filename).toLowerCase();
 if(!MIME[ext]||MIME[ext]!==mime)throw error(415,'请上传 PDF、DOCX、TXT 或 Markdown，且扩展名与类型一致','dx_type');
 if(buffer.length<40)throw error(422,'文件内容过短','dx_too_short');
 if(mime==='application/pdf'&&!buffer.subarray(0,5).equals(Buffer.from('%PDF-')))throw error(415,'不是有效 PDF','dx_type');
 if(mime===MIME['.docx']&&!buffer.subarray(0,2).equals(Buffer.from('PK')))throw error(415,'不是有效 DOCX','dx_type');
 const id=crypto.randomUUID(),dir=storageDir();fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const file=path.join(dir,id+ext);fs.writeFileSync(file,buffer,{mode:0o600});
 let text;try{text=await extractText(file,mime)}catch(e){fs.rmSync(file,{force:true});throw e}
 const created=clock();
 db.prepare(`INSERT INTO dx_submissions(id,owner_id,title,filename,mime,size_bytes,sha256,file_path,text_content,text_length,created_at,original_expires_at,report_expires_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,user.id,filename.replace(/\.[^.]+$/,'').slice(0,200),filename,mime,buffer.length,
  crypto.createHash('sha256').update(buffer).digest('hex'),file,text,text.length,iso(created),iso(created+ORIGINAL_DAYS*DAY),iso(created+REPORT_DAYS*DAY));
 log('info','diagnostic.uploaded',{submission_id:id,mime,size_bytes:buffer.length,text_length:text.length});
 return submissionView(user,db.prepare('SELECT * FROM dx_submissions WHERE id=?').get(id));
}

export function recordConsent(user,id,body){
 const sub=submissionFor(user,id);ownerOnly(user,sub);
 if(!originalAvailable(sub))throw error(410,'原稿已过保留期或已删除','dx_original_gone');
 const terms=consentTerms();
 if(body?.accept!==true||body?.version!==terms.version||body?.engine!==terms.engine)throw error(400,'请阅读并勾选当前版本的授权说明','dx_consent_required');
 db.prepare('UPDATE dx_submissions SET consent_version=?,consent_provider=?,consented_at=? WHERE id=?').run(terms.version,terms.engine,nowIso(),sub.id);
 log('info','diagnostic.consented',{submission_id:sub.id,engine:terms.engine,version:terms.version});
 return submissionView(user,db.prepare('SELECT * FROM dx_submissions WHERE id=?').get(sub.id));
}

const workers=new Set();
export const idle=()=>Promise.allSettled([...workers]);

export function startRun(user,id,{providerOptions}={}){
 const sub=submissionFor(user,id);ownerOnly(user,sub);
 if(!originalAvailable(sub))throw error(410,'原稿已过保留期或已删除，无法再次诊断','dx_original_gone');
 const engine=engineName();
 if(engine==='none')throw error(503,'诊断引擎尚未启用','dx_provider_unconfigured');
 if(sub.consent_version!==CONSENT_VERSION||sub.consent_provider!==engine)throw error(409,'请先确认当前诊断引擎的授权说明','dx_consent_required');
 const running=db.prepare(`SELECT * FROM dx_runs WHERE submission_id=? AND status IN ('queued','structuring','diagnosing')`).all(sub.id).filter(r=>runView(r,sub).status!=='interrupted');
 if(running.length)throw error(409,'这份稿件正在诊断中','dx_run_active');
 if(engine==='deepseek'){
  const limit=Math.max(1,Number(process.env.FANSCOPE_DIAGNOSTIC_DAILY_LIMIT||5));
  const today=db.prepare("SELECT COUNT(*) n FROM dx_runs WHERE provider='deepseek' AND requested_by=? AND created_at>=?").get(user.id,nowIso().slice(0,10)).n;
  if(today>=limit)throw error(429,`今日诊断次数已达上限（${limit} 次）`,'dx_daily_limit');
 }
 const runId=crypto.randomUUID();
 let provider;try{provider=providerFor(engine,{ledger:dbLedger(),refId:runId,...providerOptions})}catch(e){throw error(503,'诊断引擎配置不完整','dx_provider_unconfigured')}
 const text=sub.text_content||'',input=text.slice(0,MAX_INPUT_CHARS),created=nowIso();
 db.prepare(`INSERT INTO dx_runs(id,submission_id,requested_by,provider,model,prompt_version,status,input_chars,truncated,created_at,heartbeat_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
  .run(runId,sub.id,user.id,provider.name,provider.model||'',PROMPT_VERSION,'queued',input.length,text.length>input.length?1:0,created,created);
 const job=processRun(runId,provider,input,text.length).finally(()=>workers.delete(job));workers.add(job);
 return runView(db.prepare('SELECT * FROM dx_runs WHERE id=?').get(runId),sub);
}

async function processRun(runId,provider,input,fullLength){
 const set=(fields)=>{const keys=Object.keys(fields);db.prepare(`UPDATE dx_runs SET ${keys.map(k=>k+'=?').join(',')},heartbeat_at=? WHERE id=?`).run(...keys.map(k=>fields[k]),nowIso(),runId)};
 // Results are discarded if the owner deleted the manuscript meanwhile.
 const alive=()=>!!db.prepare('SELECT 1 FROM dx_runs r JOIN dx_submissions s ON s.id=r.submission_id WHERE r.id=? AND s.deleted_at IS NULL').get(runId);
 const cancel=()=>db.prepare("UPDATE dx_runs SET status='cancelled',finished_at=? WHERE id=?").run(nowIso(),runId);
 const started=Date.now();
 try{
  set({status:'structuring',started_at:nowIso()});
  const structure=await provider.structure(input);
  if(!alive())return cancel();
  set({status:'diagnosing',structure_json:JSON.stringify(structure)});
  const diagnosis=await provider.diagnose(input,structure);
  if(!alive())return cancel();
  const report=normalizeReport({structure,diagnosis,text:input,coverage:{input_chars:fullLength,analyzed_chars:input.length,truncated:fullLength>input.length},
   provenance:{engine:provider.name,model:provider.model||'',prompt_version:PROMPT_VERSION,generated_at:nowIso(),ai:provider.name!=='rules'}});
  set({status:'done',report_json:JSON.stringify(report),finished_at:nowIso(),input_tokens:provider.usage.input_tokens||null,output_tokens:provider.usage.output_tokens||null});
  log('info','diagnostic.run_done',{run_id:runId,engine:provider.name,duration_ms:Date.now()-started,issues:report.issues.length,facts_verified:report.validation.facts_verified});
 }catch(e){
  const code=/^dx_[a-z0-9_]+$/.test(e?.code||'')?e.code:'dx_run_failed';
  if(alive())set({status:'failed',error_code:code,finished_at:nowIso()});else cancel();
  log('warn','diagnostic.run_failed',{run_id:runId,engine:provider.name,...errorFields(e),error_code:code});
 }
}

export function getRun(user,runId){
 const r=db.prepare('SELECT * FROM dx_runs WHERE id=?').get(String(runId||''));
 if(!r)throw error(404,'诊断记录不存在','dx_not_found');
 const sub=submissionFor(user,r.submission_id);
 return {...runView(r,sub,{withReport:true}),submission:submissionView(user,sub,{runs:false})};
}

export function deleteSubmission(user,id){
 const sub=submissionFor(user,id);ownerOnly(user,sub);
 if(!sub.deleted_at)db.prepare('UPDATE dx_submissions SET deleted_at=?,deleted_by=? WHERE id=?').run(nowIso(),user.id,sub.id);
 const purged=purgeDue();
 log('info','diagnostic.deleted',{submission_id:sub.id});
 return {ok:true,purged};
}

export function share(user,id,targetId,grant){
 const sub=submissionFor(user,id);ownerOnly(user,sub);
 const target=db.prepare('SELECT id FROM lab_users WHERE id=? AND active=1').get(String(targetId||''));
 if(!target)throw error(400,'成员不存在','dx_bad_member');
 if(target.id===user.id)throw error(400,'无需与自己共享','dx_bad_member');
 if(grant)db.prepare('INSERT OR IGNORE INTO dx_shares(submission_id,user_id,granted_by,created_at) VALUES(?,?,?,?)').run(sub.id,target.id,user.id,nowIso());
 else db.prepare('DELETE FROM dx_shares WHERE submission_id=? AND user_id=?').run(sub.id,target.id);
 log('info',grant?'diagnostic.shared':'diagnostic.unshared',{submission_id:sub.id,user_id:target.id});
 return submissionView(user,db.prepare('SELECT * FROM dx_submissions WHERE id=?').get(sub.id),{runs:false});
}

// --- HTTP -----------------------------------------------------------------------
const respond=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
async function body(req,limit){const parts=[];let n=0;for await(const c of req){n+=c.length;if(n>limit)throw error(413,limit>100000?'文件不得超过 10MB':'请求过大','dx_too_large');parts.push(c)}return Buffer.concat(parts)}
async function json(req){const b=await body(req,20000);try{return JSON.parse(b.toString('utf8')||'{}')}catch{throw error(400,'需要 JSON 格式','dx_bad_json')}}

export async function diagnosticRoute(req,res,url){
 if(!url.pathname.startsWith('/api/diagnostic/'))return false;
 if(!enabled())return respond(res,404,{error:'论文诊断尚未开放'}),true;
 const user=auth(req),parts=url.pathname.slice('/api/diagnostic/'.length).split('/').filter(Boolean),method=req.method;
 purgeDue();
 const [a,id,b,c]=parts;
 if(a==='config'&&method==='GET')return respond(res,200,{engine:engineName(),consent:consentTerms(),maxInputChars:MAX_INPUT_CHARS,user}),true;
 if(a==='members'&&method==='GET')return respond(res,200,{items:db.prepare('SELECT id,name,role FROM lab_users WHERE active=1 ORDER BY name').all()}),true;
 if(a==='trusted-mentor'&&!id&&method==='POST')return respond(res,200,{mentor:setTrustedMentor(user,await json(req))}),true;
 if(a==='submissions'&&!id&&method==='GET')return respond(res,200,{items:listSubmissions(user)}),true;
 if(a==='submissions'&&!id&&method==='POST'){
  let filename;try{filename=decodeURIComponent(String(req.headers['x-file-name']||'').slice(0,180))}catch{throw error(400,'文件名编码无效','dx_bad_name')}
  filename=filename.replace(/[\/\\\x00-\x1f]/g,'_');if(!filename)throw error(400,'缺少文件名','dx_bad_name');
  const mime=String(req.headers['content-type']||'').split(';')[0].trim();
  return respond(res,201,await createSubmission(user,{filename,mime,buffer:await body(req,10*1024*1024)})),true;
 }
 if(a==='submissions'&&id&&!b&&method==='GET')return respond(res,200,submissionView(user,submissionFor(user,id))),true;
 if(a==='submissions'&&id&&b==='consent'&&method==='POST')return respond(res,200,recordConsent(user,id,await json(req))),true;
 if(a==='submissions'&&id&&b==='runs'&&method==='POST')return respond(res,202,startRun(user,id)),true;
 if(a==='submissions'&&id&&b==='delete'&&method==='POST')return respond(res,200,deleteSubmission(user,id)),true;
 if(a==='submissions'&&id&&b==='shares'&&method==='POST'){const v=await json(req);return respond(res,200,share(user,id,v.user_id,v.grant!==false)),true}
 if(a==='runs'&&id&&!b&&method==='GET')return respond(res,200,getRun(user,id)),true;
 void c;
 return respond(res,404,{error:'未知诊断接口'}),true;
}

// Hourly physical purge for the long-running server; reads enforce expiry anyway.
export function startPurgeTimer(){
 if(!enabled())return null;
 const t=setInterval(()=>{try{purgeDue()}catch(e){log('error','worker.failed',{worker:'diagnostic-purge',...errorFields(e)})}},3600000);t.unref();return t;
}
