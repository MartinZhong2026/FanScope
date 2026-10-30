// Paper Diagnostic D1/D2 acceptance on an isolated database: permissions,
// consent, rule and (mocked) DeepSeek engines, report validation, retention,
// deletion, interrupted runs and log privacy. No real AI call is made.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-diagnostic-test-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_PATH:path.join(dir,'test.sqlite'),DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:'',SCAN_ON_START:'false',
 FANSCOPE_LOG_LEVEL:'info',FANSCOPE_LOG_DIR:path.join(dir,'logs'),FANSCOPE_DIAGNOSTIC_ENABLED:'true',FANSCOPE_DIAGNOSTIC_PROVIDER:'rules',FANSCOPE_DIAGNOSTIC_DAILY_LIMIT:'100'});
const logging=await import('../src/platform/log.mjs');
const {db}=await import('../src/db.mjs');
const {makeServer}=await import('../src/server.mjs');
const {createUser,login}=await import('../src/lab.mjs');
const dx=await import('../src/diagnostic/service.mjs');
const {normalizeReport,makeQuoteChecker}=await import('../src/diagnostic/report.mjs');
const lines=[];const restoreSink=logging.setLogSink(line=>lines.push(line));
const server=makeServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{logging.setLogSink(restoreSink);await dx.idle();await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true})});

const password='Synthetic-Password-123';
const users={};
for(const [key,role] of [['student','member'],['peer','member'],['mentor','mentor'],['otherMentor','mentor'],['admin','lab_admin']]){
 const u=createUser({name:key,email:`${key}@example.edu`,role,password});users[key]={...u,token:login(`${key}@example.edu`,password).token};
}
const call=async(who,url,{method='GET',body,headers={}}={})=>{
 const h={...headers};if(who)h.Authorization=`Bearer ${users[who].token}`;
 let payload=body;if(body!==undefined&&!(body instanceof Buffer)&&typeof body!=='string'){payload=JSON.stringify(body);h['Content-Type']='application/json'}
 const r=await fetch(base+url,{method,headers:h,body:payload});return {status:r.status,body:await r.json()};
};

// Synthetic manuscript; these sentences must never appear in logs.
const SECRET_FINDING='养老金领取显著提高了农村老年人的心理健康水平';
const MANUSCRIPT=`农村养老金与老年人心理健康
摘要：本文旨在考察新型农村社会养老保险对农村老年人心理健康的影响。
一、理论框架：本文基于生命历程理论与社会支持理论构建分析框架。
研究假设H1：领取养老金的老年人抑郁水平更低。
数据来源：本文使用CHARLS 2018年调查数据，样本量为6532名60岁及以上农村老年人。
研究方法：采用OLS回归模型，并控制年龄、性别、教育和健康状况。
结果显示，${SECRET_FINDING}，回归系数为-0.42且在1%水平上显著。
这一结果说明养老金导致了老年人抑郁水平下降。
结论：本文认为应进一步提高基础养老金水平。`;
async function upload(who,text=MANUSCRIPT,name='paper.txt',mime='text/plain'){
 return call(who,'/api/diagnostic/submissions',{method:'POST',body:Buffer.from(text),headers:{'Content-Type':mime,'X-File-Name':encodeURIComponent(name)}});
}
async function consent(who,id,engine='rules'){
 const terms=(await call(who,'/api/diagnostic/config')).body.consent;assert.equal(terms.engine,engine);
 return call(who,`/api/diagnostic/submissions/${id}/consent`,{method:'POST',body:{accept:true,version:terms.version,engine}});
}
async function finished(who,runId){await dx.idle();return call(who,`/api/diagnostic/runs/${runId}`)}

test('feature flag off hides every diagnostic endpoint; anonymous access is rejected',async()=>{
 process.env.FANSCOPE_DIAGNOSTIC_ENABLED='false';
 try{assert.equal((await call('student','/api/diagnostic/config')).status,404)}finally{process.env.FANSCOPE_DIAGNOSTIC_ENABLED='true'}
 assert.equal((await call(null,'/api/diagnostic/submissions')).status,401);
});

