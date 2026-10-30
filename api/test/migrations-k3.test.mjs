// K3 acceptance: versioned additive migrations. Every database here is an
// isolated temp file built from the synthetic v1.2 schema fixture or a fresh
// bootstrap; no production data.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {execFileSync,spawn,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {DatabaseSync} from 'node:sqlite';
import {applyMigrations,planMigrations,lintMigration,loadMigrations,captureState,compareStates,verifyMigrationsAtStartup,LEDGER,LEGACY_BASELINE,POSITIONAL_INSERT_TABLES,checksum} from '../src/migrations.mjs';

const src=new URL('../src/',import.meta.url),cli=fileURLToPath(new URL('migrate-cli.mjs',src));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-k3-'));
test.after(()=>{try{fs.rmSync(root,{recursive:true,force:true,maxRetries:5})}catch{}});
let n=0;const tmp=name=>{const d=path.join(root,`${name}-${++n}`);fs.mkdirSync(d);return d};
const emptyDir=tmp('empty-migrations');
const env=(file,dir=emptyDir)=>({...process.env,DATABASE_PATH:file,FANSCOPE_MIGRATIONS_DIR:dir,NODE_ENV:'test',SCAN_ON_START:'false',DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:''});
// Same import the release controller rehearses: the whole server module graph.
const boot=(file,{dir,code=''}={})=>spawnSync(process.execPath,['--experimental-sqlite','--input-type=module','-e',
 `await import(${JSON.stringify(new URL('server.mjs',src).href)});const {db}=await import(${JSON.stringify(new URL('db.mjs',src).href)});${code};db.close();`],{env:env(file,dir),encoding:'utf8'});
const bootOk=(file,opts)=>{const r=boot(file,opts);assert.equal(r.status,0,r.stderr);return r};
const run=(args,file,dir)=>{const r=spawnSync(process.execPath,['--experimental-sqlite',cli,...args],{env:env(file,dir),encoding:'utf8'});return {code:r.status,json:JSON.parse(r.stdout||'null'),stderr:r.stderr}};

// Content+schema fingerprint of the whole file, same scope as the controller's
// sqlite_release.fingerprint (schema rows and every table's rows).
function fingerprint(file){
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),tables={};
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()){
   const h=crypto.createHash('sha256');let count=0;
   for(const r of db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).iterate()){h.update(JSON.stringify(r,(k,v)=>v instanceof Uint8Array?Buffer.from(v).toString('hex'):v)+'\n');count++}
   tables[name]={count,sha256:h.digest('hex')};
  }
  return JSON.stringify({schema,tables});
 }finally{db.close()}
}
const tableNames=file=>{const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name)}finally{db.close()}};
const write=(dir,files)=>{for(const [name,sql] of Object.entries(files))fs.writeFileSync(path.join(dir,name),sql);return dir};
const expectOf=dir=>loadMigrations(dir).map(m=>`${m.id}:${m.checksum}`).join(',');
const copy=(from,name)=>{const d=tmp(name),f=path.join(d,'fanscope.sqlite');fs.copyFileSync(from,f);return f};

const SAMPLE=`-- Sample additive migration used only in isolated tests.
CREATE TABLE paper_notes_sample(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 article_id TEXT NOT NULL REFERENCES articles(id),
 note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX idx_paper_notes_sample_article ON paper_notes_sample(article_id);
CREATE UNIQUE INDEX idx_paper_notes_sample_once ON paper_notes_sample(article_id,created_at);
/* additive column with a constant default: old rows read '' */
ALTER TABLE articles ADD COLUMN sample_flag TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_articles_sample_flag ON articles(sample_flag) WHERE sample_flag<>'';
INSERT INTO paper_notes_sample(article_id,note,created_at) VALUES('legacy-article','text; with -- no comment and DROP TABLE articles','2026-01-01');
`;
const SAMPLE_ID='20261030T010000Z_sample_paper_notes';

