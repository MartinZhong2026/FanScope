// Manual, local-only staging around the existing Chinese ingestion engine.
// Permission evidence is recorded for human review; no click proves redistribution rights.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {db,now} from './db.mjs';
import {config} from './config.mjs';
import {publicationToday} from './publication-policy.mjs';
import {validIssn,canonicalDoi,canonicalJournalTitle} from './sources.mjs';
import {importChinese,validateChineseItem,chineseIdentity} from './chinese-ingestion.mjs';
import {parseImportCsv,mapImportCsv,suggestImportMapping,importFields,requiredImportFields} from './chinese-import-files.mjs';
const fail=(s,status=400)=>Object.assign(Error(s),{status});
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const decode=s=>JSON.parse(s);
const text=(value,label,max=2000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw fail(label+'缺失或过长');return value.trim();};
let initialized=false;
export function importGate(){
 const root=path.resolve(config.root,'../work/chinese-authorized-import');
 const relative=path.relative(root,path.resolve(config.dbPath));
 if(process.env.CHINESE_AUTH_IMPORT_ENABLED!=='true'||process.env.NODE_ENV==='production'||relative.startsWith('..')||path.isAbsolute(relative)||!relative||!config.dbPath.endsWith('.sqlite'))throw fail('授权导入仅允许专用本地隔离数据库，请使用本地导入启动命令',403);
 if(!initialized){db.exec(`
 CREATE TABLE IF NOT EXISTS cn_import_licenses(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,review_json TEXT,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS cn_import_batches(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL UNIQUE,filename TEXT NOT NULL,file_hash TEXT NOT NULL,content TEXT NOT NULL,mapping_json TEXT NOT NULL,upload_json TEXT NOT NULL,license_id TEXT NOT NULL,synthetic INTEGER NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(license_id) REFERENCES cn_import_licenses(id));
 CREATE TABLE IF NOT EXISTS cn_import_rows(batch_id TEXT NOT NULL,number INTEGER NOT NULL,line INTEGER NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,errors TEXT NOT NULL,warnings TEXT NOT NULL,review_json TEXT,result_json TEXT,PRIMARY KEY(batch_id,number),FOREIGN KEY(batch_id) REFERENCES cn_import_batches(id));
 CREATE INDEX IF NOT EXISTS idx_cn_import_row_status ON cn_import_rows(batch_id,status,number);
 CREATE TABLE IF NOT EXISTS cn_import_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,batch_id TEXT,license_id TEXT,number INTEGER,event TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
 `);
 // Reuse the researched inventory for missing identifiers in this isolated DB.
 // Never overwrite a non-empty operator identifier or enable an automatic source.
 const targets=JSON.parse(fs.readFileSync(path.join(config.root,'config/chinese-journal-inventory.json'),'utf8')).filter(j=>j.priority);
 for(const j of targets)db.prepare("UPDATE journals SET issn=? WHERE id=? AND title=? AND market='chinese' AND (issn='' OR issn IS NULL)").run(j.issn,j.id,j.title);
 initialized=true;}
}
const event=(batch,license,number,type,details)=>db.prepare('INSERT INTO cn_import_audit(batch_id,license_id,number,event,details,created_at) VALUES(?,?,?,?,?,?)').run(batch,license,number,type,JSON.stringify(details),now());
const getLicense=id=>{const row=db.prepare('SELECT * FROM cn_import_licenses WHERE id=?').get(String(id||''));if(!row)throw fail('许可登记不存在');return {...row,payload:decode(row.payload),review:row.review_json?decode(row.review_json):null};};
const getBatch=id=>{const row=db.prepare('SELECT * FROM cn_import_batches WHERE id=?').get(String(id||''));if(!row)throw fail('暂存批次不存在');return row;};
export function importCatalog(){importGate();return {fields:Object.keys(importFields),required:requiredImportFields,formats:['csv'],maxRows:5000,maxFileBytes:8*1024*1024,syntheticMode:process.env.CHINESE_IMPORT_SYNTHETIC==='true',journals:db.prepare("SELECT id,title,issn FROM journals WHERE market='chinese' ORDER BY title").all()};}
export function registerImportLicense(input={}){
 importGate();
 const payload={issuer:text(input.issuer,'许可出具方'),licensee:text(input.licensee,'被许可方'),documentRef:text(input.documentRef,'许可文档位置'),documentHash:text(input.documentHash,'许可文档SHA-256',64).toLowerCase(),grantExcerpt:text(input.grantExcerpt,'支持本地导入与展示的条款摘录',6000),expiresOn:String(input.expiresOn||''),abstracts:input.abstracts===true,synthetic:process.env.CHINESE_IMPORT_SYNTHETIC==='true',redistributionAllowed:false};
 if(!/^[a-f0-9]{64}$/.test(payload.documentHash))throw fail('许可文档SHA-256必须为64位十六进制');
 if(!Array.isArray(input.journalIds)||!input.journalIds.length||input.journalIds.length>30)throw fail('请选择许可明确包含的期刊');
 payload.journalIds=[...new Set(input.journalIds)];
 for(const id of payload.journalIds)if(!db.prepare("SELECT 1 FROM journals WHERE id=? AND market='chinese'").get(id))throw fail('许可包含未知中文期刊');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(payload.expiresOn)||Number.isNaN(Date.parse(payload.expiresOn))||new Date(payload.expiresOn+'T00:00:00Z').toISOString().slice(0,10)!==payload.expiresOn)throw fail('请明确填写许可截止日期');
 const id=crypto.randomUUID();
 db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO cn_import_licenses VALUES(?,?,?,?,?)').run(id,JSON.stringify(payload),'pending',null,now());event(null,id,null,'license_registered',{scope:'local_metadata_only',synthetic:payload.synthetic});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 return getLicense(id);
}
export function reviewImportLicense(id,input={}){
 importGate();const license=getLicense(id),reviewer=text(input.reviewer,'许可审查人',200),notes=text(input.notes,'核验经过与条款适用说明',6000);
 if(!['approve_local','revoke'].includes(input.action))throw fail('许可操作无效');
 if(input.action==='approve_local'&&(input.documentHash!==license.payload.documentHash||input.localStorage!==true||input.localDisplay!==true))throw fail('需核对文档哈希及本地保存、展示范围；不授予再分发权');
 const review={reviewer,notes,at:now(),localStorage:input.action==='approve_local',localDisplay:input.action==='approve_local',redistributionAllowed:false};
 db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE cn_import_licenses SET status=?,review_json=? WHERE id=?').run(input.action==='approve_local'?'reviewed_local_only':'revoked',JSON.stringify(review),id);event(null,id,null,'license_'+input.action,review);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 return getLicense(id);
}
function checkedLicense(batch){
 const license=getLicense(batch.license_id);
 if(license.status!=='reviewed_local_only'||license.payload.expiresOn<publicationToday())throw fail('来源许可未审查、已撤销或过期，不能审核入库',409);
 if(!!batch.synthetic!==license.payload.synthetic)throw fail('合成测试许可不能用于真实数据');
 return license;
}
export function inspectImportFile(input={}){
 importGate();if(input.format&&input.format!=='csv'||!/\.csv$/i.test(String(input.filename||'')))throw fail('MVP仅支持UTF-8 CSV；RIS/XML请先按映射说明转换并核对');
 if(typeof input.content!=='string')throw fail('请提供UTF-8 CSV文本');
 const parsed=parseImportCsv(input.content);return {headers:parsed.headers,total:parsed.rows.length,mapping:suggestImportMapping(parsed.headers),sample:parsed.rows.slice(0,5)};
}
export function stageImportFile(input={}){
 importGate();const inspected=inspectImportFile(input),parsed=parseImportCsv(input.content),mapped=mapImportCsv(parsed,input.mapping);
 const license=getLicense(input.licenseId),synthetic=process.env.CHINESE_IMPORT_SYNTHETIC==='true';
 if(input.synthetic!==synthetic||license.payload.synthetic!==synthetic)throw fail('文件必须与当前真实/合成工作区模式一致');
 const upload={operator:text(input.upload?.operator,'上传人',200),permissionRef:text(input.upload?.permissionRef,'上传文件权限依据',2000),at:now()};
 const filename=text(input.filename,'文件名',240),fileHash=hash(input.content);
 const fingerprint=hash(JSON.stringify([fileHash,Object.entries(mapped.mapping).sort(),license.id,synthetic,upload.operator,upload.permissionRef]));
 const previous=db.prepare('SELECT id FROM cn_import_batches WHERE fingerprint=?').get(fingerprint);if(previous)return {...importBatch(previous.id),reused:true};
 const id=crypto.randomUUID();
 db.exec('BEGIN IMMEDIATE');try{
 db.prepare('INSERT INTO cn_import_batches VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,fingerprint,filename,fileHash,input.content,JSON.stringify(mapped.mapping),JSON.stringify(upload),license.id,synthetic?1:0,now());
 for(const row of mapped.rows){
  const a=row.record,errors=[],warnings=[];
  if(row.columns!==inspected.headers.length)errors.push('列数与表头不一致');
  const matches=db.prepare("SELECT * FROM journals WHERE market='chinese' AND issn=?").all(a.issn).filter(j=>canonicalJournalTitle(j.title)===canonicalJournalTitle(a.journal_title));
  const j=matches.length===1?matches[0]:null;
  if(!validIssn(a.issn)||!j||a.journal_id&&a.journal_id!==j.id)errors.push('期刊名称、ISSN或期刊ID不匹配；不做模糊归属');
  if(j&&!license.payload.journalIds.includes(j.id))errors.push('来源许可未包含该期刊');
  if(!a.authors)errors.push('作者缺失，须回到授权来源补核');
  if(!a.record_evidence)errors.push('论文记录证据位置缺失');
  if(a.title.length>1000||a.authors.length>3000||a.record_evidence.length>3000||a.abstract.length>12000)errors.push('字段过长，请核查映射');
  if(a.abstract&&!license.payload.abstracts)errors.push('许可未明确包含摘要，请移除摘要列或补充许可');
  for(const field of ['published_online_date','published_print_date'])if(a[field]){
   const value=a[field],padded=value.length===4?value+'-01-01':value.length===7?value+'-01':value;
   if(!/^\d{4}(?:-(?:0[1-9]|1[0-2]))?(?:-\d{2})?$/.test(value)||Number.isNaN(Date.parse(padded))||new Date(padded+'T00:00:00Z').toISOString().slice(0,10)!==padded||value>publicationToday().slice(0,value.length))errors.push(field+'日期不合法或晚于今日');
  }
  if(a.source_updated_at&&(Number.isNaN(Date.parse(a.source_updated_at))||!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(a.source_updated_at)))errors.push('来源更新时间必须为ISO日期或时间');
  const partial=a.publication_date.length<10;
  const record={...a,journal_id:j?.id||'',market:'chinese',doi:canonicalDoi(a.doi),publication_date:partial?'':a.publication_date,publication_date_partial:partial?a.publication_date:'',date_precision:a.publication_date.length===10?'day':a.publication_date.length===7?'month':'year',issns:[a.issn],source:'authorized_file',source_verification_status:'human_reviewed',publisher_landing_url:a.url,link_provenance:'authorized_file_record'};
  if(j){const reason=validateChineseItem(j,record);if(reason)errors.push(reason);}
  if(!a.doi)warnings.push('DOI缺失：使用现有精确组合身份去重');
  if(partial)warnings.push('发表日期精度为'+record.date_precision+'，不会编造具体日期');
  let reserved=false;try{reserved=new URL(a.url).hostname.endsWith('.invalid');}catch{}
  if(synthetic&&(!reserved||!a.title.includes('合成测试'))||!synthetic&&(reserved||a.title.includes('合成测试')))errors.push('合成测试标记/保留域名与工作区模式不一致');
  db.prepare('INSERT INTO cn_import_rows(batch_id,number,line,payload,status,errors,warnings) VALUES(?,?,?,?,?,?,?)').run(id,row.number,row.line,JSON.stringify(record),errors.length?'invalid':'ready',JSON.stringify(errors),JSON.stringify(warnings));
 }
 event(id,license.id,null,'file_staged',{fileHash,total:mapped.rows.length,upload,mapping:mapped.mapping,synthetic});db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return importBatch(id);
}
export function listImports(){importGate();return {batches:db.prepare('SELECT id FROM cn_import_batches ORDER BY created_at DESC LIMIT 100').all().map(x=>importBatch(x.id,{limit:0})),licenses:db.prepare('SELECT id FROM cn_import_licenses ORDER BY created_at DESC').all().map(x=>getLicense(x.id))};}
export function importBatch(id,{offset=0,limit=100,errorsOnly=false}={}){
 importGate();const batch=getBatch(id),counts=Object.fromEntries(db.prepare('SELECT status,COUNT(*) n FROM cn_import_rows WHERE batch_id=? GROUP BY status').all(id).map(x=>[x.status,x.n]));
 const safeLimit=Math.max(0,Math.min(100,Number(limit)||0)),safeOffset=Math.max(0,Math.trunc(Number(offset)||0));
 const rows=db.prepare(`SELECT * FROM cn_import_rows WHERE batch_id=? ${errorsOnly?"AND status IN ('invalid','engine_review','rejected')":''} ORDER BY number LIMIT ? OFFSET ?`).all(id,safeLimit,safeOffset).map(row=>({...row,record:decode(row.payload),errors:decode(row.errors),warnings:decode(row.warnings),review:row.review_json?decode(row.review_json):null,result:row.result_json?decode(row.result_json):null,payload:undefined}));
 const total=Object.values(counts).reduce((a,b)=>a+b,0),processed=(counts.imported||0)+(counts.duplicate||0)+(counts.engine_review||0);
 return {id,filename:batch.filename,fileHash:batch.file_hash,licenseId:batch.license_id,licenseStatus:getLicense(batch.license_id).status,synthetic:!!batch.synthetic,createdAt:batch.created_at,mapping:decode(batch.mapping_json),upload:decode(batch.upload_json),counts,total,processed,remaining:counts.approved||0,status:counts.approved?'approved':counts.ready?'awaiting_review':processed?'settled':'needs_correction',rows};
}
export function reviewImportRows(id,input={}){
 importGate();const batch=getBatch(id);checkedLicense(batch);
 const review={reviewer:text(input.reviewer,'记录审核人',200),notes:text(input.notes,'原始论文证据核查说明',6000),at:now()};
 if(!['approve','reject'].includes(input.action))throw fail('记录审核操作无效');
 if(input.allReady!==true&&(!Array.isArray(input.numbers)||!input.numbers.length||input.numbers.length>5000||input.numbers.some(n=>!Number.isInteger(n)||n<1)))throw fail('请选择需要审核的暂存行');
 const rows=db.prepare("SELECT number FROM cn_import_rows WHERE batch_id=? AND status='ready'").all(id).filter(r=>input.allReady===true||input.numbers.includes(r.number));
 db.exec('BEGIN IMMEDIATE');try{for(const row of rows){db.prepare('UPDATE cn_import_rows SET status=?,review_json=? WHERE batch_id=? AND number=?').run(input.action==='approve'?'approved':'rejected',JSON.stringify(review),id,row.number);event(id,batch.license_id,row.number,'record_'+input.action,review);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 return importBatch(id);
}
export function stepImportBatch(id,{limit=100}={}){
 importGate();const batch=getBatch(id),license=checkedLicense(batch);
 if(!Number.isInteger(limit)||limit<1||limit>100)throw fail('每批处理1至100条');
 if(batch.synthetic&&db.prepare('SELECT COUNT(*) n FROM articles WHERE demo=0').get().n)throw fail('合成验收库包含非合成论文，拒绝混入',409);
 const rows=db.prepare("SELECT * FROM cn_import_rows WHERE batch_id=? AND status='approved' ORDER BY number LIMIT ?").all(id,limit);
 for(const staged of rows){
  const record=decode(staged.payload),review=decode(staged.review_json);
  const a={...record,source_evidence:{file_sha256:batch.file_hash,filename:batch.filename,csv_row:staged.number,physical_line:staged.line,record_evidence:record.record_evidence,upload:decode(batch.upload_json),license_id:license.id,license_document_ref:license.payload.documentRef,license_document_sha256:license.payload.documentHash,license_review:license.review,record_review:review,usage_scope:'local_metadata_only',redistribution_allowed:false,synthetic:!!batch.synthetic}};
  // The engine owns identity, conflict handling and final insertion. The callback
  // shares its transaction: a crash cannot commit a paper without its row receipt.
  importChinese({journalId:a.journal_id,items:[a],authorized:true,evidenceUrl:'https://fanscope.invalid/local-license/'+license.id,synthetic:!!batch.synthetic},result=>{
   const status=result.rejected.length||result.review.length?'engine_review':result.added?'imported':'duplicate';
   const article=db.prepare('SELECT id FROM articles WHERE journal_id=? AND (chinese_identity_key=? OR url=? OR (doi<>\'\' AND doi=?)) LIMIT 1').get(a.journal_id,chineseIdentity(a),a.url,a.doi);
   const receipt={...result,articleId:article?.id||null,at:now()};
   const errors=[...result.rejected,...result.review].map(x=>x.reason);
   db.prepare('UPDATE cn_import_rows SET status=?,result_json=?,errors=? WHERE batch_id=? AND number=?').run(status,JSON.stringify(receipt),JSON.stringify(errors),id,staged.number);
   event(id,license.id,staged.number,'engine_'+status,{...receipt,provenance:a.source_evidence});
  });
 }
 return importBatch(id);
}
export function importAudit(id){importGate();getBatch(id);return {items:db.prepare('SELECT * FROM cn_import_audit WHERE batch_id=? OR (batch_id IS NULL AND license_id=(SELECT license_id FROM cn_import_batches WHERE id=?)) ORDER BY id').all(id,id).map(row=>({...row,details:decode(row.details)}))};}
