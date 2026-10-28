import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-documenttest-'));
process.env.DATABASE_PATH=path.join(tempDir,'qa.sqlite');
process.env.SCAN_ON_START='false';process.env.DEEPSEEK_API_KEY='mock-only-no-paid-network';
const originalFetch=globalThis.fetch;
let liveProjectId='';
let mockedCalls=0;
globalThis.fetch=async(url,options)=>{
 if(String(url)==='https://api.deepseek.com/chat/completions'){
  mockedCalls++;
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({updates:[{entity_type:'project',entity_id:liveProjectId,status:'waiting',summary:'问卷清洗完成，准备汇报',next_step:'review the draft report',source_quote:'The nursing collaboration project completed the survey cleaning stage'}]})}}]}),{status:200,headers:{'Content-Type':'application/json'}});
 }
 return originalFetch(url,options);
};
const {createUser}=await import('../src/lab.mjs');
const {db}=await import('../src/db.mjs');
const {makeServer}=await import('../src/server.mjs');
let server;
after(async()=>{globalThis.fetch=originalFetch;if(server)await new Promise(r=>server.close(r));db.close();for(const x of ['','-wal','-shm'])try{fs.unlinkSync(process.env.DATABASE_PATH+x)}catch{};fs.rmSync(tempDir,{recursive:true,force:true});});
test('DOCX/PDF/Markdown/TXT upload, evidence-linked DeepSeek proposal, approve, PDF extraction, private file access',async()=>{
 const m=createUser({name:'Test mentor',email:'teacher2@example.edu',role:'mentor',password:'Test-lab-password-2026'});
 const u=createUser({name:'Test student',email:'student2@example.edu',role:'member',password:'Test-lab-password-2026'});
 const other=createUser({name:'Other student',email:'other2@example.edu',role:'member',password:'Test-lab-password-2026'});
 server=makeServer();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const base='http://127.0.0.1:'+server.address().port;
 async function login(email){const r=await originalFetch(base+'/api/lab/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'Test-lab-password-2026'})});return (await r.json()).token;}
 const teacher=await login(m.email),student=await login(u.email),outsider=await login(other.email);
 async function req(url,token,method='GET',body){const r=await originalFetch(base+url,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
 const c=await req('/api/lab/projects',teacher,'POST',{title:'Nursing collaboration',summary:'Synthetic project'});assert.equal(c.status,201);liveProjectId=c.data.id;
 await req('/api/lab/projects/'+liveProjectId+'/managers',teacher,'POST',{user_id:u.id});
 for(const ext of ['docx','pdf','md','txt']){
  const contentType={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',md:'text/markdown',txt:'text/plain'}[ext];
  const bytes=['md','txt'].includes(ext)?Buffer.from('\uFEFF# Synthetic '+ext+' meeting\nThe nursing collaboration project completed the survey cleaning stage. The team will review the draft report. 合成验收资料，不是真实会议记录。'):fs.readFileSync(path.join(import.meta.dirname,'fixtures','sample-meeting.'+ext));
  const r=await originalFetch(base+'/api/lab/documents',{method:'POST',headers:{Authorization:'Bearer '+student,'Content-Type':contentType,'X-File-Name':encodeURIComponent('synthetic-meeting.'+ext)},body:bytes});
  const data=await r.json();assert.equal(r.status,202);assert.equal(data.status,'pending');assert.ok(data.extracted_chars>100);
  let detail;for(let i=0;i<30;i++){detail=await req('/api/lab/documents/'+data.id,student);if(detail.data.document.extract_status!=='pending')break;await new Promise(ok=>setTimeout(ok,75));}
  assert.equal(detail.status,200);assert.equal(detail.data.document.extract_status,'ready');assert.equal(detail.data.suggestions.length,1);
  const deny=await req('/api/lab/documents/'+data.id,outsider);assert.equal(deny.status,403);
  const file=await originalFetch(base+'/api/lab/documents/'+data.id+'/file',{headers:{Authorization:'Bearer '+teacher}});assert.equal(file.status,200);assert.equal((await file.arrayBuffer()).byteLength,bytes.byteLength);
  const review=await req('/api/lab/documents/'+data.id+'/review',student,'POST',{items:[{id:detail.data.suggestions[0].id,decision:'approve'}]});assert.equal(review.status,200);assert.equal(review.data.applied,1);
 }
 assert.equal(mockedCalls,4);
 assert.equal((await req('/api/lab/projects/'+liveProjectId,outsider)).data.item.status,'waiting');
 const textHeaders={Authorization:'Bearer '+student,'Content-Type':'text/markdown','X-File-Name':'qa.md'};
 for(const [headers,bytes,status] of [[textHeaders,Buffer.alloc(60,0xff),415],[textHeaders,Buffer.alloc(512*1024+1,65),413],[{...textHeaders,'X-File-Name':'qa.pdf'},Buffer.alloc(100,65),415],[{...textHeaders,'X-File-Name':'%broken'},Buffer.alloc(100,65),400]]){
  const rejected=await originalFetch(base+'/api/lab/documents',{method:'POST',headers,body:bytes});assert.equal(rejected.status,status);
 }
 assert.equal(mockedCalls,4,'rejected imports never invoke AI');
 const invalid=await originalFetch(base+'/api/lab/documents',{method:'POST',headers:{Authorization:'Bearer '+student,'Content-Type':'application/pdf'},body:Buffer.from('fake file content repeated more than 50 bytes xxxxxxxxxxxxxxxxxxxxx')});assert.equal(invalid.status,415);
});