// One bootstrapped legacy database, copied per test. Raw = v1.2 fixture plus
// synthetic rows, before the current app has ever started on it.
const legacyRaw=path.join(tmp('legacy-raw'),'fanscope.sqlite');
{
 const db=new DatabaseSync(legacyRaw);
 db.exec(fs.readFileSync(new URL('./fixtures/v12-schema.sql',import.meta.url),'utf8'));
 db.exec(`INSERT INTO articles(id,journal_id,market,title,abstract,publication_date,discovered_at,source,analysis_status) VALUES('legacy-article','jmir','international','Legacy article','A synthetic abstract retained across migrations.','2025-02-01','2026-01-01','crossref','pending');
  INSERT INTO articles(id,journal_id,market,title,discovered_at,source) VALUES('legacy-cn','soc-review-cn','chinese','合成中文论文','2026-01-02','rss');
  INSERT INTO lab_users VALUES('legacy-user','Legacy','legacy@example.org','mentor','unchanged-password-hash','2026-01-01',1);
  INSERT INTO lab_projects VALUES('legacy-project','Legacy project','Keep me','active','','2026-01-01','legacy-user');
  INSERT INTO meta VALUES('legacy-key','legacy-value');`);
 db.close();
}
const legacyBooted=copy(legacyRaw,'legacy-booted');
const rawFingerprint=fingerprint(legacyBooted);
bootOk(legacyBooted);

test('fresh database with no migration files: startup, lint, status and apply make no change and create no ledger',()=>{
 const file=path.join(tmp('fresh'),'fanscope.sqlite');
 bootOk(file);
 const before=fingerprint(file);
 bootOk(file);
 assert.equal(fingerprint(file),before,'second startup must be byte-for-byte equivalent');
 assert.equal(run(['lint'],file).json.ok,true);
 const status=run(['status'],file);assert.equal(status.code,0);assert.equal(status.json.status,'up-to-date');assert.equal(status.json.ledger,false);
 for(const args of [['apply','--expect',''],['apply','--expect','','--dry-run']]){const r=run(args,file);assert.equal(r.code,0,JSON.stringify(r.json));assert.equal(r.json.status,'up-to-date')}
 assert.equal(fingerprint(file),before);
 assert.ok(!tableNames(file).includes(LEDGER));
 // The CLI never creates a database file.
 const missing=path.join(tmp('missing'),'none.sqlite'),r=run(['status'],missing);
 assert.equal(r.code,2);assert.equal(r.json.error.code,'DATABASE_MISSING');assert.ok(!fs.existsSync(missing));
});

test('legacy v1.2 database: first start runs the pre-existing legacy bootstrap; K3 adds no write of its own',()=>{
 // Pre-existing behaviour (not introduced by K3): the legacy bootstrap upgrades
 // a v1.2 database on first start. Recorded here so it is not mistaken for K3.
 assert.notEqual(fingerprint(legacyBooted),rawFingerprint);
 const file=copy(legacyBooted,'legacy-restart'),before=fingerprint(file);
 bootOk(file);
 assert.equal(fingerprint(file),before,'restart on an upgraded database is write-free');
 assert.ok(!tableNames(file).includes(LEDGER));
 // A pending migration blocks startup and still writes nothing.
 const dir=write(tmp('pending'),{[`${SAMPLE_ID}.sql`]:SAMPLE});
 const r=boot(file,{dir});
 assert.notEqual(r.status,0);assert.match(r.stderr,/MIGRATIONS_PENDING/);
 assert.equal(fingerprint(file),before);
});

