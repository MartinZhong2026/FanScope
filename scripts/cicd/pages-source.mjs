import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Files whose change can alter the published site. A PR touching none of them
// gets no preview: the static preview would be identical to main's.
export const FRONTEND_PATHS=[/^web\//,/^scripts\/cicd\/(build-pages|pages|preview-gallery)\.mjs$/,/^scripts\/(prepare-chinese-pages-release|verify-pages-release)\.mjs$/,/^deploy\/pages\//];
export const touchesFrontend=files=>files==null||files.some(f=>FRONTEND_PATHS.some(re=>re.test(f)));
const skip=reason=>({mode:'skip',project:'',sha:'',artifact:'',pr:'',reason});

// Untrusted or malformed sources throw (a real failure). Expected, harmless
// situations return mode 'skip' so the run ends green without deploying:
// stacked PRs not targeting main, PRs closed or superseded while CI ran,
// main superseded by a newer commit, and PRs that change nothing the site is
// built from. `files` null means "unknown/too many": treated as a site change.
export function sourceForRun(r,head,pr,files=null){
 if(r.path!=='.github/workflows/test.yml'||r.conclusion!=='success'||r.repository?.full_name!=='MartinZhong2026/FanScope')throw Error('Untrusted source workflow');
 if(r.event==='push'){
  if(r.head_branch!=='main')throw Error('Untrusted production branch');
  // The newer main commit has its own run and publishes instead.
  if(r.head_sha!==head)return skip('superseded-main');
  return {mode:'production',project:'fanscope',sha:head,artifact:'pages-production',pr:''};
 }
 if(r.event!=='pull_request')throw Error('Unsupported source trigger');
 if(!pr)throw Error('Associated PR required');
 if(pr.base.ref!=='main')return skip('stacked-pr-base-'+pr.base.ref);
 if(pr.state!=='open')return skip('pr-closed');
 if(pr.head.sha!==r.head_sha)return skip('pr-superseded');
 if(!touchesFrontend(files))return skip('no-frontend-change');
 return {mode:'preview',project:'fanscope-preview',sha:r.head_sha,artifact:'pages-preview',pr:String(pr.number)};
}
function main(){
const e=JSON.parse(fs.readFileSync(process.env.EVENT_PATH));
const repo=process.env.GITHUB_REPOSITORY;
if(repo!=='MartinZhong2026/FanScope')throw Error('Unexpected repository');
const api=p=>JSON.parse(execFileSync('gh',['api',`repos/${repo}/${p}`],{encoding:'utf8'}));
const head=api('git/ref/heads/main').object.sha;
let out={mode:'production',project:'fanscope',sha:head,artifact:'pages-production',pr:''};
if(process.env.GITHUB_EVENT_NAME==='workflow_dispatch'){
 if(process.env.GITHUB_REF!=='refs/heads/main')throw Error('Rollback only on main');
}else{
 const r=e.workflow_run;
 if(r.event==='pull_request'){
  const prs=api(`actions/runs/${r.id}`).pull_requests;
  if(prs.length!==1)throw Error('Exactly one associated PR required');
  const pr=api(`pulls/${prs[0].number}`);
  // The API lists at most 3000 files; anything larger counts as a site change.
  let files=[];
  for(let page=1;;page++){
   const batch=api(`pulls/${pr.number}/files?per_page=100&page=${page}`);
   files.push(...batch.flatMap(f=>[f.filename,f.previous_filename].filter(Boolean)));
   if(batch.length<100)break;
   if(page===30){files=null;break}
  }
  out=sourceForRun(r,head,pr,files);
 }else out=sourceForRun(r,head);
}
fs.appendFileSync(process.env.GITHUB_OUTPUT,Object.entries(out).map(([k,v])=>`${k}=${v}\n`).join(''));
if(out.mode==='skip'&&process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`Pages: nothing to publish (${out.reason}). Expected skip, not a failure.\n`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main();
