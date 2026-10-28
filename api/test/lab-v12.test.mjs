import test,{after} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import ExcelJS from 'exceljs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-lab-v12-'));process.env.DATABASE_PATH=path.join(dir,'test.sqlite');process.env.SCAN_ON_START='false';process.env.DEEPSEEK_API_KEY='offline-mock';
const {db}=await import('../src/db.mjs');const {createUser,login,validateProposals}=await import('../src/lab.mjs');const {makeServer}=await import('../src/server.mjs');const {previewWorkbook,exportManuscripts,parseStage}=await import('../src/manuscripts.mjs');
const password='offline-password-for-tests';const staff=createUser({name:'Synthetic admin',email:'admin-v12@example.org',role:'lab_admin',password}),member=createUser({name:'Synthetic member',email:'member-v12@example.org',password}),other=createUser({name:'Synthetic other',email:'other-v12@example.org',password});
const tokens=Object.fromEntries([staff,member,other].map(u=>[u.id,login(u.email,password).token]));const originalFetch=globalThis.fetch;let server,base,project;
async function req(route,u=staff,method='GET',body){const r=await originalFetch(base+'/api/lab/'+route,{method,headers:{Authorization:'Bearer '+tokens[u.id],...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,...await r.json()};}
after(async()=>{globalThis.fetch=originalFetch;if(server)await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});
test('project members, weighted milestone progress, tasks, exploratory mode and file permissions',async()=>{
 server=makeServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
 project=(await req('projects',staff,'POST',{title:'Synthetic research project'})).id;
 assert.equal((await req('projects/'+project+'/members',staff,'POST',{user_id:member.id})).status,200);
 assert.equal((await req('projects/'+project+'/milestones',member,'POST',{title:'Forbidden'})).status,403);
 await req('projects/'+project+'/managers',staff,'POST',{user_id:member.id});
 await req('projects/'+project+'/milestones',member,'POST',{title:'Design',weight:1,status:'completed'});
 await req('projects/'+project+'/milestones',member,'POST',{title:'Fieldwork',weight:3});
 await req('projects/'+project+'/tasks',member,'POST',{title:'Recruit',assignee_id:member.id,status:'blocked',blocker:'Awaiting permission'});
 let detail=await req('projects/'+project,other);assert.equal(detail.workspace.progress,25);assert.equal(detail.workspace.members[0].id,member.id);assert.equal(detail.workspace.tasks[0].blocker,'Awaiting permission');
 await req('projects/'+project+'/workspace',member,'POST',{owner_id:member.id,stage:'Exploration',progress_mode:'exploratory',start_date:'2026-10-24'});assert.equal((await req('projects/'+project,other)).workspace.progress,null);
});
test('Excel preview preserves raw fields, does not execute formulas, stage takes priority, confirmation is atomic/idempotent',async()=>{
 const w=new ExcelJS.Workbook(),s=w.addWorksheet('论文写作与发表');s.addRow(['','Topic/Title','Stage','Target journal','Lead author','Other author']);
 s.addRow(['已发表','Accepted synthetic work','accepted','Journal A; Journal B','FAN','Fan']);
 s.addRow(['','Editor synthetic work','with editor','Journal C','杨帆','Other']);
 s.addRow(['','Unknown synthetic book','','','Raw Name','']);
 s.addRow(['','',null,null,null,null]);s.getCell('B5').value={formula:'DISPIMG("private")',result:'not a title'};
 s.addRow(['*其他备选题目','Must skip','published']);
 const bytes=Buffer.from(await w.xlsx.writeBuffer()),v=await previewWorkbook(bytes,staff);assert.equal(v.rows.length,3);assert.equal(v.rows[0].status,'accepted');assert.equal(v.rows[1].status,'with_editor');assert.equal(v.rows[2].status,'idea');assert.equal(v.rows[2].work_type,'other');assert.equal(v.rows[2].needs_review,true);assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_manuscripts').get().n,0);
 const bad=await req('manuscripts/import-confirm',staff,'POST',{batch_id:v.batch_id,rows:v.rows.map(r=>({source_row:r.source_row,status:r.status,owner_id:''}))});assert.equal(bad.status,400);assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_manuscripts').get().n,0);
 const body={batch_id:v.batch_id,rows:v.rows.map(r=>({source_row:r.source_row,status:r.status,owner_id:member.id}))};assert.equal((await req('manuscripts/import-confirm',staff,'POST',body)).imported,3);assert.equal((await req('manuscripts/import-confirm',staff,'POST',body)).imported,0);
 assert.equal((await previewWorkbook(bytes,staff)).confirmed,true);
 const list=(await req('manuscripts',other)).items;assert.equal(list.length,3);assert.equal(list.find(x=>x.title.startsWith('Accepted')).target_journals,'Journal A; Journal B');assert.equal(list.find(x=>x.title.startsWith('Accepted')).actual_submitted_journal,'');
 const paper=list[0];assert.equal((await req('manuscripts/'+paper.id,other,'PATCH',{status:'published'})).status,403);assert.equal((await req('manuscripts/'+paper.id,member,'PATCH',{private_note:'forbidden'})).status,400);
 const second=new ExcelJS.Workbook(),t=second.addWorksheet('论文写作与发表');t.addRow(['','Topic/Title','Stage']);t.addRow(['',' ACCEPTED， synthetic work! ','accepted']);const v2=await previewWorkbook(Buffer.from(await second.xlsx.writeBuffer()),staff);assert.ok(v2.rows[0].duplicate_id);
 assert.equal(parseStage('accepted（25年第6期刊出）').status,'accepted');assert.equal(parseStage('accepted（25年第6期刊出）').needs_review,true);
});
test('export protects spreadsheet formulas and does not expose private history or import payloads',async()=>{
 const m=await req('manuscripts',member,'POST',{title:'=HYPERLINK("bad")',status:'writing'});assert.equal(m.status,201);const w=new ExcelJS.Workbook();await w.xlsx.load(await exportManuscripts());assert.ok(w.getWorksheet(1).getColumn(2).values.some(v=>String(v).startsWith("'=HYPERLINK")));
 const row=db.prepare('SELECT * FROM lab_manuscripts WHERE id=?').get(m.id);db.prepare('UPDATE lab_manuscripts SET private_note=? WHERE id=?').run('LEGACY PRIVATE',m.id);const details=await req('manuscripts/'+m.id,staff);assert.equal(JSON.stringify(details).includes('LEGACY PRIVATE'),false);assert.equal((await req('events/manuscript?id='+m.id,member)).items.length,0);
});
test('pasted text proposes multiple updates, never writes until authorized individual review, raw file remains private',async()=>{
 const text='The synthetic project has completed the initial design phase. The synthetic member will start an internship next month. No decisions are approved yet.';
 let calls=0;globalThis.fetch=async(url,options)=>{if(String(url)==='https://api.deepseek.com/chat/completions'){calls++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({updates:[{entity_type:'project',entity_id:project,status:'waiting',summary:'Design discussed',source_quote:'The synthetic project has completed the initial design phase'},{entity_type:'member',entity_id:member.id,status:'internship',summary:'Internship planned',source_quote:'The synthetic member will start an internship next month'},{entity_type:'manuscript',entity_id:db.prepare('SELECT id FROM lab_manuscripts LIMIT 1').get().id,status:'published',summary:'Forbidden paper update',source_quote:'The synthetic project has completed the initial design phase'}]})}}]}))}return originalFetch(url,options)};
 const out=await req('documents/text',member,'POST',{text,title:'Synthetic meeting',source:'双周组会',date:'2026-10-24',participants:'Synthetic member'});assert.equal(out.status,'pending');let detail;for(let i=0;i<30;i++){detail=await req('documents/'+out.id,member);if(detail.document.extract_status!=='pending')break;await new Promise(r=>setTimeout(r,25));}
 assert.equal(calls,1);assert.equal(detail.suggestions.length,2);assert.equal(detail.document.metadata.source,'双周组会');assert.equal((await req('projects/'+project)).item.status,'planning');assert.equal((await req('documents/'+out.id,other)).status,403);assert.equal((await originalFetch(base+'/api/lab/documents/'+out.id+'/file',{headers:{Authorization:'Bearer '+tokens[other.id]}})).status,403);
 assert.equal((await req('suggestions/'+detail.suggestions[0].id+'/review',other,'POST',{decision:'approve'})).status,403);
 assert.equal((await req('suggestions/'+detail.suggestions[0].id+'/review',member,'POST',{decision:'approve'})).status,200);assert.equal((await req('projects/'+project)).item.status,'waiting');
 assert.equal((await req('suggestions/'+detail.suggestions[0].id+'/review',member,'POST',{decision:'approve'})).status,409);assert.equal((await req('members/'+member.id,member)).private_update,null,'member proposal still pending');
 globalThis.fetch=originalFetch;
});
test('AI task suggestions require real task identity, verbatim quote and project manager approval',async()=>{
 const task=db.prepare('SELECT * FROM lab_tasks WHERE project_id=?').get(project);
 const text='The recruitment task is now ready to proceed after permission was obtained.';
 const cleaned=validateProposals({updates:[{entity_type:'task',entity_id:task.id,status:'active',summary:'Permission discussed',source_quote:'The recruitment task is now ready to proceed'}]},text);assert.equal(cleaned.length,1);assert.equal(cleaned[0].entity_type,'task');
 const missing=validateProposals({updates:[{entity_type:'task',entity_id:'unknown',status:'done',source_quote:text}]},text);assert.equal(missing.length,0);
});
