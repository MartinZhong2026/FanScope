import test,{after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {chineseSourceStatus,chineseQualityPanel,chineseCollectionSummary} from '../../web/chinese-quality.mjs';
import {readChineseDiagnostics} from '../../web/chinese-diagnostics.mjs';
import {verifyPagesRelease} from '../../scripts/verify-pages-release.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-release-fix-'));
Object.assign(process.env,{DATABASE_PATH:path.join(dir,'test.sqlite'),SCAN_ON_START:'false',DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:'',ADMIN_KEY:'synthetic-release-blockers-admin-key'});
const {db}=await import('../src/db.mjs');const {makeServer}=await import('../src/server.mjs');const {insertArticle}=await import('../src/monitor.mjs');const {sourceSummary}=await import('../src/journal-onboarding.mjs');
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
const sample={id:'test',title:'测试刊物',market:'chinese',total:0,enabled:false,quality:{},windows:{},connection:null};

test('all-history Chinese totals and collected journals remain distinct from healthy automatic monitoring',()=>{
 const d={available:true,items:[{...sample,total:200},{...sample,id:'second',total:149},{...sample,id:'empty'}]};
 const journals=[{market:'chinese',status:'pending'},{market:'chinese',status:'healthy'},{market:'international',status:'healthy'}];
 const html=chineseCollectionSummary(d,journals);
 assert.match(html,/全部历史 349 篇/);assert.match(html,/已收录期刊 2 本/);assert.match(html,/有效自动监测期刊 1 本/);assert.match(html,/不受当前时间或其他筛选影响/);assert.match(html,/data-chinese-history/);
 assert.match(chineseCollectionSummary(d,[]),/有效自动监测期刊 0 本/);
 assert.match(chineseCollectionSummary(d,undefined),/有效自动监测期刊 暂不可用/);
 assert.match(chineseCollectionSummary({available:false},journals),/暂不可用/);assert.doesNotMatch(chineseCollectionSummary({available:false},journals),/0 篇/);
});

