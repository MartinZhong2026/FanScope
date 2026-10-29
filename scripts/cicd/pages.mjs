// Trusted default-branch code only. Never execute code from a PR artifact.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyPagesRelease} from '../verify-pages-release.mjs';
import {gallery} from './preview-gallery.mjs';

export function assertSingleChannel(project,{requireGitSource=false}={}){
 if(project.production_branch!=='main')throw Error('Expected main production branch');
 if(requireGitSource&&(!project.source||project.source.type!=='github'||
    project.source.config?.owner?.toLowerCase()!=='martinzhong2026'||project.source.config?.repo_name?.toLowerCase()!=='fanscope'))
  throw Error('Existing fanscope Git source must be identifiable as MartinZhong2026/FanScope');
 if(project.source){
  const c=project.source.config;
  if(!c||c.production_deployments_enabled!==false||c.preview_deployment_setting!=='none')
   throw Error('Disable BOTH production and preview Git automatic deployments before enabling Actions');
 }
}
export function validateArtifact(dir,sha){
 const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){
  if(e.isSymbolicLink())throw Error('Artifact symlink rejected');
  if(e.isDirectory()){if(e.name==='functions')throw Error('Executable Pages artifact rejected');walk(path.join(d,e.name));}
  else if(!e.isFile()||e.name==='_worker.js'||e.name==='_routes.json'||d.split(path.sep).includes('functions'))throw Error('Executable Pages artifact rejected');
 }};
 walk(dir);verifyPagesRelease(dir);
 const m=JSON.parse(fs.readFileSync(`${dir}/release.json`));
 if(m.commit!==sha)throw Error('Artifact SHA mismatch');
}
export function previewAddress(subdomain,branch){
 if(!/^pr-[1-9][0-9]*$/.test(branch)||!/^fanscope-preview(?:-[a-z0-9]+)*\.pages\.dev$/.test(subdomain||''))
  throw Error('Unexpected Pages preview subdomain or branch');
 return `https://${branch}.${subdomain}`;
}
const env=process.env;
function safeMessage(value){
 let text=typeof value==='string'?value:'Unspecified Cloudflare error';
 // Errors can echo credentials or account identifiers. Never log response bodies,
 // request/response headers, project environment variables or fetch exceptions.
 for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID']){
  const secret=env[key];
  if(secret)for(const form of [secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64')])text=text.split(form).join('[REDACTED]');
 }
 return text.replace(/(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi,'[REDACTED HEADER]')
  .replace(/\bBearer\s+[^\s,;]+/gi,'Bearer [REDACTED]')
  .replace(/\b(?:[\w-]*(?:token|secret|password)|api[-_ ]?key)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'[REDACTED CREDENTIAL]')
  .replace(/https?:\/\/[^\s<>"']+/gi,'[REDACTED URL]')
  .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[REDACTED EMAIL]')
  .replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').slice(0,400);
}
export async function cf(endpoint,method='GET',{envelope=false}={}){
 const safeEndpoint=endpoint.replace(/(\/deployments\/)([a-f0-9-]{36})(?=\/|$)/gi,(_,prefix,id)=>prefix+maskedDeploymentId(id));
 const route=`/accounts/<account_id>/pages/projects/${env.PAGES_PROJECT}${safeEndpoint}`;
 const fail=(status,reason,body)=>{
  const errors=Array.isArray(body?.errors)?body.errors.slice(0,5).map(e=>({
   code:Number.isSafeInteger(e?.code)?e.code:null,message:safeMessage(e?.message)
  })):[];
  const diagnostic={method,endpoint:route,status,reason,errors};
  console.error(`Cloudflare diagnostic: ${JSON.stringify(diagnostic)}`);
  return Error(`Cloudflare request failed: ${method} ${route}: HTTP ${status}; ${reason}; ${JSON.stringify(errors)}`);
 };
 let r;
 try{r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${env.PAGES_PROJECT}${endpoint}`,{method,headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`},signal:AbortSignal.timeout(30000),redirect:'error'});}
 catch{throw fail('unavailable','Network request failed or timed out');}
 let j;
 try{j=await r.json();}catch{throw fail(r.status,'Non-JSON Cloudflare response (body omitted)');}
 if(!r.ok||j?.success!==true)throw fail(r.status,'Cloudflare API rejected request',j);
 if(!Object.hasOwn(j,'result')||j.result===null)throw fail(r.status,'Invalid Cloudflare result envelope');
 console.log(`Cloudflare request: ${JSON.stringify({method,endpoint:route,status:r.status})}`);
 return envelope?j:j.result;
}
export async function productionDeployments(){
 // Avoid the large page size in the failed first publish. Keep pagination
 // metadata outside result; total_count may describe unfiltered deployments.
 const perPage=25,deployments=[],seen=new Set();
 for(let page=1;page<=100;page++){
  const body=await cf(`/deployments?env=production&per_page=${perPage}&page=${page}`,'GET',{envelope:true});
  const rows=body.result,info=body.result_info;
  if(!Array.isArray(rows))throw Error('Invalid Pages deployments result: expected array');
  const size=info?.per_page??perPage,total=info?.total_pages;
  if((info!==undefined&&(!info||typeof info!=='object'||Array.isArray(info)))||
     !Number.isSafeInteger(size)||size<1||size>perPage||rows.length>size||
     (info?.page!==undefined&&info.page!==page)||
     (total!==undefined&&(!Number.isSafeInteger(total)||total<0||(total<page&&!(page===1&&total===0&&rows.length===0)))))
   throw Error('Invalid Pages deployments pagination');
  for(const d of rows){
   if(!d||!UUID.test(d.id||'')||d.environment!=='production'||seen.has(d.id))
    throw Error('Invalid or repeated production deployment in Pages list');
   seen.add(d.id);deployments.push(d);
  }
  if(total!==undefined? page>=total : rows.length<size)return deployments;
  if(!rows.length)throw Error('Incomplete Pages deployments pagination');
 }
 throw Error('Pages deployments pagination limit exceeded; refusing incomplete production history');
}
const STAGE_NAMES=new Set(['queued','initialize','clone_repo','build','deploy']);
const STAGE_STATUSES=new Set(['success','failure','canceled','skipped','idle','active']);
const TERMINAL_STATUSES=new Set(['failure','canceled','skipped']);
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const maskedDeploymentId=id=>UUID.test(id||'')?`${id.slice(0,8)}-…-${id.slice(-12)}`:'[invalid UUID]';
export function deploymentSnapshot(d){
 // Explicit allowlist: API deployment objects also contain env_vars and source
 // metadata. Never serialize the deployment object or arbitrary field strings.
 const date=value=>timestamp(value)===null?null:new Date(timestamp(value)).toISOString();
 return {id:maskedDeploymentId(d?.id),status:STAGE_STATUSES.has(d?.latest_stage?.status)?d.latest_stage.status:'unknown',
  stage:STAGE_NAMES.has(d?.latest_stage?.name)?d.latest_stage.name:'unknown',
  started_on:date(d?.latest_stage?.started_on),ended_on:date(d?.latest_stage?.ended_on),
  created_on:date(d?.created_on),modified_on:date(d?.modified_on),
  is_skipped:typeof d?.is_skipped==='boolean'?d.is_skipped:null};
}
export function productionDeploymentState(d,{now=Date.now()}={}){
 const state=(kind,reason)=>({kind,reason});
 const latest=d?.latest_stage,status=latest?.status;
 if(!d||!UUID.test(d.id||'')||d.environment!=='production'||!STAGE_NAMES.has(latest?.name)||!STAGE_STATUSES.has(status))
  return state('unknown','missing-or-unrecognized-deployment-stage');
 // A successful intermediate stage is not a completed deployment.
 if(TERMINAL_STATUSES.has(status)||(status==='success'&&latest.name==='deploy'))
  return state('completed',status==='success'?'deploy-success':`stage-${status}`);
 const stages=Array.isArray(d.stages)?d.stages:[];
 const activeStages=[latest,...stages].filter(s=>s?.status==='active');
 const openActive=activeStages.some(s=>s.ended_on==null);
 const startedOpenActive=activeStages.some(s=>s.started_on!=null&&s.ended_on==null);
 if(activeStages.some(s=>s.started_on!=null&&(timestamp(s.started_on)===null||
    (s.ended_on!=null&&(timestamp(s.ended_on)===null||timestamp(s.ended_on)<timestamp(s.started_on))))))
  return state('unknown','inconsistent-active-stage-timestamps');
 if(d.is_skipped===true){
  if(startedOpenActive)return state('unknown','skipped-deployment-has-open-active-stage');
  return state('historical','explicitly-skipped-deployment');
 }
 // The API can leave unused stages idle. A finished final deploy stage is
 // positive completion evidence; age or a newer successful deployment is not.
 const finished=stages.some(s=>STAGE_NAMES.has(s?.name)&&
  (TERMINAL_STATUSES.has(s.status)||(s.name==='deploy'&&s.status==='success'))&&timestamp(s.ended_on)!==null);
 if(finished){
  if(openActive)return state('unknown','terminal-stage-conflicts-with-open-active-stage');
  return state('historical','finished-stage-with-stale-latest-stage');
 }
 const created=timestamp(d.created_on),modified=timestamp(d.modified_on),started=timestamp(latest.started_on);
 if(created===null||modified===null||modified<created||modified>now||created>now||
    (latest.started_on!=null&&(started===null||started<created||started>modified))||latest.ended_on!=null)
  return state('unknown','incomplete-or-inconsistent-stage-timestamps');
 // This horizon changes only the diagnostic: stale records stay blocked as
 // unknown and NEVER become safe merely because a timeout elapsed.
 if(now-modified>60*60*1000)return state('unknown','stale-nonterminal-deployment-needs-investigation');
 if(d.is_skipped!==false)return state('unknown','missing-deployment-skip-state');
 if(status==='active'&&started!==null)return state('running','active-stage-without-end');
 if(status==='idle'&&latest.name==='queued'&&started===null)return state('running','queued-deployment');
 return state('unknown','nonterminal-stage-without-completion-evidence');
}
export async function assertProductionQuiescent(deployments,{now=Date.now()}={}){
 const blocked=[],checked=[];
 const log=(source,d,result)=>console.log(`Pages deployment ${source} (${result.kind}/${result.reason}): ${JSON.stringify(deploymentSnapshot(d))}`);
 for(const listed of deployments){
  let d=listed,result=productionDeploymentState(d,{now});log('list',d,result);
  if(result.kind!=='completed'){
   // Resolve list snapshots against the single-deployment endpoint before
   // accepting skipped/completed history or diagnosing an apparent active job.
   d=await cf(`/deployments/${listed.id}`);
   if(d.id!==listed.id||d.environment!=='production')throw Error(`Production deployment detail identity mismatch: ${maskedDeploymentId(listed.id)}`);
   result=productionDeploymentState(d,{now});log('detail',d,result);
  }
  checked.push(d);
  if(!['completed','historical'].includes(result.kind))blocked.push(`${maskedDeploymentId(d.id)} (${result.kind}/${result.reason})`);
 }
 if(blocked.length)throw Error(`Production deployment preflight blocked: ${blocked.join('; ')}. Running records must finish; unknown records require investigation, not an automatic timeout bypass. Keep both CD switches disabled; match the masked UUID and stage timestamps in Cloudflare Deployments, confirm the final deployment status, then rerun inspect. Do not delete deployment history or bypass the guard.`);
 return checked;
}
export async function smoke(base,sha,{marker=true}={}){
 const paths=[['/','html'],['/lab/','html'],['/config.js','config'],...(marker?[['/release.json','release']]:[])];
 for(const [p,kind] of paths){
  const r=await fetch(base+p+`?release=${sha}`,{signal:AbortSignal.timeout(15000),redirect:'error',headers:{'Cache-Control':'no-cache'}});
  if(!r.ok)throw Error(`Smoke ${p}: HTTP ${r.status}`);
  const t=await r.text();
  if(kind==='html'&&!/FanScope/i.test(t))throw Error('Page identity missing');
  if(kind==='config'&&!t.includes('https://fanscope-api.adapttochina.com'))throw Error('Production API config mismatch');
  if(kind==='release'&&JSON.parse(t).commit!==sha)throw Error('Stale release served');
 }
}
async function eventually(check){
 let error;
 for(let attempt=0;attempt<12;attempt++){
  try{return await check();}catch(e){error=e;if(attempt<11)await new Promise(resolve=>setTimeout(resolve,5000));}
 }
 throw error;
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function liveRevision(){
 const r=await fetch('https://fanscope.pages.dev/release.json?verify=current',{
  signal:AbortSignal.timeout(15000),redirect:'error',headers:{'Cache-Control':'no-cache'}});
 if(r.status===404)return null; // The pre-V1.6 site had no release marker.
 if(!r.ok)throw Error(`Current release marker: HTTP ${r.status}`);
 const body=await r.text();
 // Pages can serve its SPA fallback with HTTP 200 for a missing legacy marker.
 if(/^\s*<!doctype html/i.test(body))return null;
 let marker;try{marker=JSON.parse(body);}catch{throw Error('Current release marker is invalid');}
 const sha=marker.commit;
 if(!/^[a-f0-9]{40}$/.test(sha||''))throw Error('Current release marker is invalid');
 return sha;
}
function successfulProduction(d){return d&&UUID.test(d.id||'')&&d.environment==='production'&&d.latest_stage?.status==='success';}
async function verifyServedDeployment(target){
 if(!successfulProduction(target))throw Error('Successful production deployment required');
 const u=new URL(target.url);
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||!/^[-a-z0-9]+\.fanscope\.pages\.dev$/.test(u.hostname))
  throw Error('Unexpected immutable production deployment URL');
 // Compare the public site with the immutable target, including the main JS.
 // This also supports a pre-V1.6 deployment that has no release marker.
 for(const p of ['/','/app.js','/config.js','/lab/','/lab/app.js']){
  const options={signal:AbortSignal.timeout(15000),redirect:'error',headers:{'Cache-Control':'no-cache'}};
  const [a,b]=await Promise.all([fetch('https://fanscope.pages.dev'+p+'?verify=rollback',options),fetch(u.origin+p+'?verify=rollback',options)]);
  if(!a.ok||!b.ok)throw Error(`Deployment comparison ${p}: HTTP ${a.status}/${b.status}`);
  const [left,right]=await Promise.all([a.arrayBuffer(),b.arrayBuffer()]);
  if(left.byteLength>8*1024*1024||right.byteLength>8*1024*1024||!Buffer.from(left).equals(Buffer.from(right)))
   throw Error(`Public content differs from reviewed deployment: ${p}`);
 }
 await smoke('https://fanscope.pages.dev',target.deployment_trigger?.metadata?.commit_hash||target.id,{marker:false});
}
async function activeProduction(project,deployments){
 const live=await liveRevision();
 const candidates=[project.canonical_deployment,...deployments].filter(successfulProduction);
 const unique=[...new Map(candidates.map(d=>[d.id,d])).values()];
 const matches=live?unique.filter(d=>d.deployment_trigger?.metadata?.commit_hash===live):[];
 let selected=matches.length===1?matches[0]:null;
 if(!selected){
  const id=env.PAGES_CURRENT_DEPLOYMENT_ID;
  if(!UUID.test(id||''))throw Error('Set pages-production PAGES_CURRENT_DEPLOYMENT_ID to the active deployment UUID after checking the Cloudflare dashboard');
  selected=await cf(`/deployments/${id}`);
  if(selected.id!==id||!successfulProduction(selected)||(live&&selected.deployment_trigger?.metadata?.commit_hash!==live))
   throw Error('Configured current deployment does not match the live release');
 }
 await verifyServedDeployment(selected);
 return selected;
}
async function restoreDeployment(target,retry=eventually){
 await cf(`/deployments/${target.id}/rollback`,'POST');
 await retry(()=>verifyServedDeployment(target));
}
const uploadAssets=(dir,branch,sha)=>execFileSync(process.execPath,['deploy/pages/node_modules/wrangler/bin/wrangler.js','pages','deploy',dir,'--project-name',env.PAGES_PROJECT,'--branch',branch,'--commit-hash',sha,'--commit-dirty=false'],{stdio:'inherit',env});
export async function runPages(action=process.argv[2],{upload=uploadAssets,retry=eventually}={}){
 const sha=env.RELEASE_SHA;
 if(!/^[a-f0-9]{40}$/.test(sha||''))throw Error('Full SHA required');
 if(!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID||''))throw Error('Account ID required');
 if(!['fanscope','fanscope-preview'].includes(env.PAGES_PROJECT))throw Error('Unexpected Pages project');
 const production=env.PAGES_PROJECT==='fanscope';
 const project=await cf('');
 if(project.name!==env.PAGES_PROJECT)throw Error('Pages project identity mismatch');
 assertSingleChannel(project,{requireGitSource:production});
 let deployments=[];
 if(production){
  deployments=await assertProductionQuiescent(await productionDeployments());
 }
 if(action==='inspect'){
  const active=production?await activeProduction(project,deployments):null;
  console.log(JSON.stringify({name:project.name,gitIntegrated:!!project.source,automaticDeploymentsDisabled:true,
   mostRecentProductionId:project.canonical_deployment?.id||null,activeProductionId:active?.id||null,productionDeploymentCount:deployments.length}));return;
 }
 if(action==='rollback'){
  if(!production||!UUID.test(env.DEPLOYMENT_ID||''))throw Error('Reviewed production deployment ID required');
  const target=await cf(`/deployments/${env.DEPLOYMENT_ID}`);
  if(target.environment!=='production'||target.latest_stage?.status!=='success')throw Error('Successful production deployment required');
  await restoreDeployment(target,retry);return;
 }
 if(action!=='deploy')throw Error('Expected inspect, deploy or rollback');
 const dir=production?'dist/production':'dist/preview';validateArtifact(dir,sha);
 if(!production){
  // Replace attacker-controlled policy/config with trusted files after extraction.
  fs.writeFileSync(`${dir}/config.js`,"window.FANSCOPE_CONFIG={API_BASE_URL:'https://preview-api.invalid'};\n");
  fs.writeFileSync(`${dir}/_headers`,"/*\n  Content-Security-Policy: default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; script-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  X-Robots-Tag: noindex, nofollow\n");
  // Pages redirects can escape preview policy; no Functions or redirects allowed.
  if(fs.existsSync(`${dir}/_redirects`))fs.unlinkSync(`${dir}/_redirects`);
  gallery('work/preview-evidence',dir,sha);
 }
 const previous=production?await activeProduction(project,deployments):null;
 if(production&&previous.deployment_trigger?.metadata?.commit_hash===sha){
  // A legacy Git deployment can have the same SHA but no verified V1.6 marker.
  // Only skip when the actual public artifact also passes the complete smoke.
  let verified=false;try{await smoke('https://fanscope.pages.dev',sha);verified=true;}
  catch{console.log('Existing SHA has no verified V1.6 artifact; publishing the checked bundle');}
  if(verified){console.log(`Production ${sha} is already verified; no duplicate deployment`);return;}
 }
 const branch=production?'main':`pr-${env.PR_NUMBER}`;
 if(!production&&!/^pr-[1-9][0-9]*$/.test(branch))throw Error('PR number required');
 try{
  await upload(dir,branch,sha);
  if(production)await retry(()=>smoke('https://fanscope.pages.dev',sha));
  else {
   const url=previewAddress(project.subdomain,branch);
   await retry(async()=>{const r=await fetch(url+'/?release='+sha,{signal:AbortSignal.timeout(15000)});
    if(!r.ok||!r.headers.get('content-security-policy')?.includes("connect-src 'none'")||!(await r.text()).includes(sha))throw Error('Preview HTTP/CSP/SHA verification failed');});
   console.log(`Preview: ${url} (browser acceptance gallery, scripts/API disabled)`);
   if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,`PR visual preview: ${url}\n`);
  }
 }catch(error){
  if(production){
   // Roll back only if this SHA owns the active deployment; never overwrite another release.
   let active=null;
   try{active=await liveRevision();}catch{console.error('Cannot identify the public version; use the reviewed manual rollback after investigation');}
   if(active===sha){
    await restoreDeployment(previous,retry);
    console.error(`Restored deployment ${previous.id}`);
   }
  }
  throw error;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await runPages();
