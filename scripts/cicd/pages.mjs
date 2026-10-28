// Trusted default-branch code only. Never execute code from a PR artifact.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyPagesRelease} from '../verify-pages-release.mjs';
import {gallery} from './preview-gallery.mjs';

export function assertSingleChannel(project){
 if(project.production_branch!=='main')throw Error('Expected main production branch');
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
const env=process.env;
async function cf(endpoint,method='GET'){
 const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${env.PAGES_PROJECT}${endpoint}`,{method,headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`},signal:AbortSignal.timeout(30000)});
 const j=await r.json();if(!r.ok||!j.success)throw Error(`Cloudflare request failed: HTTP ${r.status}`);return j.result;
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
async function restoreDeployment(target){
 await cf(`/deployments/${target.id}/rollback`,'POST');
 await eventually(async()=>{
  if((await cf('')).canonical_deployment?.id!==target.id)throw Error('Rollback deployment identity mismatch');
  // Pre-V1.6 releases have no release.json. The immutable Pages ID proves identity.
  await smoke('https://fanscope.pages.dev',target.deployment_trigger.metadata.commit_hash||target.id,{marker:false});
 });
}
async function main(){
 const action=process.argv[2],sha=env.RELEASE_SHA;
 if(!/^[a-f0-9]{40}$/.test(sha||''))throw Error('Full SHA required');
 if(!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID||''))throw Error('Account ID required');
 if(!['fanscope','fanscope-preview'].includes(env.PAGES_PROJECT))throw Error('Unexpected Pages project');
 const project=await cf('');assertSingleChannel(project);
 if(action==='inspect'){console.log(JSON.stringify({name:project.name,gitIntegrated:!!project.source,automaticDeploymentsDisabled:true}));return;}
 const production=env.PAGES_PROJECT==='fanscope';
 if(production&&action!=='inspect'){
  const deployments=await cf('/deployments?env=production');
  if(deployments.some(d=>d.environment==='production'&&!['success','failure','canceled','skipped'].includes(d.latest_stage?.status)))throw Error('A production deployment is still pending; wait before publishing or rolling back');
 }
 if(action==='rollback'){
  if(!production||!/^[-a-f0-9]{36}$/.test(env.DEPLOYMENT_ID||''))throw Error('Reviewed production deployment ID required');
  const target=await cf(`/deployments/${env.DEPLOYMENT_ID}`);
  if(target.environment!=='production'||target.latest_stage?.status!=='success')throw Error('Successful production deployment required');
  await restoreDeployment(target);return;
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
 const previous=project.canonical_deployment;
 if(production&&(!previous||previous.environment!=='production'||previous.latest_stage?.status!=='success'))throw Error('Verified previous production deployment required for rollback');
 const branch=production?'main':`pr-${env.PR_NUMBER}`;
 if(!production&&!/^pr-[1-9][0-9]*$/.test(branch))throw Error('PR number required');
 try{
  execFileSync(process.execPath,['deploy/pages/node_modules/wrangler/bin/wrangler.js','pages','deploy',dir,'--project-name',env.PAGES_PROJECT,'--branch',branch,'--commit-hash',sha,'--commit-dirty=false'],{stdio:'inherit',env});
  if(production)await eventually(()=>smoke('https://fanscope.pages.dev',sha));
  else {
   const url=`https://${branch}.fanscope-preview.pages.dev`;
   const r=await fetch(url+'/?release='+sha,{signal:AbortSignal.timeout(15000)});
   if(!r.ok||!r.headers.get('content-security-policy')?.includes("connect-src 'none'")||!(await r.text()).includes(sha))throw Error('Preview HTTP/CSP/SHA verification failed');
   console.log(`Preview: ${url} (browser acceptance gallery, scripts/API disabled)`);
   if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,`PR visual preview: ${url}\n`);
  }
 }catch(error){
  if(production){
   // Roll back only if this SHA owns the active deployment; never overwrite another release.
   const active=(await cf('')).canonical_deployment;
   if(active?.deployment_trigger?.metadata?.commit_hash===sha){
    await restoreDeployment(previous);
    console.error(`Restored deployment ${previous.id}`);
   }
  }
  throw error;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
