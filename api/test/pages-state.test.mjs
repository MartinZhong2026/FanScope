import test from 'node:test';
import assert from 'node:assert/strict';
import {productionDeploymentState as classify,assertProductionQuiescent,deploymentSnapshot} from '../../scripts/cicd/pages.mjs';

const now=Date.parse('2026-10-29T05:00:00Z');
const stage=(name='deploy',status='success',extra={})=>({name,status,started_on:'2026-10-29T04:58:00Z',ended_on:'2026-10-29T04:59:00Z',...extra});
const deployment=(extra={})=>({id:'12345678-1111-2222-3333-123456789012',environment:'production',is_skipped:false,
 created_on:'2026-10-29T04:57:00Z',modified_on:'2026-10-29T04:59:00Z',latest_stage:stage(),stages:[stage()],...extra});
const state=d=>classify(d,{now});
const idle=()=>deployment({latest_stage:stage('queued','idle',{started_on:null,ended_on:null}),stages:[]});
const active=()=>deployment({latest_stage:stage('build','active',{ended_on:null}),stages:[]});

test('deployment completion uses terminal stage semantics, not success of an intermediate stage',()=>{
 for(const status of ['success','failure','canceled','skipped'])assert.equal(state(deployment({latest_stage:stage('deploy',status)})).kind,'completed');
 assert.equal(state(deployment({latest_stage:stage('build','success'),stages:[]})).kind,'unknown');
 assert.equal(state(deployment({latest_stage:stage('build','canceled')})).kind,'completed');
});

test('historical idle requires explicit skip or finished-stage evidence, never age alone',()=>{
 const old={created_on:'2025-01-01T00:00:00Z',modified_on:'2025-01-01T00:00:00Z'};
 assert.deepEqual(state({...idle(),...old,is_skipped:true}),{kind:'historical',reason:'explicitly-skipped-deployment'});
 assert.equal(state({...idle(),...old,is_skipped:true,stages:[stage('queued','active',{started_on:null,ended_on:null})]}).kind,'historical','an unstarted placeholder does not override explicit skip evidence');
 assert.equal(state({...idle(),stages:[stage()]}).kind,'historical');
 assert.equal(state({...idle(),...old}).kind,'unknown');
 assert.equal(state({...active(),...old,latest_stage:stage('build','active',{started_on:'2025-01-01T00:00:00Z',ended_on:null})}).kind,'unknown');
 assert.equal(state({...active(),latest_stage:stage('build','active')}).kind,'unknown','ended stage does not prove the whole deployment finished');
});

test('fresh active and queued deployments remain blocked; contradictions and incomplete records are unknown',()=>{
 assert.deepEqual(state(active()),{kind:'running',reason:'active-stage-without-end'});
 assert.deepEqual(state(idle()),{kind:'running',reason:'queued-deployment'});
 for(const d of [
  {...active(),is_skipped:true},{...active(),stages:[stage()]},{...idle(),latest_stage:null},
  {...active(),latest_stage:stage('build','active',{started_on:null,ended_on:null}),stages:[stage()]},
  {...idle(),is_skipped:true,stages:[stage('build','active',{ended_on:'invalid'})]},
  {...idle(),is_skipped:undefined},{...idle(),latest_stage:stage('build','idle',{started_on:null,ended_on:null})},
  {...active(),latest_stage:stage('build','active',{started_on:null,ended_on:null})},
  {...active(),latest_stage:stage('build','active',{started_on:'invalid',ended_on:null})},
  {...active(),latest_stage:stage('unknown','active',{ended_on:null})},
  {...active(),created_on:'invalid'},{...active(),modified_on:'2026-10-29T05:01:00Z'},
  {...idle(),is_skipped:true,stages:[stage('build','active',{ended_on:null})]}
 ])assert.equal(state(d).kind,'unknown');
});

async function preflight(list,details,check){
 const originalFetch=globalThis.fetch,originalLog=console.log;
 const vars={CLOUDFLARE_ACCOUNT_ID:'0'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-state-test',PAGES_PROJECT:'fanscope'};
 const previous=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]])),logs=[],requests=[];
 try{
  Object.assign(process.env,vars);console.log=(...args)=>logs.push(args.join(' '));
  globalThis.fetch=async(url,options)=>{
   const u=new URL(url);requests.push(u.pathname);
   assert.equal(u.hostname,'api.cloudflare.com');assert.equal(options.method,'GET');
   assert.ok(u.pathname.endsWith('/deployments/'+list[0].id));
   return Response.json({success:true,result:details});
  };
  await check({invoke:()=>assertProductionQuiescent(list,{now}),logs,requests});
 }finally{
  globalThis.fetch=originalFetch;console.log=originalLog;
  for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
}

test('preflight refetches apparent active history and uses the authoritative completed result',async()=>{
 await preflight([active()],deployment(),async({invoke,requests})=>{
  const checked=await invoke();assert.equal(checked[0].latest_stage.status,'success');assert.equal(requests.length,1);
 });
 await preflight([deployment()],null,async({invoke,requests})=>{await invoke();assert.equal(requests.length,0);});
 await preflight([{...idle(),is_skipped:true}],{...idle(),is_skipped:true},async({invoke,requests})=>{await invoke();assert.equal(requests.length,1);});
});

test('preflight rejects running, stale unresolved, conflicting, changed identity and detail-read failures',async()=>{
 for(const detail of [active(),idle(),{...active(),modified_on:'2026-10-29T03:00:00Z'},
  {...idle(),is_skipped:true,stages:[stage('build','active',{ended_on:null})]},
  {...deployment(),id:'87654321-1111-2222-3333-123456789012'},{...deployment(),environment:'preview'}])
  await preflight([active()],detail,async({invoke})=>{await assert.rejects(invoke(),/preflight blocked|identity mismatch/);});
 await preflight([active()],null,async({invoke})=>{await assert.rejects(invoke(),/Invalid Cloudflare result/);});
 await preflight([{...idle(),is_skipped:true}],active(),async({invoke})=>{
  await assert.rejects(invoke(),/running\/active-stage-without-end/);
 });
});

test('deployment diagnostics serialize only allowed fields and masked IDs, never raw API metadata',async()=>{
 const dangerous={...idle(),is_skipped:true,env_vars:{PRIVATE:'do-not-log'},source:{config:{password:'do-not-log'}},
  url:'https://private.invalid',deployment_trigger:{metadata:{commit_message:'do-not-log'}}};
 assert.deepEqual(Object.keys(deploymentSnapshot(dangerous)),['id','status','stage','created_on','modified_on','ended_on','is_skipped']);
 await preflight([dangerous],dangerous,async({invoke,logs})=>{
  await invoke();const output=logs.join('\n');
  for(const privateValue of ['do-not-log','private.invalid',dangerous.id,'env_vars','password','commit_message'])assert.ok(!output.includes(privateValue));
  assert.match(output,/12345678-…-123456789012/);assert.match(output,/explicitly-skipped-deployment/);
 });
 assert.equal(deploymentSnapshot({...dangerous,created_on:'do-not-log',latest_stage:{name:'do-not-log',status:'do-not-log'}}).status,'unknown');
});
