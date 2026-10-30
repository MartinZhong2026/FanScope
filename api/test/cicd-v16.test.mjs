import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertSingleChannel,smoke,validateArtifact,runPages,previewAddress} from '../../scripts/cicd/pages.mjs';
import {gallery} from '../../scripts/cicd/preview-gallery.mjs';
import {sourceForRun} from '../../scripts/cicd/pages-source.mjs';

test('Pages refuses ambiguous or enabled Git integration',()=>{
 assertSingleChannel({production_branch:'main'});
 assertSingleChannel({production_branch:'main',source:{config:{production_deployments_enabled:false,preview_deployment_setting:'none'}}});
 for(const config of [{},{production_deployments_enabled:true,preview_deployment_setting:'none'},{production_deployments_enabled:false,preview_deployment_setting:'all'}]){
  assert.throws(()=>assertSingleChannel({production_branch:'main',source:{config}}));
 }
 assert.throws(()=>assertSingleChannel({production_branch:'master'}));
 const config={production_deployments_enabled:false,preview_deployment_setting:'none',owner:'MartinZhong2026',repo_name:'FanScope'};
 assertSingleChannel({production_branch:'main',source:{type:'github',config}},{requireGitSource:true});
 assert.throws(()=>assertSingleChannel({production_branch:'main'},{requireGitSource:true}),/identifiable/);
 assert.throws(()=>assertSingleChannel({production_branch:'main',source:{type:'github',config:{...config,repo_name:'other'}}},{requireGitSource:true}),/identifiable/);
});
test('public smoke rejects wrong revision and non-HTML without any writes',async()=>{
 const original=globalThis.fetch,sha='a'.repeat(40);let requests=[];
 try{
  globalThis.fetch=async(url,options)=>{requests.push({url,options});return new Response(url.includes('release.json')?JSON.stringify({commit:sha}):url.includes('config.js')?'https://fanscope-api.adapttochina.com':'<title>FanScope</title>');};
  await smoke('https://synthetic.invalid',sha);
  assert.equal(requests.length,4);assert.ok(requests.every(r=>!r.options.method));
  await assert.rejects(smoke('https://synthetic.invalid','b'.repeat(40)),/Stale/);
  requests=[];await smoke('https://synthetic.invalid','legacy',{marker:false});assert.equal(requests.length,3);
  globalThis.fetch=async()=>new Response('unavailable',{status:503});
  await assert.rejects(smoke('https://synthetic.invalid',sha),/HTTP 503/);
 }finally{globalThis.fetch=original;}
});
test('privileged Pages publisher rejects Worker artifacts before upload',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-pages-security-'));
 try{
  fs.writeFileSync(path.join(dir,'_worker.js'),'export default {}');
  assert.throws(()=>validateArtifact(dir,'a'.repeat(40)),/Executable Pages/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('preview gallery accepts only PNG evidence and escapes untrusted labels',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-preview-gallery-'));
 try{
  const source=path.join(dir,'input'),output=path.join(dir,'output');fs.mkdirSync(source);fs.mkdirSync(output);
  fs.writeFileSync(path.join(source,'screen&.png'),Buffer.from('89504e470d0a1a0a','hex'));
  fs.writeFileSync(path.join(source,'attack.html'),'<script>fetch("https://invalid.example")</script>');
  assert.equal(gallery(source,output,'a'.repeat(40)),1);
  const html=fs.readFileSync(path.join(output,'index.html'),'utf8');assert.ok(html.includes('screen&amp;.png'));assert.ok(!html.includes('<script>'));
  assert.equal(fs.readdirSync(path.join(output,'evidence')).length,1);
  fs.writeFileSync(path.join(source,'invalid.png'),'not PNG');
  assert.throws(()=>gallery(source,output,'a'.repeat(40)),/Invalid/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Pages source gate: deploys main and frontend PRs to main, skips harmless cases, fails untrusted sources',()=>{
 const sha='a'.repeat(40),other='b'.repeat(40),base={path:'.github/workflows/test.yml',conclusion:'success',repository:{full_name:'MartinZhong2026/FanScope'},head_sha:sha};
 const web=['web/lab/app.js'],api=['api/src/db.mjs','docs/x.md'];
 assert.equal(sourceForRun({...base,event:'push',head_branch:'main'},sha).mode,'production');
 const pr={number:3,state:'open',head:{sha},base:{ref:'main'}};
 assert.deepEqual(sourceForRun({...base,event:'pull_request'},other,pr,web),{mode:'preview',project:'fanscope-preview',sha,artifact:'pages-preview',pr:'3'});
 assert.equal(sourceForRun({...base,event:'pull_request'},other,pr,null).mode,'preview','unknown/oversized file list counts as a site change');
 assert.equal(sourceForRun({...base,event:'pull_request'},other,pr,['scripts/cicd/build-pages.mjs']).mode,'preview');
 // Expected, harmless situations end green without deploying.
 const skipped=(run,p,files)=>{const v=sourceForRun(run,sha,p,files);assert.equal(v.mode,'skip');assert.equal(v.sha,'');return v.reason};
 assert.equal(skipped({...base,event:'pull_request'},{...pr,base:{ref:'feat/versioned-additive-migrations'}},web),'stacked-pr-base-feat/versioned-additive-migrations');
 assert.equal(skipped({...base,event:'pull_request'},{...pr,state:'closed'},web),'pr-closed');
 assert.equal(skipped({...base,event:'pull_request'},{...pr,head:{sha:other}},web),'pr-superseded');
 assert.equal(skipped({...base,event:'pull_request'},pr,api),'no-frontend-change');
 assert.equal(skipped({...base,event:'push',head_branch:'main',head_sha:other}),'superseded-main');
 // Untrusted or unsupported sources are still real failures.
 for(const run of [{...base,event:'merge_group'},{...base,event:'push',head_branch:'feature'},{...base,event:'push',head_branch:'main',conclusion:'cancelled'},
  {...base,event:'push',head_branch:'main',path:'.github/workflows/other.yml'},{...base,event:'push',head_branch:'main',repository:{full_name:'fork/FanScope'}}])assert.throws(()=>sourceForRun(run,sha));
 assert.throws(()=>sourceForRun({...base,event:'pull_request'},sha,undefined,web),/Associated PR required/);
});
test('preview aliases use the actual Cloudflare subdomain, including collision suffixes',()=>{
 assert.equal(previewAddress('fanscope-preview.pages.dev','pr-3'),'https://pr-3.fanscope-preview.pages.dev');
 assert.equal(previewAddress('fanscope-preview-abc123.pages.dev','pr-3'),'https://pr-3.fanscope-preview-abc123.pages.dev');
 assert.throws(()=>previewAddress('fanscope-preview.attacker.test','pr-3'));
 assert.throws(()=>previewAddress('fanscope-preview.pages.dev','main'));
});

async function pagesScenario({sameSha=false,legacy=false,legacySpa=false,badSmoke=false,gitEnabled=false,missingActiveId=false,
 history=false,pendingLater=false,listError=false,wrongCurrentId=false,contentMismatch=false,unownedFailure=false,
 historicalIdle=false,unknownState=false,canceled=false,action='deploy'}={}){
 const cwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-pages-flow-')),fetch=globalThis.fetch;
 const vars={CLOUDFLARE_ACCOUNT_ID:'0'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-test-only',PAGES_PROJECT:'fanscope',RELEASE_SHA:'a'.repeat(40),DEPLOYMENT_ID:'11111111-1111-1111-1111-111111111111',PAGES_CURRENT_DEPLOYMENT_ID:missingActiveId?'':'11111111-1111-1111-1111-111111111111'};
 const previous=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));
 let uploads=0,rollbacks=0,uploaded=false;
 const old={id:'11111111-1111-1111-1111-111111111111',url:'https://11111111.fanscope.pages.dev',environment:'production',latest_stage:{name:'deploy',status:'success'},deployment_trigger:{metadata:{commit_hash:sameSha?vars.RELEASE_SHA:'b'.repeat(40)}}};
 const pending={...old,created_on:new Date(Date.now()-120000).toISOString(),modified_on:new Date().toISOString(),is_skipped:false,
  latest_stage:{name:'build',status:'active',started_on:new Date(Date.now()-60000).toISOString(),ended_on:null}};
 const extra={...old,id:'55555555-5555-5555-5555-555555555555',is_skipped:historicalIdle,
  created_on:'2026-01-01T00:00:00Z',modified_on:'2026-01-01T00:00:00Z',
  latest_stage:{name:'queued',status:canceled?'canceled':unknownState?'unexpected':'idle',started_on:null,ended_on:null}};
 const earlier=Array.from({length:25},(_,i)=>({...old,id:`33333333-3333-3333-3333-${String(i).padStart(12,'0')}`,deployment_trigger:{metadata:{commit_hash:'c'.repeat(40)}}}));
 let active=old,latest=history||pendingLater?earlier[0]:old;
 try{
  Object.assign(process.env,vars);process.chdir(dir);
  const artifact=path.join(dir,'dist/production');fs.mkdirSync(artifact,{recursive:true});
  for(const f of ['index.html','config.js','chinese-quality.mjs','chinese-diagnostics.mjs','404.html'])fs.writeFileSync(path.join(artifact,f),'safe');
  fs.writeFileSync(path.join(artifact,'app.js'),'function chinesePanel(edit=false){edit=false;}');
  fs.writeFileSync(path.join(artifact,'release.json'),JSON.stringify({commit:vars.RELEASE_SHA}));
  globalThis.fetch=async(url,options={})=>{
   const u=new URL(url);
   if(u.hostname==='api.cloudflare.com'){
    if(u.pathname.endsWith('/rollback')){rollbacks++;active=old;return Response.json({success:true,result:old});}
    if(u.pathname.endsWith('/deployments')){
     assert.equal(u.searchParams.get('env'),'production');assert.equal(u.searchParams.get('per_page'),'25');
     if(listError)return Response.json({success:false,errors:[{code:10000,message:'Authentication error'}]},{status:403});
     const page=Number(u.searchParams.get('page')),multiple=history||pendingLater;
     return Response.json({success:true,result:multiple?(page===1?earlier:[pendingLater?pending:old]):historicalIdle||unknownState||canceled?[old,extra]:[old],
      result_info:{page,per_page:25,total_pages:multiple?2:1}});
    }
    if(u.pathname.endsWith('/deployments/'+extra.id))return Response.json({success:true,result:extra});
    if(u.pathname.endsWith('/deployments/'+old.id))return Response.json({success:true,result:pendingLater?pending:wrongCurrentId?{...old,id:'44444444-4444-4444-4444-444444444444'}:old});
    return Response.json({success:true,result:{name:'fanscope',production_branch:'main',canonical_deployment:latest,
     source:{type:'github',config:{owner:'MartinZhong2026',repo_name:'FanScope',production_deployments_enabled:gitEnabled,preview_deployment_setting:'none'}}}});
   }
   assert.ok(['fanscope.pages.dev','11111111.fanscope.pages.dev'].includes(u.hostname));assert.equal(options.method,undefined);
   if(badSmoke&&uploaded&&active.id!==old.id&&u.hostname==='fanscope.pages.dev'&&u.pathname==='/')return new Response('unavailable',{status:503});
   if(contentMismatch&&u.hostname==='11111111.fanscope.pages.dev'&&u.pathname==='/app.js')return new Response('different artifact');
   if(u.pathname==='/release.json')return legacy&&!uploaded?(legacySpa?new Response('<!DOCTYPE html><title>FanScope</title>'):new Response('missing',{status:404})):Response.json({commit:(u.hostname==='fanscope.pages.dev'?active:old).deployment_trigger.metadata.commit_hash});
   return new Response(u.pathname==='/config.js'?'https://fanscope-api.adapttochina.com':'<title>FanScope</title>');
  };
  const invoke=()=>runPages(action,{retry:check=>check(),upload:()=>{
   uploads++;uploaded=true;active={...old,id:'22222222-2222-2222-2222-222222222222',deployment_trigger:{metadata:{commit_hash:vars.RELEASE_SHA}}};latest=active;
   if(unownedFailure){active=old;throw Error('Upload interrupted before this SHA became active');}
  }});
  const expected=gitEnabled?/Disable BOTH/:missingActiveId&&legacy?/PAGES_CURRENT_DEPLOYMENT_ID/:pendingLater?/running\/active-stage-without-end/:unknownState?/unknown\/missing-or-unrecognized/:
   listError?/HTTP 403/:wrongCurrentId?/does not match/:contentMismatch?/differs from reviewed/:unownedFailure?/Upload interrupted/:badSmoke?/HTTP 503/:null;
  if(expected)await assert.rejects(invoke(),expected);
  else await invoke();
  return {uploads,rollbacks,active:active.id,old:old.id};
 }finally{
  globalThis.fetch=fetch;process.chdir(cwd);
  for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  fs.rmSync(dir,{recursive:true,force:true});
 }
}
test('repeated successful main CI does not redeploy a verified production SHA',async()=>{
 assert.equal((await pagesScenario({sameSha:true})).uploads,0);
 assert.equal((await pagesScenario({sameSha:true,legacy:true})).uploads,1);
 assert.equal((await pagesScenario({sameSha:true,legacy:true,legacySpa:true})).uploads,1);
});
test('legacy production without an identified active deployment fails closed',async()=>{
 const result=await pagesScenario({legacy:true,missingActiveId:true});
 assert.equal(result.uploads,0);assert.equal(result.rollbacks,0);
});
test('enabled Git integration blocks upload and failed new smoke restores the previous deployment',async()=>{
 assert.equal((await pagesScenario({gitEnabled:true})).uploads,0);
 const result=await pagesScenario({badSmoke:true});
 assert.equal(result.uploads,1);assert.equal(result.rollbacks,1);assert.equal(result.active,result.old);
});
test('manual inspection performs no upload/rollback and manual rollback supports legacy artifacts',async()=>{
 const inspection=await pagesScenario({action:'inspect'});
 assert.equal(inspection.uploads,0);assert.equal(inspection.rollbacks,0);
 const rollback=await pagesScenario({action:'rollback',legacy:true});
 assert.equal(rollback.uploads,0);assert.equal(rollback.rollbacks,1);assert.equal(rollback.active,rollback.old);
});

test('production preflight finds the active deployment and pending jobs beyond the first page',async()=>{
 assert.equal((await pagesScenario({history:true,missingActiveId:true})).uploads,1);
 for(const action of ['inspect','deploy','rollback']){
  const blocked=await pagesScenario({pendingLater:true,action});
  assert.equal(blocked.uploads,0);assert.equal(blocked.rollbacks,0);
 }
});

test('inspection exercises list permissions and current deployment checks without writes',async()=>{
 for(const options of [{listError:true},{legacy:true,wrongCurrentId:true},{contentMismatch:true},{legacy:true,missingActiveId:true}]){
  const result=await pagesScenario({...options,action:'inspect'});
  assert.equal(result.uploads,0);assert.equal(result.rollbacks,0);
 }
});

test('an interrupted upload cannot roll back another active production version',async()=>{
 const result=await pagesScenario({unownedFailure:true});
 assert.equal(result.uploads,1);assert.equal(result.rollbacks,0);assert.equal(result.active,result.old);
});

test('skipped historical idle and canceled deployments do not block inspect, publish or deduplication',async()=>{
 for(const history of [{historicalIdle:true},{canceled:true}]){
  const inspected=await pagesScenario({...history,action:'inspect'});
  assert.equal(inspected.uploads,0);assert.equal(inspected.rollbacks,0);
  assert.equal((await pagesScenario(history)).uploads,1);
  assert.equal((await pagesScenario({...history,sameSha:true})).uploads,0);
  const failed=await pagesScenario({...history,badSmoke:true});
  assert.equal(failed.rollbacks,1);assert.equal(failed.active,failed.old);
 }
});

test('unknown deployment state blocks inspection, deployment and rollback without writes',async()=>{
 for(const action of ['inspect','deploy','rollback']){
  const result=await pagesScenario({unknownState:true,action});
  assert.equal(result.uploads,0);assert.equal(result.rollbacks,0);
 }
});
