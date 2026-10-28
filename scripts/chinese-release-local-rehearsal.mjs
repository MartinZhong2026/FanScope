// Purely local recovery/migration rehearsal. Does not accept a production path.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(fs.existsSync(path.join(root,'api/.env')))throw Error('Refusing environment-owned credentials');
const parent=path.join(root,'work/release-readiness');fs.mkdirSync(parent,{recursive:true});const dir=fs.mkdtempSync(path.join(parent,'restore-'));
const source=path.join(dir,'synthetic-original.sqlite'),backup=path.join(dir,'consistent-backup.sqlite'),restored=path.join(dir,'restored.sqlite');
const envFor=file=>({...process.env,DATABASE_PATH:file,SCAN_ON_START:'false',DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:'',OPENALEX_ENABLED:'false',NODE_ENV:'test'});
function run(code,file){return execFileSync(process.execPath,['--experimental-sqlite','--input-type=module','-e',"globalThis.fetch=async()=>{throw Error('No outbound in release rehearsal')};"+code],{cwd:root,env:envFor(file),encoding:'utf8'});}
const boot=file=>run("await import('./api/src/server.mjs');",file);
boot(source);
let db=new DatabaseSync(source);db.exec('BEGIN');
const insert=db.prepare('INSERT INTO articles(id,journal_id,market,title,doi,url,authors,abstract,publication_date,discovered_at,source,analysis_status,analysis_json,ai_summary,topics) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
for(let i=0;i<11000;i++)insert.run('synthetic-release-'+i,'jmir','international','合成测试 English retention '+i,'10.9999/release-fixture-'+i,'https://release-fixture.invalid/'+i,'Synthetic author','Synthetic abstract retained for recovery testing only.','2025-06-01','2026-01-01','crossref',i<375?'analyzed':'pending',i<375?JSON.stringify({fixture:true,summary:'Original synthetic AI '+i}):null,i<375?'Synthetic summary '+i:'','[]');
db.prepare("INSERT INTO analysis_batches(id,created_at,status,filter_json,total) VALUES('release-history','2026-01-01','paused','{}',1)").run();
db.prepare("INSERT INTO analysis_batch_items(batch_id,article_id,status,updated_at) VALUES('release-history','synthetic-release-400','queued','2026-01-01')").run();
db.exec('COMMIT');
const digest=database=>crypto.createHash('sha256').update(JSON.stringify(database.prepare('SELECT id,journal_id,market,title,doi,url,authors,abstract,publication_date,discovered_at,analysis_status,analysis_json,ai_summary FROM articles ORDER BY id').all())).digest('hex');
const tasks=database=>JSON.stringify([database.prepare('SELECT * FROM analysis_batches ORDER BY id').all(),database.prepare('SELECT * FROM analysis_batch_items ORDER BY article_id').all()]);
const before={records:11000,analyzed:375,protectedDigest:digest(db),taskDigest:crypto.createHash('sha256').update(tasks(db)).digest('hex')};db.close();
execFileSync(process.execPath,['--experimental-sqlite','api/src/backup.mjs',source,backup],{cwd:root,encoding:'utf8'});fs.copyFileSync(backup,restored);
boot(restored);boot(restored);db=new DatabaseSync(restored);
const after={records:db.prepare('SELECT COUNT(*) n FROM articles').get().n,analyzed:db.prepare("SELECT COUNT(*) n FROM articles WHERE analysis_status='analyzed' AND analysis_json IS NOT NULL").get().n,protectedDigest:digest(db),taskDigest:crypto.createHash('sha256').update(tasks(db)).digest('hex')};
if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Protected data/task drift');
const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check,foreignKeys=db.prepare('PRAGMA foreign_key_check').all().length;db.close();if(integrity!=='ok'||foreignKeys)throw Error('Restore integrity failure');
// Reuse the existing real corpus only in a separate local test copy. No public-use permission is inferred.
const corpus=path.join(root,'work/chinese-bulk/fanscope-chinese.sqlite'),copy=path.join(dir,'chinese-replay.sqlite');db=new DatabaseSync(corpus,{readOnly:true});db.prepare('VACUUM INTO ?').run(copy);db.close();
const code=`import fs from 'node:fs';const {db}=await import('./api/src/db.mjs');const {importChinese}=await import('./api/src/chinese-ingestion.mjs');const rows=JSON.parse(fs.readFileSync('work/chinese-bulk/final/records.json','utf8'));const rounds=[];for(let round=0;round<2;round++){let added=0,duplicates=0,rejected=0,updated=0;for(const row of rows){const evidence=JSON.parse(row.source_evidence_json||'{}');const r=importChinese({journalId:row.journal_id,items:[{...row,source_evidence:evidence}],authorized:true,evidenceUrl:evidence.authorization||'https://local-rehearsal.invalid/metadata-only'});added+=r.added;duplicates+=r.duplicates;updated+=r.updated;rejected+=r.rejected.length+r.review.length;}rounds.push({added,duplicates,updated,rejected});}console.log(JSON.stringify({rounds,records:db.prepare('SELECT COUNT(*) n FROM articles WHERE demo=0').get().n}));db.close();`;
const replay=JSON.parse(run(code,copy));if(replay.records!==349||replay.rounds.some(r=>r.added||r.duplicates!==349||r.rejected))throw Error('Chinese replay failed');
const report={localOnly:true,syntheticEnglishFixture:true,productionBackupTested:false,before,after,migrations:2,integrity,foreignKeyViolations:foreignKeys,chineseLocalReplay:replay,artifacts:path.relative(root,dir).replaceAll('\\','/')};
fs.writeFileSync(path.join(parent,'local-rehearsal.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
