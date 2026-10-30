// K3: versioned, additive-only SQLite migrations.
//
// Three separate paths, never mixed:
//  - verifyMigrationsAtStartup(): read-only. Normal app startup never applies
//    migrations; it refuses to start when reviewed migrations are pending or an
//    applied file was edited, so an unapproved schema change cannot slip in.
//  - planMigrations()/lint: read-only preflight for operators and the release
//    controller (K2). applyMigrations({dryRun:true}) executes and rolls back.
//  - applyMigrations(): explicit, one IMMEDIATE transaction per migration,
//    only for the exact reviewed set passed in `expect`.
// Legacy db.mjs bootstrap and its `schema_migrations` rows are left untouched;
// this runner records into its own ledger, created only by the first apply.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const RUNNER_VERSION=1;
export const LEDGER='fanscope_migrations';
const LEDGER_COLUMNS=['id','checksum','applied_at','app_commit','duration_ms','runner_version'];
const LEDGER_SQL=`CREATE TABLE ${LEDGER}(id TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL,app_commit TEXT NOT NULL DEFAULT '',duration_ms INTEGER NOT NULL,runner_version INTEGER NOT NULL)`;
const FILE=/^(\d{8}T\d{6}Z)_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const ID=/^\d{8}T\d{6}Z_[a-z0-9]+(?:_[a-z0-9]+)*$/;
// Every legacy db.mjs step must have run before the first versioned migration.
export const LEGACY_BASELINE=['1.2','1.3','1.3-stage3','1.3-stage4','trends-2026-quality','trends-2026-types-v3','rss-url'];
// Tables written with positional INSERTs (no column list, VALUES or SELECT)
// by current or released code. ADD COLUMN would break those writers, including
// an older image after a code-only rollback. A test keeps this list complete.
export const POSITIONAL_INSERT_TABLES=new Set(['article_metadata_checks','cn_import_batches','cn_import_licenses','lab_documents','lab_events','lab_import_batches','lab_import_rows','lab_manuscripts','lab_member_updates','lab_milestones','lab_private_manuscript_archive','lab_project_managers','lab_project_members','lab_project_records','lab_project_workspace','lab_projects','lab_sessions','lab_task_notes','lab_tasks','meta','provider_cache','schema_migrations',LEDGER]);

export class MigrationError extends Error{
 constructor(code,message,details={}){super(`${code}: ${message}`);this.name='MigrationError';this.code=code;this.details=details}
 toJSON(){return {code:this.code,message:this.message,details:this.details}}
}
const fail=(code,message,details)=>{throw new MigrationError(code,message,details)};

const apiRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Tests may point at an isolated directory; production images always use the
// directory baked into the image.
export function migrationsDir(){
 return process.env.FANSCOPE_MIGRATIONS_DIR&&process.env.NODE_ENV!=='production'?path.resolve(process.env.FANSCOPE_MIGRATIONS_DIR):path.join(apiRoot,'migrations');
}

export function checksum(text){return crypto.createHash('sha256').update(text,'utf8').digest('hex')}
// Line endings/BOM must not change identity between Windows and Linux checkouts.
const normalize=text=>text.replace(/^﻿/,'').replace(/\r\n?/g,'\n');