test('single additive migration: exact reviewed apply, ledger record, data/indexes/legacy history preserved, idempotent',()=>{
 const file=copy(legacyBooted,'single'),dir=write(tmp('single-m'),{[`${SAMPLE_ID}.sql`]:SAMPLE});
 const sum=checksum(SAMPLE);
 const status=run(['status'],file,dir);
 assert.equal(status.json.status,'pending');assert.deepEqual(status.json.pending,[{id:SAMPLE_ID,checksum:sum}]);
 const pristine=fingerprint(file);
 // Apply requires the exact reviewed id+checksum list.
 assert.equal(run(['apply'],file,dir).json.error.code,'MIGRATION_PLAN_MISMATCH');
 assert.equal(run(['apply','--expect',''],file,dir).json.error.code,'MIGRATION_PLAN_MISMATCH');
 assert.equal(run(['apply','--expect',`${SAMPLE_ID}:${'0'.repeat(64)}`],file,dir).json.error.code,'MIGRATION_PLAN_MISMATCH');
 const dry=run(['apply','--dry-run','--expect',expectOf(dir)],file,dir);
 assert.equal(dry.code,0,JSON.stringify(dry.json));assert.equal(dry.json.status,'dry-run-ok');
 assert.equal(fingerprint(file),pristine,'dry-run and rejected applies leave the database untouched');

 const db0=new DatabaseSync(file);const before=captureState(db0);
 const legacyHistory=db0.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
 const indexes=db0.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name").all();db0.close();
 const applied=run(['apply','--expect',expectOf(dir),'--commit','0123456789abcdef0123456789abcdef01234567'],file,dir);
 assert.equal(applied.code,0,JSON.stringify(applied.json));assert.deepEqual(applied.json.applied.map(a=>a.id),[SAMPLE_ID]);

 const db=new DatabaseSync(file);
 try{
  const ledger=db.prepare(`SELECT * FROM ${LEDGER}`).all();
  assert.equal(ledger.length,1);assert.equal(ledger[0].checksum,sum);assert.equal(ledger[0].app_commit,'0123456789abcdef0123456789abcdef01234567');
  // Independent re-check of the effect (not trusting the runner's own verdict).
  const after=captureState(db,{baseline:before});
  const ledgerOnly=compareStates(before,after,lintMigration(SAMPLE).declared).filter(v=>v.object!==LEDGER);
  assert.deepEqual(ledgerOnly,[]);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),legacyHistory,'legacy schema_migrations untouched');
  const now=new Map(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index'").all().map(r=>[r.name,r.sql]));
  for(const i of indexes)assert.equal(now.get(i.name),i.sql,`index ${i.name} preserved`);
  assert.equal(db.prepare("SELECT sample_flag FROM articles WHERE id='legacy-article'").get().sample_flag,'');
  assert.equal(db.prepare("SELECT abstract FROM articles WHERE id='legacy-article'").get().abstract,'A synthetic abstract retained across migrations.');
  assert.equal(db.prepare('SELECT note FROM paper_notes_sample').get().note,'text; with -- no comment and DROP TABLE articles');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
 }finally{db.close()}
 // Startup now passes and is write-free again; repeated apply is a no-op.
 const migrated=fingerprint(file);
 bootOk(file,{dir});
 const again=run(['apply','--expect',expectOf(dir)],file,dir);
 assert.equal(again.json.status,'up-to-date');
 assert.equal(fingerprint(file),migrated);
});

test('older application code still starts, reads and writes after an additive migration (code-only rollback)',async()=>{
 const file=copy(legacyBooted,'compat'),dir=write(tmp('compat-m'),{[`${SAMPLE_ID}.sql`]:SAMPLE});
 assert.equal(run(['apply','--expect',expectOf(dir)],file,dir).code,0);
 // "Older image" = this build without the new migration file: database is ahead.
 // It exercises existing writers, including positional INSERTs and the HTTP read
 // paths the release controller checks.
 const r=bootOk(file,{code:`
  const {sql}=await import(${JSON.stringify(new URL('db.mjs',src).href)});const {makeServer}=await import(${JSON.stringify(new URL('server.mjs',src).href)});
  sql.insertArticle.run('after-migration','jmir','international','Inserted by old code',null,null,null,null,'2026-02-01',2026,'2026-02-01','crossref','[]',0,'pending',0);
  if(sql.getArticle.get('after-migration').title!=='Inserted by old code')throw Error('read back failed');
  db.prepare("INSERT INTO meta VALUES('old-code-key','v')").run();
  db.prepare("INSERT INTO lab_projects VALUES('old-project','Old code project','','planning','','2026-02-01','legacy-user')").run();
  const server=makeServer({readOnly:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{const base='http://127.0.0.1:'+server.address().port;
   const h=await (await fetch(base+'/api/health')).json();if(h.status!=='ok')throw Error('health');
   for(const market of ['international','chinese']){const n=db.prepare('SELECT count(*) n FROM articles a JOIN journals j ON j.id=a.journal_id WHERE a.demo=0 AND a.market=j.market AND a.market=?').get(market).n;
    const s=await fetch(base+'/api/stats?period=all&article_type=all&market='+market);if(!s.ok||(await s.json()).count!==n)throw Error('stats mismatch '+market)}
  }finally{server.close()}`});
 assert.match(r.stdout+r.stderr,/"event":"migrations\.database_ahead"/,'structured K1 warning');
 const db=new DatabaseSync(file);
 try{
  assert.equal(db.prepare("SELECT sample_flag FROM articles WHERE id='after-migration'").get().sample_flag,'','new column default applies to rows written by old code');
  assert.equal(db.prepare('SELECT count(*) n FROM paper_notes_sample').get().n,1,'old code leaves the new table alone');
  assert.equal(db.prepare(`SELECT count(*) n FROM ${LEDGER}`).get().n,1);
 }finally{db.close()}
 // But an older build must not try to apply on a newer database.
 assert.equal(run(['apply','--expect',''],file).json.error.code,'MIGRATION_UNKNOWN_APPLIED');
});

