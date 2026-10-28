import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertSingleChannel,smoke,validateArtifact} from '../../scripts/cicd/pages.mjs';
import {gallery} from '../../scripts/cicd/preview-gallery.mjs';

test('Pages refuses ambiguous or enabled Git integration',()=>{
 assertSingleChannel({production_branch:'main'});
 assertSingleChannel({production_branch:'main',source:{config:{production_deployments_enabled:false,preview_deployment_setting:'none'}}});
 for(const config of [{},{production_deployments_enabled:true,preview_deployment_setting:'none'},{production_deployments_enabled:false,preview_deployment_setting:'all'}]){
  assert.throws(()=>assertSingleChannel({production_branch:'main',source:{config}}));
 }
 assert.throws(()=>assertSingleChannel({production_branch:'master'}));
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