test('full flow: upload, explicit consent, rule-engine diagnosis, report with verified facts kept apart from judgments',async()=>{
 const up=await upload('student');
 assert.equal(up.status,201,JSON.stringify(up.body));assert.equal(up.body.is_owner,true);assert.equal(up.body.consented,false);
 const id=up.body.id;
 assert.equal((await call('student',`/api/diagnostic/submissions/${id}/runs`,{method:'POST'})).body.error,'请先确认当前诊断引擎的授权说明');
 assert.equal((await call('student',`/api/diagnostic/submissions/${id}/consent`,{method:'POST',body:{accept:true,version:'old',engine:'rules'}})).status,400);
 assert.equal((await consent('student',id)).body.consented,true);
 const run=await call('student',`/api/diagnostic/submissions/${id}/runs`,{method:'POST'});
 assert.equal(run.status,202);
 const done=await finished('student',run.body.id);
 assert.equal(done.status,200);assert.equal(done.body.status,'done');
 const r=done.body.report;
 assert.equal(r.paper_type,'quantitative');assert.equal(r.provenance.ai,false,'rule engine is never presented as AI');
 const verify=makeQuoteChecker(MANUSCRIPT);
 const facts=Object.values(r.facts).flat();assert.ok(facts.length>=5);
 for(const f of facts)assert.ok(verify(f.quote),'every fact quote is in the manuscript');
 assert.ok(r.issues.some(i=>i.dimension==='causal_claims'),'causal wording without identification strategy is flagged');
 for(const i of r.issues)for(const e of i.evidence)assert.ok(verify(e.quote));
 // History lists it.
 const list=(await call('student','/api/diagnostic/submissions')).body.items;
 assert.equal(list[0].id,id);assert.equal(list[0].runs[0].status,'done');
});

test('access: owner, explicit share and linked mentor only; other members/mentors get 403; owner-only actions',async()=>{
 const id=(await upload('student')).body.id;await consent('student',id);
 const runId=(await call('student',`/api/diagnostic/submissions/${id}/runs`,{method:'POST'})).body.id;await dx.idle();
 for(const who of ['peer','mentor','otherMentor','admin']){
  assert.equal((await call(who,`/api/diagnostic/submissions/${id}`)).status,403,who);
  assert.equal((await call(who,`/api/diagnostic/runs/${runId}`)).status,403,who);
  assert.ok(!(await call(who,'/api/diagnostic/submissions')).body.items.some(x=>x.id===id),who);
 }
 // Members cannot create advisor links; staff can.
 assert.equal((await call('student','/api/diagnostic/advisor-links',{method:'POST',body:{mentor_id:users.mentor.id,student_id:users.student.id}})).status,403);
 assert.equal((await call('admin','/api/diagnostic/advisor-links',{method:'POST',body:{mentor_id:users.mentor.id,student_id:users.student.id}})).status,200);
 assert.equal((await call('mentor',`/api/diagnostic/runs/${runId}`)).status,200,'linked mentor reads the report');
 assert.equal((await call('otherMentor',`/api/diagnostic/runs/${runId}`)).status,403,'unlinked mentor still blocked');
 // Explicit share.
 assert.equal((await call('student',`/api/diagnostic/submissions/${id}/shares`,{method:'POST',body:{user_id:users.peer.id}})).status,200);
 assert.equal((await call('peer',`/api/diagnostic/runs/${runId}`)).status,200);
 for(const [who,action] of [['peer','runs'],['peer','delete'],['mentor','consent'],['mentor','delete']])
  assert.equal((await call(who,`/api/diagnostic/submissions/${id}/${action}`,{method:'POST',body:{}})).status,403,`${who} ${action}`);
 assert.equal((await call('peer',`/api/diagnostic/submissions/${id}/shares`,{method:'POST',body:{user_id:users.admin.id}})).status,403,'only the owner shares');
 await call('student',`/api/diagnostic/submissions/${id}/shares`,{method:'POST',body:{user_id:users.peer.id,grant:false}});
 assert.equal((await call('peer',`/api/diagnostic/runs/${runId}`)).status,403,'revoked');
});