test('failing migration rolls back completely, including the first ledger creation; earlier committed steps stay recorded',()=>{
 const file=copy(legacyBooted,'fail'),before=fingerprint(file);
 const bad=`CREATE TABLE half_done(id TEXT PRIMARY KEY);\nALTER TABLE articles ADD COLUMN broken TEXT NOT NULL;\n`;
 const dir=write(tmp('fail-m'),{'20261030T020000Z_breaks.sql':bad});
 const r=run(['apply','--expect',expectOf(dir)],file,dir);
 assert.equal(r.code,2);assert.equal(r.json.error.code,'MIGRATION_FAILED');assert.match(r.json.error.details.sqlite,/NOT NULL/i);
 assert.equal(fingerprint(file),before);assert.ok(!tableNames(file).includes(LEDGER));assert.ok(!tableNames(file).includes('half_done'));
 // Two steps: the first commits, the second fails and is not recorded.
 const dir2=write(tmp('fail-two'),{[`${SAMPLE_ID}.sql`]:SAMPLE,'20261030T020000Z_breaks.sql':bad});
 const r2=run(['apply','--expect',expectOf(dir2)],file,dir2);
 assert.equal(r2.json.error.code,'MIGRATION_FAILED');assert.deepEqual(r2.json.error.details.committed,[SAMPLE_ID]);
 assert.deepEqual(run(['status'],file,dir2).json.pending.map(p=>p.id),['20261030T020000Z_breaks']);
 // A never-applied file may be fixed; the retry applies only the remainder.
 write(dir2,{'20261030T020000Z_breaks.sql':`ALTER TABLE articles ADD COLUMN fixed TEXT NOT NULL DEFAULT '';\n`});
 const r3=run(['apply','--expect',expectOf(dir2)],file,dir2);
 assert.equal(r3.code,0,JSON.stringify(r3.json));assert.deepEqual(r3.json.applied.map(a=>a.id),['20261030T020000Z_breaks']);
});

test('process killed after executing but before COMMIT: nothing is recorded and a retry applies cleanly',()=>{
 const file=copy(legacyBooted,'crash'),dir=write(tmp('crash-m'),{[`${SAMPLE_ID}.sql`]:SAMPLE}),before=fingerprint(file);
 const child=spawnSync(process.execPath,['--experimental-sqlite','--input-type=module','-e',`
  import {DatabaseSync} from 'node:sqlite';const m=await import(${JSON.stringify(new URL('migrations.mjs',src).href)});
  const db=new DatabaseSync(process.env.DATABASE_PATH);
  m.applyMigrations(db,{expect:m.loadMigrations().map(({id,checksum})=>({id,checksum})),hooks:{beforeCommit(){process.kill(process.pid,'SIGKILL')}}});
  console.log('unreachable');`],{env:env(file,dir),encoding:'utf8'});
 assert.notEqual(child.status,0);assert.doesNotMatch(child.stdout,/unreachable/);
 assert.equal(fingerprint(file),before,'uncommitted WAL frames are discarded on recovery');
 const db=new DatabaseSync(file);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
 const r=run(['apply','--expect',expectOf(dir)],file,dir);
 assert.equal(r.code,0,JSON.stringify(r.json));assert.deepEqual(r.json.applied.map(a=>a.id),[SAMPLE_ID]);
});