test('metadata presence, current automatic verification and monitoring are independent; no identity-specific assertions',()=>{
 const collected={...sample,total:7};assert.equal(chineseSourceStatus(collected).collected,true);assert.equal(chineseSourceStatus(collected).automaticVerified,false);
 const empty={...sample,connection:{verified:true,provider:'catalog',checkedAt:'2026-10-20'}};assert.equal(chineseSourceStatus(empty).metadata,'尚未收录元数据');assert.equal(chineseSourceStatus(empty).automaticVerified,true);
 const html=chineseQualityPanel({items:[collected,empty]});assert.match(html,/已收录元数据 1 本/);assert.match(html,/自动来源已核验 1 本/);assert.match(html,/累计 7 篇/);assert.doesNotMatch(html,/官网要求登录令牌|近三年公开接口未发现/);
 assert.equal(chineseSourceStatus({...empty,lastError:{at:'2026-10-21',error:'failure'}}).automaticVerified,false);
 assert.equal(chineseSourceStatus({...empty,lastError:{at:'2026-10-19',error:'old'}}).automaticVerified,true);
 assert.ok(!chineseQualityPanel({items:[{...collected,title:'<script>bad</script>',lastError:{error:'<img>'}}]}).includes('<script>'));
});
test('optional diagnostic capability rejects outages/malformed/mixed-market responses without inventing zero coverage',async()=>{
 for(const read of [async()=>{throw Error('HTTP 404')},async()=>{throw Error('network')},async()=>({items:[]}),async()=>({market:'chinese',window:{start:'a',end:'b'},items:[{...sample,market:'international'}]})]){
  const result=await readChineseDiagnostics(read);assert.deepEqual(result,{available:false});const html=chineseQualityPanel(result);assert.match(html,/诊断暂不可用/);assert.doesNotMatch(html,/累计 0 篇/);
 }
 const legacy={market:'chinese',window:{start:'2026-04-30',end:'2026-10-26'},items:[sample]};assert.equal((await readChineseDiagnostics(async()=>legacy)).available,true);
});
test('diagnostic API and source summary expose real DB counts even without cn-source; demo and foreign market rows are excluded',async()=>{
 insertArticle({id:'synthetic-cn-status',journal_id:'candidate-1',market:'chinese',title:'合成测试 status',url:'https://status.invalid/one',source:'manual'});
 insertArticle({id:'synthetic-demo-status',journal_id:'candidate-1',market:'chinese',title:'合成测试 demo',url:'https://status.invalid/two',source:'manual'},1);
 insertArticle({id:'synthetic-en-status',journal_id:'jmir',market:'international',title:'合成测试 English',url:'https://status.invalid/en',source:'manual'});
 db.prepare('INSERT INTO meta VALUES(?,?)').run('cn-source:candidate-6',JSON.stringify({verified:true,provider:'catalog',checkedAt:'2026-10-20'}));
 db.prepare("UPDATE journals SET source='rss',rss_url='https://rss.invalid/feed' WHERE id='soc-security-cn'").run();
 db.prepare('INSERT INTO journal_source_evidence(journal_id,source,identifier,checked_at,verified,evidence_json,error) VALUES(?,?,?,?,?,?,?)').run('soc-security-cn','rss','https://rss.invalid/feed','2026-10-20',1,'{}','');
 const source=sourceSummary();assert.equal(source.items.find(j=>j.id==='candidate-1').collection_status,'metadata_ready');assert.equal(source.items.find(j=>j.id==='candidate-6').collection_status,'source_verified');assert.equal(source.metadataCollected,1);
 const server=makeServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
  const base='http://127.0.0.1:'+server.address().port;
  const diag=await (await fetch(base+'/api/chinese-diagnostics')).json();assert.equal(diag.schemaVersion,1);assert.equal(diag.items.find(j=>j.id==='soc-security-cn').connection.provider,'rss');assert.equal(diag.items.find(j=>j.id==='soc-security-cn').total,0);assert.equal(diag.summary.records,1);assert.equal(diag.summary.journalsWithRecords,1);assert.equal((await readChineseDiagnostics(async()=>diag)).available,true);
  const stats=await (await fetch(base+'/api/stats?market=international&period=all')).json();assert.equal(stats.count,1);
 }finally{await new Promise(r=>server.close(r));}
});
test('production closes every Chinese management route before authentication, including forced local import flag and method override',async()=>{
 const prev=process.env.NODE_ENV;process.env.NODE_ENV='production';process.env.CHINESE_AUTH_IMPORT_ENABLED='true';const server=makeServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const base='http://127.0.0.1:'+server.address().port;const before=db.prepare('SELECT COUNT(*) n FROM articles').get().n;
 for(const route of ['chinese-imports/files','chinese-imports/catalog','chinese-imports/licenses','chinese-source','chinese-jobs','chinese-batches','import'])for(const method of ['GET','POST','PATCH','DELETE','OPTIONS']){
  const r=await fetch(base+'/api/admin/'+route,{method,headers:{'X-Admin-Key':process.env.ADMIN_KEY,'X-HTTP-Method-Override':'POST','Origin':'https://untrusted.invalid'},...(method==='GET'?{}:{body:'{}'})});assert.equal(r.status,404,method+' '+route);
 }assert.equal(db.prepare('SELECT COUNT(*) n FROM articles').get().n,before);
 }finally{process.env.NODE_ENV=prev||'';process.env.CHINESE_AUTH_IMPORT_ENABLED='false';await new Promise(r=>server.close(r));}
});
test('public artifact scanner rejects database, hidden env and literal keys and does not treat static code as permission',()=>{
 const folder=path.join(dir,'public');fs.mkdirSync(folder);for(const f of ['index.html','config.js','app.js','chinese-quality.mjs','chinese-diagnostics.mjs','404.html'])fs.writeFileSync(path.join(folder,f),f==='app.js'?'function chinesePanel(edit=false){edit=false;}':'safe');
 assert.equal(verifyPagesRelease(folder).passed,true);
 for(const [file,body] of [['leak.sqlite','data'],['.env','not-public'],['key.js','const exposed="'+'sk-'+'x'.repeat(30)+'"']]){fs.writeFileSync(path.join(folder,file),body);assert.throws(()=>verifyPagesRelease(folder));fs.unlinkSync(path.join(folder,file));}
});
test('HTTP-only production entry registers no background timers and preserves running historical task state',async()=>{
 db.prepare("INSERT INTO analysis_batches(id,created_at,status,filter_json,total) VALUES('blocker-history','2026-01-01','running','{}',1)").run();
 const guard=path.join(dir,'guard.mjs');fs.writeFileSync(guard,"globalThis.setInterval=()=>{throw Error('Unexpected background timer')};");
 const child=spawn(process.execPath,['--import',pathToFileURL(guard).href,'src/release-server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,NODE_ENV:'production',FANSCOPE_RELEASE_HTTP_ONLY:'true',PORT:'0',DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:''},stdio:['ignore','pipe','pipe']});
 let output='',error='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('entry timeout '+error)),10000);const poll=()=>{if(output.includes('\n')){clearTimeout(timer);resolve();}};child.stdout.on('data',poll);child.once('exit',code=>{clearTimeout(timer);reject(Error('entry exited '+code+' '+error));});});
  const info=JSON.parse(output.trim()),base='http://127.0.0.1:'+info.port;assert.equal(info.workers,false);
  assert.equal((await fetch(base+'/api/health')).status,200);
  assert.equal((await fetch(base+'/api/admin/analysis-batches',{method:'POST',body:'{}',headers:{'X-Admin-Key':process.env.ADMIN_KEY}})).status,503);
  assert.equal((await fetch(base+'/api/subscriptions/confirm?token=synthetic')).status,503);
  assert.equal((await fetch(base+'/api/admin/chinese-jobs',{method:'POST',body:'{}',headers:{'X-Admin-Key':process.env.ADMIN_KEY}})).status,404);
  assert.equal(db.prepare("SELECT status FROM analysis_batches WHERE id='blocker-history'").get().status,'running');
 }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}
});