test('DeepSeek engine (mocked HTTP): fabricated quotes are dropped, failures are recorded with safe codes, text stays out of logs',async()=>{
 process.env.FANSCOPE_DIAGNOSTIC_PROVIDER='deepseek';
 try{
  const id=(await upload('student')).body.id;
  assert.equal((await call('student',`/api/diagnostic/submissions/${id}/runs`,{method:'POST'})).status,409,'rule-engine consent does not cover external AI');
  const terms=(await call('student','/api/diagnostic/config')).body.consent;assert.equal(terms.external,true);assert.match(terms.text,/DeepSeek/);
  await consent('student',id,'deepseek');
  const requests=[];
  const reply=content=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:900,completion_tokens:300}}),{status:200});
  const ok=async(url,init)=>{const b=JSON.parse(init.body);requests.push(b);
   return requests.length===1
    ?reply({paper_type:'quantitative',language:'zh',title:'农村养老金与老年人心理健康',summary:'AI 摘要',facts:{research_questions:[{text:'研究问题',quote:'本文旨在考察新型农村社会养老保险对农村老年人心理健康的影响'}],data:[{text:'数据',quote:'样本量为6532名60岁及以上农村老年人'},{text:'编造的数据',quote:'本文使用了全国10万人的追踪数据'}]}})
    :reply({checks:[{dimension:'causal_claims',status:'concern',judgment:'因果表述过强',evidence:[{quote:'这一结果说明养老金导致了老年人抑郁水平下降'},{quote:'不存在的引用句子内容'}]},{dimension:'participants_sampling',status:'concern',judgment:'not for quantitative'}],
      issues:[{severity:'minor',dimension:'writing_structure',title:'摘要可更具体',problem:'p',suggestion:'s',evidence:[]},{severity:'critical',dimension:'causal_claims',title:'因果识别不足',problem:'OLS 不能支持因果结论',reviewer_question:'如何处理内生性？',suggestion:'使用断点或工具变量',evidence:[{quote:'采用OLS回归模型'}]},{severity:'bogus',title:'x',problem:'y',suggestion:'z'}],strengths:[]})};
  const run=dx.startRun({id:users.student.id,role:'member'},id,{providerOptions:{apiKey:'test-only',fetchImpl:ok}});
  const done=await finished('student',run.id);
  assert.equal(done.body.status,'done');assert.equal(requests.length,2);
  assert.ok(requests[0].messages[1].content.startsWith('<manuscript>'),'manuscript-first stable prefix');
  assert.equal(requests[0].messages[0].content,requests[1].messages[0].content);
  const r=done.body.report;
  assert.deepEqual(r.facts.data.map(f=>f.quote),['样本量为6532名60岁及以上农村老年人'],'fabricated fact removed');
  assert.equal(r.validation.issues_dropped,1);assert.ok(r.validation.quotes_rejected>=2);
  assert.deepEqual(r.issues.map(i=>i.severity),['critical','minor'],'sorted by severity');
  assert.equal(r.issues[1].evidence_status,'none');
  assert.ok(!r.checks.some(c=>c.dimension==='participants_sampling'),'qualitative check dropped for a quantitative paper');
  assert.equal(r.provenance.ai,true);
  const row=db.prepare('SELECT input_tokens,output_tokens FROM dx_runs WHERE id=?').get(run.id);assert.deepEqual({...row},{input_tokens:1800,output_tokens:600});
  // Failures.
  for(const [impl,code] of [[async()=>new Response('{}',{status:500}),'dx_provider_http_500'],
   [async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'not json'}}]})),'dx_provider_invalid_json'],
   [async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]})),'dx_provider_truncated'],
   [async()=>{throw new TypeError('fetch failed')},'dx_provider_network']]){
   const failed=dx.startRun({id:users.student.id,role:'member'},id,{providerOptions:{apiKey:'test-only',fetchImpl:impl}});
   const v=await finished('student',failed.id);assert.equal(v.body.status,'failed');assert.equal(v.body.error_code,code);
  }
  // Unconfigured key -> 503, nothing sent.
  assert.equal((await call('student',`/api/diagnostic/submissions/${id}/runs`,{method:'POST'})).status,503);
 }finally{process.env.FANSCOPE_DIAGNOSTIC_PROVIDER='rules'}
 const logText=lines.join('\n');
 for(const leaked of [SECRET_FINDING,'本文旨在考察','CHARLS 2018','test-only','因果识别不足'])assert.ok(!logText.includes(leaked),`log leaked: ${leaked}`);
 assert.ok(lines.some(l=>l.includes('diagnostic.run_failed')));
});

test('retention: original unreadable after 14 days and purged; report kept until 90 days, then gone',async()=>{
 const up=await upload('student');const id=up.body.id;await consent('student',id);
 const runId=(await call('student',`/api/diagnostic/submissions/${id}/runs`,{method:'POST'})).body.id;await dx.idle();
 const row=db.prepare('SELECT file_path FROM dx_submissions WHERE id=?').get(id);assert.ok(fs.existsSync(row.file_path));
 const start=Date.parse(up.body.created_at),restore=dx.setClock(()=>start+15*86400000);
 try{
  const v=await call('student',`/api/diagnostic/submissions/${id}`);
  assert.equal(v.body.original_available,false);assert.equal(v.body.reports_available,true);
  assert.equal((await call('student',`/api/diagnostic/submissions/${id}/runs`,{method:'POST'})).status,410);
  const after=db.prepare('SELECT file_path,text_content,original_purged_at FROM dx_submissions WHERE id=?').get(id);
  assert.equal(after.text_content,null);assert.ok(after.original_purged_at);assert.ok(!fs.existsSync(row.file_path),'file physically removed');
  assert.equal((await call('student',`/api/diagnostic/runs/${runId}`)).body.status,'done','report survives original purge');
  dx.setClock(()=>start+91*86400000);
  assert.equal((await call('student',`/api/diagnostic/runs/${runId}`)).status,410);
  const gone=db.prepare('SELECT report_json,structure_json,report_purged_at FROM dx_runs WHERE id=?').get(runId);
  assert.equal(gone.report_json,null);assert.equal(gone.structure_json,null);assert.ok(gone.report_purged_at);
  assert.equal(db.prepare('SELECT title FROM dx_submissions WHERE id=?').get(id).title,'');
  assert.ok(!(await call('student','/api/diagnostic/submissions')).body.items.some(x=>x.id===id));
  assert.deepEqual(dx.purgeDue(),{originals:0,reports:0},'purge is idempotent');
 }finally{dx.setClock(restore)}
});