test('edited applied migration is detected at startup and apply; line-ending-only changes are not edits',()=>{
 const file=copy(legacyBooted,'edit'),dir=write(tmp('edit-m'),{[`${SAMPLE_ID}.sql`]:SAMPLE});
 assert.equal(run(['apply','--expect',expectOf(dir)],file,dir).code,0);
 write(dir,{[`${SAMPLE_ID}.sql`]:'﻿'+SAMPLE.replace(/\n/g,'\r\n')});
 assert.equal(run(['status'],file,dir).json.status,'up-to-date');
 bootOk(file,{dir});
 write(dir,{[`${SAMPLE_ID}.sql`]:SAMPLE.replace("DEFAULT ''","DEFAULT 'x'")});
 const before=fingerprint(file);
 const r=boot(file,{dir});assert.notEqual(r.status,0);assert.match(r.stderr,/MIGRATION_CHECKSUM_MISMATCH/);
 const s=run(['status'],file,dir);assert.equal(s.code,2);assert.equal(s.json.status,'checksum-mismatch');
 assert.equal(run(['apply','--expect',''],file,dir).json.error.code,'MIGRATION_CHECKSUM_MISMATCH');
 assert.equal(fingerprint(file),before);
});

test('history anomalies are reported, never repaired or deleted',()=>{
 const withLedger=(rows,cols)=>{
  const file=copy(legacyBooted,'history'),db=new DatabaseSync(file);
  db.exec(cols||`CREATE TABLE ${LEDGER}(id TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL,app_commit TEXT NOT NULL DEFAULT '',duration_ms INTEGER NOT NULL,runner_version INTEGER NOT NULL)`);
  for(const [id,sum] of rows)db.prepare(`INSERT INTO ${LEDGER} VALUES(?,?,'2026-01-01','',1,1)`).run(id,sum);
  return {file,db};
 };
 const dir=write(tmp('history-m'),{[`${SAMPLE_ID}.sql`]:SAMPLE}),migrations=loadMigrations(dir),expect=migrations.map(({id,checksum})=>({id,checksum}));
 // Unknown applied id (newer build ran first): startup tolerates, apply refuses.
 {const {db}=withLedger([['20261231T000000Z_from_newer_build','a'.repeat(64)]]);
  const warnings=[];assert.equal(verifyMigrationsAtStartup(db,{dir:emptyDir,warn:w=>warnings.push(w)}).status,'ahead');assert.equal(warnings.length,1);
  assert.throws(()=>applyMigrations(db,{dir:emptyDir,expect:[]}),{code:'MIGRATION_UNKNOWN_APPLIED'});db.close()}
 // Pending migration older than the last applied one.
 {const later='20261101T000000Z_later';const d2=write(tmp('ooo'),{[`${SAMPLE_ID}.sql`]:SAMPLE,[`${later}.sql`]:'CREATE TABLE later_t(id TEXT);'});
  const {db}=withLedger([[later,checksum('CREATE TABLE later_t(id TEXT);')]]);
  assert.throws(()=>applyMigrations(db,{dir:d2,expect}),{code:'MIGRATION_OUT_OF_ORDER'});db.close()}
 // Malformed ledger rows / columns.
 {const {db}=withLedger([['not-a-migration-id','zz']]);assert.throws(()=>verifyMigrationsAtStartup(db,{dir}),{code:'MIGRATION_LEDGER_INVALID'});
  assert.equal(db.prepare(`SELECT count(*) n FROM ${LEDGER}`).get().n,1,'bad row is kept for review');db.close()}
 {const {db}=withLedger([],`CREATE TABLE ${LEDGER}(id TEXT PRIMARY KEY)`);assert.throws(()=>planMigrations(db,{migrations}),{code:'MIGRATION_LEDGER_INVALID'});db.close()}
 // Legacy baseline incomplete: refuse rather than guess; legacy rows untouched.
 {const file=copy(legacyBooted,'baseline'),db=new DatabaseSync(file);db.exec("DELETE FROM schema_migrations WHERE version='rss-url'");
  const rows=db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  assert.throws(()=>applyMigrations(db,{dir,expect}),e=>e.code==='LEGACY_BASELINE_MISSING'&&e.details.missing.includes('rss-url'));
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),rows);assert.ok(LEGACY_BASELINE.includes('1.2'));db.close()}
});

