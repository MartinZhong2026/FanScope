import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {syntheticCsv,priorityJournals} from '../../scripts/chinese-import-fixtures.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const parent=path.join(root,'work/chinese-authorized-import');fs.mkdirSync(parent,{recursive:true});
const folder=fs.mkdtempSync(path.join(parent,'test-'));
Object.assign(process.env,{DATABASE_PATH:path.join(folder,'test.sqlite'),NODE_ENV:'test',CHINESE_AUTH_IMPORT_ENABLED:'true',CHINESE_IMPORT_SYNTHETIC:'true',SCAN_ON_START:'false',ADMIN_KEY:'synthetic-local-test-key-32-chars',DEEPSEEK_API_KEY:'',RESEND_API_KEY:''});
const {db}=await import('../src/db.mjs');
const m=await import('../src/chinese-authorized-import.mjs');
const {parseImportCsv,mapImportCsv}=await import('../src/chinese-import-files.mjs');
const documentHash=crypto.createHash('sha256').update('合成测试许可文档；不授予真实数据权限').digest('hex');
const registration={issuer:'合成测试出具方',licensee:'合成测试组',documentRef:'synthetic-license.txt',documentHash,grantExcerpt:'仅用于合成测试数据本机保存展示；非真实期刊授权。',expiresOn:'2099-12-31',journalIds:priorityJournals.map(x=>x.id)};
const review={reviewer:'合成测试审核人',notes:'已核对合成文档；只测试状态机，不构成真实授权。',documentHash,localStorage:true,localDisplay:true,action:'approve_local'};
let grant;
const upload={operator:'合成测试上传人',permissionRef:'合成文件生成程序；测试用途'};
const stage=(count,prefix,licenseId=grant.id,extra={})=>m.stageImportFile({filename:prefix+'.csv',content:syntheticCsv(count,{prefix,...extra}),licenseId,synthetic:true,upload});
const approve=id=>m.reviewImportRows(id,{reviewer:'合成记录审核人',notes:'核对合成文件行号和保留域名；非真实论文。',action:'approve',allReady:true});
after(()=>{db.close();fs.rmSync(folder,{recursive:true,force:true});});

