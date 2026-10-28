// Local build only. No Wrangler, cloud credentials, network or database access.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {verifyPagesRelease} from './verify-pages-release.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=path.join(root,'web');
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const sourceTreeDirty=!!execFileSync('git',['status','--porcelain','--','api','web','scripts','deploy'],{cwd:root,encoding:'utf8'}).trim();
if(sourceTreeDirty&&!process.argv.includes('--allow-dirty'))throw Error('提交并审核发布源码后再构建；本地测试可显式使用--allow-dirty，不能发布测试产物');
const folder=path.join(root,'work/release-readiness/pages-'+revision.slice(0,7)+'-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const excluded=[];
function copy(dir,relative=''){
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const rel=path.posix.join(relative,entry.name),from=path.join(dir,entry.name),to=path.join(folder,rel);
  if(rel==='import-templates'||/^chinese-import\./.test(rel)){excluded.push(rel);continue;}
  if(entry.isSymbolicLink())throw Error('Symlinks are not release assets: '+rel);
  if(entry.isDirectory()){fs.mkdirSync(to,{recursive:true});copy(from,rel);continue;}
  if(!/\.(?:html|js|mjs|css|svg|png|woff2)$/.test(rel)&&!['_headers','_redirects'].includes(rel)&&!/vendor\/.*LICENSE.*\.txt$/.test(rel))throw Error('Unexpected release file: '+rel);
  fs.copyFileSync(from,to);
 }
}
copy(source);
const appFile=path.join(folder,'app.js');let app=fs.readFileSync(appFile,'utf8');
if(!app.includes('function chinesePanel(edit=false){'))throw Error('Source layout changed; review read-only release transform');
app=app.replace('function chinesePanel(edit=false){','function chinesePanel(edit=false){edit=false;');
let links=0;app=app.replace(/<a\b[^>]*href="chinese-import\.html"[^>]*>[^<]*<\/a>/g,()=>{links++;return '<span>授权导入工作台仅限本机运行</span>';});
if(links!==2)throw Error('Unexpected import entry count; review transform');
fs.writeFileSync(appFile,app);
if(!fs.existsSync(path.join(folder,'404.html')))fs.writeFileSync(path.join(folder,'404.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>页面不存在</title><p>页面不存在。<a href="/">返回 FanScope</a></p></html>');
const assets=fs.readdirSync(folder,{recursive:true}).filter(f=>fs.statSync(path.join(folder,f)).isFile()).map(file=>({file:file.replaceAll('\\','/'),sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(folder,file))).digest('hex')}));
const verification=verifyPagesRelease(folder);
const manifest={sourceCommit:revision,sourceTreeDirty,createdAt:new Date().toISOString(),folder:path.relative(root,folder).replaceAll('\\','/'),productionApi:'https://fanscope-api.adapttochina.com',localWorkbenchExcluded:excluded,readOnlyChineseControls:true,sensitiveScanPassed:verification.passed,assets};
fs.writeFileSync(path.join(root,'work/release-readiness/pages-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({folder,assets:assets.length,excluded,sourceCommit:revision,uploaded:false}));