test('owner deletion removes file, text and reports immediately for everyone, and discards a run still in flight',async()=>{
 const id=(await upload('student')).body.id;await consent('student',id);
 const runId=(await call('student',`/api/diagnostic/submissions/${id}/runs`,{method:'POST'})).body.id;await dx.idle();
 await call('student',`/api/diagnostic/submissions/${id}/shares`,{method:'POST',body:{user_id:users.peer.id}});
 const file=db.prepare('SELECT file_path FROM dx_submissions WHERE id=?').get(id).file_path;
 assert.equal((await call('student',`/api/diagnostic/submissions/${id}/delete`,{method:'POST'})).status,200);
 assert.ok(!fs.existsSync(file));
 for(const who of ['student','peer'])assert.equal((await call(who,`/api/diagnostic/runs/${runId}`)).status,410,who);
 assert.equal(db.prepare('SELECT report_json FROM dx_runs WHERE id=?').get(runId).report_json,null);
 // In-flight run: owner deletes while the engine is still working.
 process.env.FANSCOPE_DIAGNOSTIC_PROVIDER='deepseek';
 try{
  const id2=(await upload('student')).body.id;await consent('student',id2,'deepseek');
  let release;const gate=new Promise(r=>release=r);
  const slow=async()=>{await gate;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"paper_type":"quantitative","facts":{}}'}}]}))};
  const run=dx.startRun({id:users.student.id,role:'member'},id2,{providerOptions:{apiKey:'test-only',fetchImpl:slow}});
  await call('student',`/api/diagnostic/submissions/${id2}/delete`,{method:'POST'});release();await dx.idle();
  const r=db.prepare('SELECT status,report_json,structure_json FROM dx_runs WHERE id=?').get(run.id);
  assert.equal(r.report_json,null);assert.equal(r.structure_json,null);assert.equal(r.status,'cancelled');
 }finally{process.env.FANSCOPE_DIAGNOSTIC_PROVIDER='rules'}
});

test('a run abandoned by a crashed worker is shown as interrupted without startup writes, and can be retried',async()=>{
 const id=(await upload('student')).body.id;await consent('student',id);
 const old=new Date(Date.now()-20*60000).toISOString();
 db.prepare(`INSERT INTO dx_runs(id,submission_id,requested_by,provider,prompt_version,status,created_at,heartbeat_at) VALUES('stale-run',?,?,'rules','dx-prompt-v1','diagnosing',?,?)`).run(id,users.student.id,old,old);
 const v=await call('student',`/api/diagnostic/submissions/${id}`);
 assert.equal(v.body.runs.find(r=>r.id==='stale-run').status,'interrupted');
 assert.equal(db.prepare("SELECT status FROM dx_runs WHERE id='stale-run'").get().status,'diagnosing','read path does not rewrite');
 assert.equal((await call('student',`/api/diagnostic/submissions/${id}/runs`,{method:'POST'})).status,202);
});

test('upload validation: type/extension mismatch, fake PDF, oversize and empty names are rejected',async()=>{
 assert.equal((await upload('student',MANUSCRIPT,'paper.pdf','text/plain')).status,415);
 assert.equal((await upload('student','x'.repeat(100),'paper.pdf','application/pdf')).status,415);
 assert.equal((await upload('student','short','paper.txt')).status,422);
 assert.equal((await call('student','/api/diagnostic/submissions',{method:'POST',body:Buffer.alloc(11*1024*1024,65),headers:{'Content-Type':'text/plain','X-File-Name':'big.txt'}})).status,413);
 assert.equal((await call('student','/api/diagnostic/submissions',{method:'POST',body:Buffer.from(MANUSCRIPT),headers:{'Content-Type':'text/plain'}})).status,400);
});

test('report normalizer: unknown paper types, missing fields and oversized lists are bounded',()=>{
 const r=normalizeReport({structure:{paper_type:'astrology',facts:{methods:Array(20).fill({text:'m',quote:'采用OLS回归模型，并控制年龄'})}},diagnosis:{issues:Array(40).fill({severity:'minor',title:'t',problem:'p',suggestion:'s'})},text:MANUSCRIPT});
 assert.equal(r.paper_type,'unknown');assert.equal(r.facts.methods.length,8);assert.equal(r.issues.length,30);assert.deepEqual(r.facts.hypotheses,[]);
});