test('CSV parser retains exact evidence lines, escaped quotes and rejects ambiguous mappings / unsupported formats',()=>{
 const p=parseImportCsv('\uFEFFtitle,authors\r\n"合成测试\n第二行","甲""乙"\r\n第三条,丙\r\n');
 assert.equal(p.rows[0].line,2);assert.equal(p.rows[1].line,4);assert.equal(p.rows[0].values[1],'甲"乙');
 assert.throws(()=>parseImportCsv('a,a\n1,2'),/重复/);assert.throws(()=>parseImportCsv('a\n"open'),/未闭合/);
 assert.throws(()=>parseImportCsv('a\n"x"tail'),/多余字符/);
 assert.throws(()=>parseImportCsv('a\n\uFFFD'),/UTF-8/);
 assert.throws(()=>mapImportCsv(p,{}),/必需映射/);
 assert.throws(()=>m.inspectImportFile({filename:'provider.ris',content:'TY  - JOUR'}),/仅支持/);
});
test('a pending license and file upload cannot publish; license review needs documentary fields, not a checkbox',()=>{
 assert.throws(()=>m.registerImportLicense({authorized:true}),/出具方/);
 grant=m.registerImportLicense(registration);
 const b=stage(100,'pending');assert.equal(b.counts.ready,100);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM articles').get().n,0);
 assert.throws(()=>approve(b.id),/未审查/);
 assert.throws(()=>m.reviewImportLicense(grant.id,{...review,notes:''}),/说明/);
 assert.throws(()=>m.reviewImportLicense(grant.id,{...review,documentHash:'a'.repeat(64)}),/哈希/);
 grant=m.reviewImportLicense(grant.id,review);assert.equal(grant.payload.redistributionAllowed,false);
 assert.equal(m.stageImportFile({filename:'pending.csv',content:syntheticCsv(100,{prefix:'pending'}),licenseId:grant.id,synthetic:true,upload}).id,b.id);
});
test('100 and 1000 synthetic records remain staged until reviewed, import in chunks, survive process restart and deduplicate with audit receipts',()=>{
 for(const count of [100,1000]){
  const prefix='scale-'+count,b=stage(count,prefix);assert.equal(b.counts.ready,count);
  const before=db.prepare('SELECT COUNT(*) n FROM articles').get().n;
  m.stepImportBatch(b.id);assert.equal(db.prepare('SELECT COUNT(*) n FROM articles').get().n,before);
  approve(b.id);let result=m.stepImportBatch(b.id,{limit:37});assert.equal(result.processed,37);
  const program=`const m=await import('./api/src/chinese-authorized-import.mjs');console.log(JSON.stringify(m.importBatch(${JSON.stringify(b.id)},{limit:0})));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',program],{cwd:root,env:process.env,encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).processed,37);
  while(result.remaining)result=m.stepImportBatch(b.id);
  assert.equal(result.counts.imported,count);assert.equal(m.stepImportBatch(b.id).processed,count);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM articles WHERE demo=0').get().n,0);
  const receipt=m.importAudit(b.id).items.filter(x=>x.event==='engine_imported');assert.equal(receipt.length,count);
  assert.ok(receipt.every(x=>x.details.provenance.file_sha256===b.fileHash&&x.details.provenance.record_evidence));
  // A separate authorized delivery of the same file must preserve its own audit.
  const secondLicense=m.reviewImportLicense(m.registerImportLicense(registration).id,review);
  const second=stage(count,prefix,secondLicense.id);approve(second.id);let replay=m.stepImportBatch(second.id);while(replay.remaining)replay=m.stepImportBatch(second.id);
  assert.equal(replay.counts.duplicate,count);assert.equal(replay.counts.imported||0,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM articles').get().n,before+count);
  assert.equal(m.importAudit(second.id).items.filter(x=>x.event==='engine_duplicate').length,count);
 }
});
test('invalid dates, identity, missing authors and record evidence are reported by row and cannot be approved',()=>{
 const bad=syntheticCsv(8,{prefix:'invalid',invalid:true}).replace('社会学研究','错误刊名').replace('合成作者甲; 合成作者乙','').replace('合成文件记录编号3，不构成真实论文证据','');
 const b=m.stageImportFile({filename:'invalid.csv',content:bad,licenseId:grant.id,synthetic:true,upload});
 assert.ok(b.counts.invalid>=3);assert.ok(b.rows.find(r=>r.number===1).errors.length>=2);
 approve(b.id);assert.equal(m.importBatch(b.id).counts.invalid,b.counts.invalid);
 const other=m.registerImportLicense({...registration,journalIds:[priorityJournals[0].id]});
 assert.equal(stage(4,'scope',other.id).counts.invalid,3);
 assert.throws(()=>m.stageImportFile({filename:'x.csv',content:syntheticCsv(1),licenseId:grant.id,synthetic:false,upload}),/模式/);
});
test('engine conflict is quarantined; a receipt failure rolls back paper and row together; revoked license blocks remaining work',()=>{
 const b=stage(3,'atomic');approve(b.id);
 db.exec("CREATE TRIGGER synthetic_receipt_failure BEFORE UPDATE OF status ON cn_import_rows WHEN NEW.status='imported' BEGIN SELECT RAISE(ABORT,'receipt failed'); END");
 const before=db.prepare('SELECT COUNT(*) n FROM articles').get().n;
 assert.throws(()=>m.stepImportBatch(b.id),/receipt failed/);assert.equal(db.prepare('SELECT COUNT(*) n FROM articles').get().n,before);assert.equal(m.importBatch(b.id).counts.approved,3);
 db.exec('DROP TRIGGER synthetic_receipt_failure');m.stepImportBatch(b.id,{limit:1});
 m.reviewImportLicense(grant.id,{...review,action:'revoke'});assert.throws(()=>m.stepImportBatch(b.id),/撤销/);
 assert.equal(m.importBatch(b.id).counts.approved,2);grant=m.reviewImportLicense(grant.id,review);
 m.stepImportBatch(b.id);
 const collision=m.stageImportFile({filename:'collision.csv',content:syntheticCsv(1,{prefix:'atomic'}).replace('合成测试 atomic 第1条，非真实论文','合成测试 完全不同题名'),licenseId:grant.id,synthetic:true,upload});approve(collision.id);
 const result=m.stepImportBatch(collision.id);assert.equal(result.counts.engine_review,1);assert.match(result.rows[0].errors.join(),/冲突/);
});
test('API requires admin and blocks old direct imports; preview and errors are paginated',async()=>{
 const {makeServer}=await import('../src/server.mjs');const server=makeServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
 const base='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(base+'/api/admin/chinese-imports')).status,401);
 for(const route of ['/api/admin/import','/api/admin/chinese-import'])assert.equal((await fetch(base+route,{method:'POST',headers:{'X-Admin-Key':process.env.ADMIN_KEY},body:'{}'})).status,409);
 const headers={'X-Admin-Key':process.env.ADMIN_KEY};const list=await (await fetch(base+'/api/admin/chinese-imports',{headers})).json();
 const big=list.batches.find(x=>x.total===1000),page=await (await fetch(base+'/api/admin/chinese-imports/batches/'+big.id+'?offset=100&limit=100',{headers})).json();assert.equal(page.rows.length,100);assert.equal(page.rows[0].number,101);
 const b=stage(101,'http');
 const response=await fetch(base+'/api/admin/chinese-imports/batches/'+b.id+'/review',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({reviewer:'HTTP合成审核',notes:'合成证据核查',action:'approve',allReady:true})});assert.equal(response.status,200);
 assert.equal((await (await fetch(base+'/api/admin/chinese-imports/batches/'+b.id+'/step',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"limit":100}'})).json()).processed,100);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('production and disabled runtime cannot use authorized import',()=>{
 process.env.CHINESE_AUTH_IMPORT_ENABLED='false';assert.throws(()=>m.importCatalog(),/隔离数据库/);process.env.CHINESE_AUTH_IMPORT_ENABLED='true';
 process.env.NODE_ENV='production';assert.throws(()=>m.importCatalog(),/隔离数据库/);process.env.NODE_ENV='test';
});