export function loadMigrations(dir=migrationsDir()){
 if(!fs.existsSync(dir)||!fs.statSync(dir).isDirectory())fail('MIGRATION_DIR_MISSING','Migration directory not found',{dir});
 const out=[],stamps=new Map();
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(entry.name==='README.md'&&entry.isFile())continue;
  const m=FILE.exec(entry.name);
  if(!m||!entry.isFile())fail('MIGRATION_FILE_INVALID','Expected a regular file named <YYYYMMDDTHHMMSSZ>_<lower_snake>.sql',{file:entry.name});
  const s=m[1],when=new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}Z`);
  if(Number.isNaN(when.getTime())||when.toISOString().replace(/[-:]|\.\d{3}/g,'')!==s)fail('MIGRATION_FILE_INVALID','Invalid UTC timestamp',{file:entry.name});
  if(stamps.has(s))fail('MIGRATION_DUPLICATE_TIMESTAMP','Two migrations share a timestamp; ordering would be ambiguous',{files:[stamps.get(s),entry.name]});
  stamps.set(s,entry.name);
  const sql=normalize(fs.readFileSync(path.join(dir,entry.name),'utf8'));
  out.push({id:entry.name.slice(0,-4),file:entry.name,sql,checksum:checksum(sql)});
 }
 return out.sort((a,b)=>a.id<b.id?-1:1);
}

// --- Static review -----------------------------------------------------------
// A small tokenizer so comments and string literals cannot hide or fake
// statements. It is a first gate only; captureState()/compareStates() verify
// the actual effect inside the transaction.
export function tokenize(sql){
 const statements=[];let tokens=[],start=0,i=0;
 const flush=end=>{if(tokens.length)statements.push({text:sql.slice(start,end).trim(),tokens});tokens=[];start=end+1};
 while(i<sql.length){
  const c=sql[i];
  if(/\s/.test(c)){i++;continue}
  if(c==='-'&&sql[i+1]==='-'){const n=sql.indexOf('\n',i);i=n<0?sql.length:n;continue}
  if(c==='/'&&sql[i+1]==='*'){const n=sql.indexOf('*/',i+2);if(n<0)fail('MIGRATION_SQL_INVALID','Unterminated block comment');i=n+2;continue}
  if(c===';'){flush(i);i++;continue}
  const close={"'":"'",'"':'"','`':'`','[':']'}[c];
  if(close){
   let j=i+1,v='';
   for(;;){if(j>=sql.length)fail('MIGRATION_SQL_INVALID','Unterminated quoted token');if(sql[j]===close){if(close!==']'&&sql[j+1]===close){v+=close;j+=2;continue}break}v+=sql[j++]}
   tokens.push({t:c==="'"?'string':'ident',v,u:v.toUpperCase()});i=j+1;continue;
  }
  const word=/^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i,i+256));
  if(word){tokens.push({t:'word',v:word[0],u:word[0].toUpperCase()});i+=word[0].length;continue}
  const num=/^[0-9][0-9A-Za-z_.]*/.exec(sql.slice(i,i+256));
  if(num){tokens.push({t:'number',v:num[0],u:num[0]});i+=num[0].length;continue}
  tokens.push({t:'punct',v:c,u:c});i++;
 }
 flush(sql.length);
 return statements;
}

// Allowed: CREATE TABLE, CREATE [UNIQUE] INDEX (unique only on new tables),
// CREATE VIRTUAL TABLE ... USING fts5, ALTER TABLE ... ADD [COLUMN], and
// INSERT with an explicit column list into a table created by this migration.
// Everything else (DROP, RENAME, DROP COLUMN, UPDATE, DELETE, triggers, views,
// PRAGMA, transaction control, ATTACH, ANALYZE, ...) is rejected; there is no
// in-file override because the author would be approving their own change.
export function lintMigration(sql){
 const statements=tokenize(sql),declared={tables:new Set(),virtualTables:new Set(),indexes:new Set(),columns:new Set()},problems=[];
 if(!statements.length)problems.push({statement:'',reason:'Migration contains no SQL statements'});
 for(const {text,tokens} of statements){
  const k=i=>tokens[i]?.t==='word'?tokens[i].u:null;
  const name=i=>{const t=tokens[i];if(!t||!['word','ident'].includes(t.t))return null;if(tokens[i+1]?.v==='.')return undefined;return t.v.toLowerCase()};
  const reject=reason=>problems.push({statement:text.slice(0,200),reason});
  const head=tokens.slice(0,4).map(t=>t.u).join(' ');
  if(k(0)==='CREATE'&&['TEMP','TEMPORARY'].includes(k(1))){reject('Temporary objects are not migrations');continue}
  if(k(0)==='CREATE'&&k(1)==='TABLE'){
   if(k(2)==='IF'){reject('IF NOT EXISTS hides drift; a versioned migration must create a new table');continue}
   const n=name(2);if(!n){reject('Schema-qualified or missing table name');continue}
   if(tokens[3]?.v!=='('){reject('CREATE TABLE ... AS SELECT is not allowed');continue}
   declared.tables.add(n);continue;
  }
  if(k(0)==='CREATE'&&k(1)==='VIRTUAL'&&k(2)==='TABLE'){
   if(k(3)==='IF'){reject('IF NOT EXISTS hides drift');continue}
   const n=name(3);if(!n){reject('Schema-qualified or missing table name');continue}
   if(k(4)!=='USING'||k(5)!=='FTS5'){reject('Only fts5 virtual tables are allowed');continue}
   declared.tables.add(n);declared.virtualTables.add(n);continue;
  }
  if(k(0)==='CREATE'&&(k(1)==='INDEX'||(k(1)==='UNIQUE'&&k(2)==='INDEX'))){
   const unique=k(1)==='UNIQUE',p=unique?3:2;
   if(k(p)==='IF'){reject('IF NOT EXISTS hides drift');continue}
   const n=name(p),table=k(p+1)==='ON'?name(p+2):null;
   if(!n||!table){reject('Schema-qualified or malformed index');continue}
   if(unique&&!declared.tables.has(table)){reject(`UNIQUE index on existing table "${table}" can break existing writers`);continue}
   declared.indexes.add(n);continue;
  }
  if(k(0)==='ALTER'&&k(1)==='TABLE'){
   const table=name(2);if(!table){reject('Schema-qualified or missing table name');continue}
   if(k(3)!=='ADD'){reject(`ALTER TABLE ... ${tokens[3]?.u||''} is not additive`);continue}
   const col=k(4)==='COLUMN'?name(5):name(4);if(!col){reject('Missing column name');continue}
   if(POSITIONAL_INSERT_TABLES.has(table)){reject(`"${table}" is written with positional INSERT; ADD COLUMN would break current and older code`);continue}
   declared.columns.add(`${table}.${col}`);continue;
  }
  if(k(0)==='INSERT'){
   let p=1;if(k(1)==='OR')p=3;
   if(k(p)!=='INTO'){reject('Malformed INSERT');continue}
   const table=name(p+1);
   if(!table||!declared.tables.has(table)){reject('INSERT is only allowed into a table created earlier in the same migration');continue}
   if(tokens[p+2]?.v!=='('){reject('INSERT requires an explicit column list');continue}
   continue;
  }
  reject(`Statement "${head}" is not an approved additive operation`);
 }
 return {ok:!problems.length,statements:statements.length,problems,declared};
}

// --- Effect verification ---------------------------------------------------
const q=name=>'"'+String(name).replace(/"/g,'""')+'"';
function digestRows(db,table,columns,order){
 const h=crypto.createHash('sha256');let count=0;
 if(!columns.length)return {count,sha256:h.digest('hex')};
 for(const row of db.prepare(`SELECT ${columns.map(q).join(',')} FROM ${q(table)} ORDER BY ${order}`).iterate()){
  h.update(JSON.stringify(columns.map(c=>{const v=row[c];return v instanceof Uint8Array?['blob',Buffer.from(v).toString('hex')]:[typeof v,typeof v==='bigint'?String(v):v]}))+'\n');count++;
 }
 return {count,sha256:h.digest('hex')};
}

// Schema of every object plus a content digest of every pre-existing table.
// With `baseline`, only tables that existed in it are hashed, over exactly the
// columns they had then, so an added column is not mistaken for a rewrite.
export function captureState(db,{baseline}={}){
 const objects=new Map(),tables=new Map();
 for(const r of db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master').all())objects.set(r.name,{...r});
 const kinds=new Map(db.prepare('PRAGMA table_list').all().filter(r=>r.schema==='main').map(r=>[r.name,r]));
 for(const o of objects.values()){
  if(o.type!=='table')continue;
  const kind=kinds.get(o.name);
  const columns=db.prepare(`PRAGMA table_xinfo(${q(o.name)})`).all().map(c=>({name:c.name,type:c.type,notnull:c.notnull,dflt_value:c.dflt_value,pk:c.pk,hidden:c.hidden}));
  const indexes=db.prepare(`PRAGMA index_list(${q(o.name)})`).all().map(i=>({name:i.name,unique:i.unique,origin:i.origin,partial:i.partial}));
  const fks=db.prepare(`PRAGMA foreign_key_list(${q(o.name)})`).all().map(f=>JSON.stringify([f.id,f.seq,f.table,f.from,f.to,f.on_update,f.on_delete]));
  const t={kind:kind?.type||'table',withoutRowid:!!kind?.wr,columns,indexes,fks};
  const base=baseline?baseline.tables.get(o.name):t;
  if(base&&t.kind!=='virtual'){
   const cols=base.columns.filter(c=>c.hidden===0).map(c=>c.name),present=new Set(columns.map(c=>c.name));
   if(o.name==='sqlite_sequence')t.data=null;// compared per-row below
   else if(!cols.every(c=>present.has(c)))t.data={missingColumns:true};// reported as a column change
   else t.data=digestRows(db,o.name,cols,t.withoutRowid?cols.map(q).concat(cols.map(c=>`typeof(${q(c)})`)).join(','):'rowid');
  }
  tables.set(o.name,t);
 }
 const sequence=objects.has('sqlite_sequence')?new Map(db.prepare('SELECT name,seq FROM sqlite_sequence').all().map(r=>[r.name,r.seq])):new Map();
 return {objects,tables,sequence};
}

// Returns a list of violations; empty means the change was purely additive and
// matches what the reviewed SQL declared.
export function compareStates(before,after,declared){
 const v=[],same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 for(const [name,o] of before.objects){
  const n=after.objects.get(name);
  if(!n){v.push({code:'OBJECT_REMOVED',object:name,type:o.type});continue}
  if(n.type!==o.type){v.push({code:'OBJECT_TYPE_CHANGED',object:name});continue}
  if(o.type!=='table'){if(n.sql!==o.sql||n.tbl_name!==o.tbl_name)v.push({code:'OBJECT_DEFINITION_CHANGED',object:name,type:o.type});continue}
  const bt=before.tables.get(name),at=after.tables.get(name);
  if(!same(at.columns.slice(0,bt.columns.length),bt.columns)){v.push({code:'COLUMN_DEFINITION_CHANGED',object:name});continue}
  for(const c of at.columns.slice(bt.columns.length)){
   if(POSITIONAL_INSERT_TABLES.has(name.toLowerCase()))v.push({code:'COLUMN_ADDED_TO_POSITIONAL_TABLE',object:name,column:c.name});
   if(!declared?.columns.has(`${name.toLowerCase()}.${c.name.toLowerCase()}`))v.push({code:'UNDECLARED_COLUMN',object:name,column:c.name});
  }
  if(!bt.fks.every(f=>at.fks.includes(f)))v.push({code:'FOREIGN_KEY_CHANGED',object:name});
  if(bt.data&&!same(bt.data,at.data))v.push({code:'EXISTING_DATA_CHANGED',object:name,before:bt.data.count,after:at.data?.count});
 }
 for(const [name,seq] of before.sequence)if(after.sequence.get(name)!==seq)v.push({code:'EXISTING_DATA_CHANGED',object:'sqlite_sequence',row:name});
 const shadowOf=name=>[...(declared?.virtualTables||[])].some(vt=>name.toLowerCase().startsWith(vt+'_'));
 for(const [name,o] of after.objects){
  if(before.objects.has(name))continue;
  const lower=name.toLowerCase();
  if(o.type==='table'){
   if(declared?.tables.has(lower)||shadowOf(lower)||name==='sqlite_sequence')continue;
   v.push({code:'UNDECLARED_TABLE',object:name});continue;
  }
  if(o.type==='index'){
   const autoOfNew=name.startsWith('sqlite_autoindex_')&&!before.objects.has(o.tbl_name);
   if(!autoOfNew&&!declared?.indexes.has(lower)&&!shadowOf(o.tbl_name.toLowerCase()))v.push({code:'UNDECLARED_INDEX',object:name});
   const unique=after.tables.get(o.tbl_name)?.indexes.find(i=>i.name===name)?.unique;
   if(unique&&before.objects.has(o.tbl_name))v.push({code:'UNIQUE_INDEX_ON_EXISTING_TABLE',object:name,table:o.tbl_name});
   continue;
  }
  v.push({code:'DISALLOWED_OBJECT',object:name,type:o.type});
 }
 return v;
}

// --- Ledger / plan -----------------------------------------------------------
function ledgerRows(db){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(LEDGER))return null;
 const cols=db.prepare(`PRAGMA table_info(${LEDGER})`).all().map(c=>c.name);
 if(cols.join()!==LEDGER_COLUMNS.join())fail('MIGRATION_LEDGER_INVALID','Ledger table has unexpected columns',{columns:cols});
 const rows=db.prepare(`SELECT id,checksum,applied_at,app_commit FROM ${LEDGER} ORDER BY id`).all();
 for(const r of rows)if(!ID.test(String(r.id))||!/^[a-f0-9]{64}$/.test(String(r.checksum)))fail('MIGRATION_LEDGER_INVALID','Ledger row is malformed',{id:String(r.id)});
 return rows;
}

// Read-only comparison of files on disk with the ledger.
export function planMigrations(db,{migrations=loadMigrations()}={}){
 const rows=ledgerRows(db),applied=new Map((rows||[]).map(r=>[r.id,r]));
 const files=new Map(migrations.map(m=>[m.id,m]));
 const pending=migrations.filter(m=>!applied.has(m.id)).map(({id,checksum})=>({id,checksum}));
 const mismatched=migrations.filter(m=>applied.has(m.id)&&applied.get(m.id).checksum!==m.checksum).map(m=>({id:m.id,expected:applied.get(m.id).checksum,actual:m.checksum}));
 const unknownApplied=[...applied.keys()].filter(id=>!files.has(id));
 const lastApplied=rows?.length?rows[rows.length-1].id:null;
 const outOfOrder=lastApplied?pending.filter(p=>p.id<lastApplied).map(p=>p.id):[];
 const status=mismatched.length?'checksum-mismatch':pending.length?'pending':unknownApplied.length?'ahead':'up-to-date';
 return {status,ledger:!!rows,applied:(rows||[]).map(r=>({id:r.id,checksum:r.checksum,appliedAt:r.applied_at,appCommit:r.app_commit})),pending,mismatched,unknownApplied,outOfOrder};
}

// Read-only facts for /api/health and release verification.
export function migrationSummary(db){
 const rows=ledgerRows(db)||[];
 return {runner:RUNNER_VERSION,applied:rows.length,latest:rows.length?rows[rows.length-1].id:null};
}

// Startup gate. Strictly read-only: only SELECT/PRAGMA reads. `warn` receives
// structured fields; db.mjs passes the K1 logger.
export function verifyMigrationsAtStartup(db,{dir=migrationsDir(),warn=fields=>console.warn(JSON.stringify({level:'warn',event:'migrations.database_ahead',...fields}))}={}){
 const plan=planMigrations(db,{migrations:loadMigrations(dir)});
 if(plan.mismatched.length)fail('MIGRATION_CHECKSUM_MISMATCH','An applied migration file was modified; restore the reviewed file and add a new migration instead',{mismatched:plan.mismatched});
 if(plan.pending.length)fail('MIGRATIONS_PENDING','Reviewed migrations must be applied explicitly (migrate-cli.mjs apply) before startup; startup never changes the schema',{pending:plan.pending.map(p=>p.id)});
 // Code-only rollback: an older image may run on a database migrated by a newer
 // one. Additive-only migrations keep that readable, so warn and continue.
 if(plan.unknownApplied.length)warn({unknown_applied:plan.unknownApplied});
 return plan;
}

function checkExpectation(plan,expect){
 if(!Array.isArray(expect))fail('MIGRATION_PLAN_MISMATCH','apply requires the exact reviewed migration list (expect)');
 const applied=new Map(plan.applied.map(a=>[a.id,a.checksum])),pending=new Map(plan.pending.map(p=>[p.id,p.checksum]));
 const expected=new Map();
 for(const e of expect){
  if(!e||!ID.test(e.id)||!/^[a-f0-9]{64}$/.test(e.checksum)||expected.has(e.id))fail('MIGRATION_PLAN_MISMATCH','Malformed expected migration entry',{entry:e});
  expected.set(e.id,e.checksum);
  const actual=applied.get(e.id)??pending.get(e.id);
  if(actual!==e.checksum)fail('MIGRATION_PLAN_MISMATCH','Expected migration is missing or its checksum differs',{id:e.id,expected:e.checksum,actual:actual||null});
 }
 const unexpected=plan.pending.filter(p=>!expected.has(p.id)).map(p=>p.id);
 if(unexpected.length)fail('MIGRATION_PLAN_MISMATCH','Pending migrations were not in the reviewed list',{unexpected});
}

const isBusy=e=>/database is locked|SQLITE_BUSY|database table is locked/i.test(String(e?.message));
const rollback=db=>{try{db.exec('ROLLBACK')}catch{}};

// Apply exactly the reviewed pending set. Each migration runs in its own
// BEGIN IMMEDIATE transaction together with its ledger row, so a failure or a
// killed process can never leave a migration recorded without its effect.
export function applyMigrations(db,{dir=migrationsDir(),migrations,expect,dryRun=false,appCommit='',busyTimeoutMs=5000,hooks={}}={}){
 migrations??=loadMigrations(dir);
 const plan=planMigrations(db,{migrations});
 if(plan.mismatched.length)fail('MIGRATION_CHECKSUM_MISMATCH','An applied migration file was modified',{mismatched:plan.mismatched});
 if(plan.unknownApplied.length)fail('MIGRATION_UNKNOWN_APPLIED','Database has migrations this code does not know; refusing to apply from an older build',{unknownApplied:plan.unknownApplied});
 if(plan.outOfOrder.length)fail('MIGRATION_OUT_OF_ORDER','Pending migration is older than the last applied one; rename it with a new timestamp',{outOfOrder:plan.outOfOrder});
 checkExpectation(plan,expect);
 if(!plan.pending.length)return {status:'up-to-date',dryRun,applied:[],skipped:[]};
 const hasLegacy=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
 const legacy=new Set(hasLegacy?db.prepare('SELECT version FROM schema_migrations').all().map(r=>r.version):[]);
 const missing=LEGACY_BASELINE.filter(x=>!legacy.has(x));
 if(missing.length)fail('LEGACY_BASELINE_MISSING','Start the application once so the legacy bootstrap completes before applying versioned migrations',{missing});
 const byId=new Map(migrations.map(m=>[m.id,m])),todo=plan.pending.map(p=>byId.get(p.id));
 for(const m of todo){const lint=lintMigration(m.sql);if(!lint.ok)fail('MIGRATION_SQL_REJECTED','Migration contains statements outside the additive allowlist',{id:m.id,problems:lint.problems});m.lint=lint}
 db.exec(`PRAGMA busy_timeout=${Math.max(0,Math.trunc(busyTimeoutMs))}; PRAGMA foreign_keys=ON`);
 const applied=[],skipped=[];
 const begin=()=>{try{db.exec('BEGIN IMMEDIATE')}catch(e){if(isBusy(e))fail('MIGRATION_LOCKED','Database is locked by another writer; nothing was applied in this step',{applied:applied.map(a=>a.id)});throw e}};
 const runOne=m=>{
  // Re-read inside the write lock: a concurrent runner may have finished first.
  const current=ledgerRows(db)?.find(r=>r.id===m.id);
  if(current){if(current.checksum!==m.checksum)fail('MIGRATION_CHECKSUM_MISMATCH','Concurrently applied migration differs',{id:m.id});skipped.push(m.id);return false}
  if(!ledgerRows(db))db.exec(LEDGER_SQL);
  const before=captureState(db),started=Date.now();
  try{db.exec(m.sql)}catch(e){fail('MIGRATION_FAILED','Migration SQL failed and was rolled back',{id:m.id,sqlite:String(e.message).slice(0,300)})}
  hooks.afterExec?.(m);
  const after=captureState(db,{baseline:before});
  const violations=compareStates(before,after,m.lint.declared);
  const fk=[...after.tables.keys()].filter(t=>after.tables.get(t).kind!=='virtual'&&(!before.tables.has(t)||after.tables.get(t).columns.length!==before.tables.get(t).columns.length)).flatMap(t=>db.prepare(`PRAGMA foreign_key_check(${q(t)})`).all());
  if(fk.length)violations.push({code:'FOREIGN_KEY_VIOLATION',rows:fk.length});
  if(violations.length)fail('MIGRATION_NOT_ADDITIVE','Migration effect is not a declared additive change; rolled back',{id:m.id,violations});
  const duration=Date.now()-started;
  db.prepare(`INSERT INTO ${LEDGER}(id,checksum,applied_at,app_commit,duration_ms,runner_version) VALUES(?,?,?,?,?,?)`).run(m.id,m.checksum,new Date().toISOString(),String(appCommit||''),duration,RUNNER_VERSION);
  return {id:m.id,checksum:m.checksum,durationMs:duration};
 };
 try{
  if(dryRun){begin();for(const m of todo){const r=runOne(m);if(r)applied.push(r)}hooks.beforeCommit?.();rollback(db);}
  // Reported as applied only once COMMIT has returned.
  else for(const m of todo){begin();const r=runOne(m);if(r){hooks.beforeCommit?.(m);db.exec('COMMIT');applied.push(r)}else rollback(db)}
 }catch(e){
  rollback(db);
  const err=e instanceof MigrationError?e:new MigrationError(isBusy(e)?'MIGRATION_LOCKED':'MIGRATION_FAILED',String(e.message).slice(0,300),{});
  err.details={...err.details,committed:dryRun?[]:applied.map(a=>a.id)};
  throw err;
 }
 return {status:dryRun?'dry-run-ok':'applied',dryRun,applied,skipped};
}
