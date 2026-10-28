import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
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
 if(r.path!=='.github/workflows/test.yml'||r.conclusion!=='success'||r.repository.full_name!==repo)throw Error('Untrusted source workflow');
 if(r.event==='push'){
  if(r.head_branch!=='main'||r.head_sha!==head)throw Error('Stale production run');
 }else if(r.event==='pull_request'){
  const prs=api(`actions/runs/${r.id}`).pull_requests;
  if(prs.length!==1)throw Error('Exactly one associated PR required');
  const pr=api(`pulls/${prs[0].number}`);
  if(pr.state!=='open'||pr.head.sha!==r.head_sha||pr.base.ref!=='main')throw Error('Stale/closed PR');
  out={mode:'preview',project:'fanscope-preview',sha:r.head_sha,artifact:'pages-preview',pr:String(pr.number)};
 }else throw Error('Unsupported source trigger');
}
fs.appendFileSync(process.env.GITHUB_OUTPUT,Object.entries(out).map(([k,v])=>`${k}=${v}\n`).join(''));