test('lock contention fails fast with MIGRATION_LOCKED; concurrent runners apply exactly once',async()=>{
 const file=copy(legacyBooted,'lock'),dir=write(tmp('lock-m'),{[`${SAMPLE_ID}.sql`]:SAMPLE}),before=fingerprint(file);
 const expect=loadMigrations(dir).map(({id,checksum})=>({id,checksum}));
 const holder=new DatabaseSync(file),runner=new DatabaseSync(file);
 holder.exec('BEGIN IMMEDIATE');
 assert.throws(()=>applyMigrations(runner,{dir,expect,busyTimeoutMs:50}),e=>e.code==='MIGRATION_LOCKED'&&e.details.committed.length===0);
 holder.exec('ROLLBACK');holder.close();runner.close();
 assert.equal(fingerprint(file),before);
 const once=()=>new Promise(resolve=>{const c=spawn(process.execPath,['--experimental-sqlite',cli,'apply','--expect',expectOf(dir)],{env:env(file,dir)});let out='';c.stdout.on('data',d=>out+=d);c.on('close',code=>resolve({code,json:JSON.parse(out)}))});
 const results=await Promise.all([once(),once()]);
 for(const r of results)assert.equal(r.code,0,JSON.stringify(r.json));
 assert.equal(results.flatMap(r=>r.json.applied).length,1,'exactly one runner applied it');
 const db=new DatabaseSync(file);assert.equal(db.prepare(`SELECT count(*) n FROM ${LEDGER}`).get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM paper_notes_sample').get().n,1);db.close();
});

test('WAL: concurrent readers keep a consistent snapshot while a migration commits',()=>{
 const file=copy(legacyBooted,'wal'),dir=write(tmp('wal-m'),{[`${SAMPLE_ID}.sql`]:SAMPLE});
 const reader=new DatabaseSync(file),db=new DatabaseSync(file);
 reader.exec('BEGIN');const count=reader.prepare('SELECT count(*) n FROM articles').get().n;
 const has=()=>!!reader.prepare("SELECT 1 FROM sqlite_master WHERE name='paper_notes_sample'").get();
 let seenDuring;
 applyMigrations(db,{dir,expect:loadMigrations(dir).map(({id,checksum})=>({id,checksum})),hooks:{beforeCommit(){seenDuring=has()}}});
 assert.equal(seenDuring,false,'uncommitted schema invisible to readers');
 assert.equal(has(),false,'open read transaction keeps its snapshot');
 assert.equal(reader.prepare('SELECT count(*) n FROM articles').get().n,count);
 reader.exec('COMMIT');assert.equal(has(),true);
 assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
 reader.close();db.close();
});

test('static review rejects destructive or non-additive SQL before anything executes',()=>{
 const rejected={
  drop:'DROP TABLE meta;',dropIndex:'DROP INDEX idx_articles_market_date;',rename:'ALTER TABLE articles RENAME TO papers;',
  renameColumn:'ALTER TABLE articles RENAME COLUMN title TO name;',dropColumn:'ALTER TABLE articles DROP COLUMN abstract;',
  update:"UPDATE articles SET title='x';",delete:'DELETE FROM meta;',replace:"REPLACE INTO meta(key,value) VALUES('a','b');",
  pragma:'PRAGMA journal_mode=DELETE;',vacuum:'VACUUM;',attach:"ATTACH 'x.sqlite' AS x;",analyze:'ANALYZE;',
  txn:'BEGIN; CREATE TABLE t(id TEXT); COMMIT;',trigger:"CREATE TRIGGER t AFTER INSERT ON articles BEGIN UPDATE articles SET title='x'; END;",
  view:'CREATE VIEW v AS SELECT * FROM articles;',temp:'CREATE TEMP TABLE t(id TEXT);',ifNotExists:'CREATE TABLE IF NOT EXISTS meta(key TEXT);',
  asSelect:'CREATE TABLE copy AS SELECT * FROM articles;',uniqueExisting:'CREATE UNIQUE INDEX u ON articles(doi);',
  positional:"ALTER TABLE meta ADD COLUMN extra TEXT DEFAULT '';",labPositional:"ALTER TABLE lab_projects ADD COLUMN extra TEXT DEFAULT '';",
  insertExisting:"INSERT INTO meta(key,value) VALUES('k','v');",insertNoColumns:'CREATE TABLE t(id TEXT); INSERT INTO t VALUES(1);',
  qualified:'CREATE TABLE main.t(id TEXT);',otherVirtual:'CREATE VIRTUAL TABLE r USING rtree(id,a,b);',cte:'WITH x AS (SELECT 1) INSERT INTO t(id) SELECT * FROM x;',
  empty:'-- nothing here\n',hiddenAfterComment:"CREATE TABLE ok_t(id TEXT); /* ; */ DELETE FROM meta;",
 };
 for(const [name,sql] of Object.entries(rejected))assert.equal(lintMigration(sql).ok,false,`${name} must be rejected`);
 // Keywords inside comments or strings are not statements.
 assert.equal(lintMigration("-- DROP TABLE articles;\nCREATE TABLE t(id TEXT DEFAULT 'DROP TABLE x; DELETE FROM meta');").ok,true);
 assert.equal(lintMigration(SAMPLE).ok,true);
 // Rejected files never reach the database.
 const file=copy(legacyBooted,'lint'),before=fingerprint(file);
 for(const sql of [rejected.update,rejected.positional,rejected.uniqueExisting]){
  const dir=write(tmp('lint-m'),{'20261030T030000Z_bad.sql':sql});
  const r=run(['apply','--expect',expectOf(dir)],file,dir);assert.equal(r.json.error.code,'MIGRATION_SQL_REJECTED');
 }
 assert.equal(fingerprint(file),before);
});

test('effect verification catches non-additive changes independently of the static review',()=>{
 const file=copy(legacyBooted,'effect'),db=new DatabaseSync(file),none=lintMigration('CREATE TABLE declared_only(id TEXT);').declared;
 const check=sql=>{db.exec('BEGIN');try{const before=captureState(db);db.exec(sql);return compareStates(before,captureState(db,{baseline:before}),none).map(v=>v.code)}finally{db.exec('ROLLBACK')}};
 assert.deepEqual(check('CREATE TABLE declared_only(id TEXT)'),[]);
 assert.ok(check("UPDATE articles SET title='rewritten' WHERE id='legacy-article'").includes('EXISTING_DATA_CHANGED'));
 assert.ok(check("UPDATE lab_users SET password_hash='x'").includes('EXISTING_DATA_CHANGED'));
 assert.ok(check("DELETE FROM meta WHERE key='legacy-key'").includes('EXISTING_DATA_CHANGED'));
 assert.ok(check('DROP INDEX idx_articles_market_date').includes('OBJECT_REMOVED'));
 assert.ok(check('ALTER TABLE articles RENAME COLUMN title TO headline').includes('COLUMN_DEFINITION_CHANGED'));
 assert.ok(check("ALTER TABLE meta ADD COLUMN extra TEXT DEFAULT ''").includes('COLUMN_ADDED_TO_POSITIONAL_TABLE'));
 assert.ok(check("ALTER TABLE articles ADD COLUMN surprise TEXT DEFAULT ''").includes('UNDECLARED_COLUMN'));
 assert.ok(check('CREATE UNIQUE INDEX surprise_u ON articles(id,title)').includes('UNIQUE_INDEX_ON_EXISTING_TABLE'));
 assert.ok(check('CREATE TABLE surprise(id TEXT)').includes('UNDECLARED_TABLE'));
 assert.ok(check("CREATE TRIGGER surprise_t AFTER INSERT ON meta BEGIN SELECT 1; END").includes('DISALLOWED_OBJECT'));
 assert.ok(check('CREATE VIEW surprise_v AS SELECT id FROM articles').includes('DISALLOWED_OBJECT'));
 db.close();
});

test('migration files: strict UTC naming, deterministic order, duplicates and stray files rejected',()=>{
 const ok=write(tmp('names'),{'20261101T000000Z_b.sql':'CREATE TABLE b(id TEXT);','20261001T000000Z_a.sql':'CREATE TABLE a(id TEXT);','README.md':'docs'});
 assert.deepEqual(loadMigrations(ok).map(m=>m.id),['20261001T000000Z_a','20261101T000000Z_b']);
 const bad=files=>{const d=write(tmp('bad-names'),files);return ()=>loadMigrations(d)};
 assert.throws(bad({'0001_init.sql':'CREATE TABLE a(id TEXT);'}),{code:'MIGRATION_FILE_INVALID'});
 assert.throws(bad({'20261340T000000Z_bad_month.sql':'CREATE TABLE a(id TEXT);'}),{code:'MIGRATION_FILE_INVALID'});
 assert.throws(bad({'20261001T000000Z_Upper.sql':'CREATE TABLE a(id TEXT);'}),{code:'MIGRATION_FILE_INVALID'});
 assert.throws(bad({'notes.txt':'x'}),{code:'MIGRATION_FILE_INVALID'});
 assert.throws(bad({'20261001T000000Z_a.sql':'CREATE TABLE a(id TEXT);','20261001T000000Z_b.sql':'CREATE TABLE b(id TEXT);'}),{code:'MIGRATION_DUPLICATE_TIMESTAMP'});
 assert.throws(()=>loadMigrations(path.join(root,'does-not-exist')),{code:'MIGRATION_DIR_MISSING'});
 // Production never honours the test directory override.
 const r=spawnSync(process.execPath,['--experimental-sqlite','--input-type=module','-e',`const m=await import(${JSON.stringify(new URL('migrations.mjs',src).href)});console.log(m.migrationsDir())`],{env:{...process.env,NODE_ENV:'production',FANSCOPE_MIGRATIONS_DIR:emptyDir},encoding:'utf8'});
 assert.equal(r.stdout.trim(),fileURLToPath(new URL('../migrations',import.meta.url)));
});

test('FTS5 virtual table migration works on this Node/SQLite and passes effect verification',()=>{
 const file=copy(legacyBooted,'fts'),sql=`CREATE VIRTUAL TABLE evidence_fts_sample USING fts5(article_id UNINDEXED,body,tokenize='trigram');\nINSERT INTO evidence_fts_sample(article_id,body) VALUES('legacy-article','社会保障与健康不平等');\n`;
 const dir=write(tmp('fts-m'),{'20261030T040000Z_fts_sample.sql':sql});
 const r=run(['apply','--expect',expectOf(dir)],file,dir);assert.equal(r.code,0,JSON.stringify(r.json));
 const db=new DatabaseSync(file);assert.equal(db.prepare("SELECT article_id FROM evidence_fts_sample WHERE body MATCH '健康不平等'").get().article_id,'legacy-article');db.close();
});

test('repository migrations pass review and the positional-INSERT guard list covers current code',()=>{
 const results=loadMigrations().map(m=>({id:m.id,...lintMigration(m.sql)}));
 for(const r of results)assert.equal(r.ok,true,`${r.id}: ${JSON.stringify(r.problems)}`);
 const found=new Set();
 for(const f of fs.readdirSync(new URL('../src/',import.meta.url)))if(f.endsWith('.mjs')){
  const text=fs.readFileSync(new URL(`../src/${f}`,import.meta.url),'utf8');
  for(const m of text.matchAll(/(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+["`]?(\w+)["`]?\s+(?:VALUES|SELECT)\b/gi))found.add(m[1].toLowerCase());
 }
 const missing=[...found].filter(t=>!POSITIONAL_INSERT_TABLES.has(t));
 assert.deepEqual(missing,[],'add these tables to POSITIONAL_INSERT_TABLES (never remove entries: older images still use them)');
});
