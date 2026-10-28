import {fileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {execFileSync} from 'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
test('legacy database is backed up consistently, migrated twice, preserves accounts/articles/projects and privately archives notes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-migrate-')),file=path.join(dir,'legacy.sqlite');
 try{
  const env={...process.env,DATABASE_PATH:file,SCAN_ON_START:'false'};
  const entry=new URL('../src/lab.mjs',import.meta.url).href;
  execFileSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(entry)})`],{env});
  const db=new DatabaseSync(file);db.exec("INSERT INTO lab_users VALUES('legacy-user','Legacy','legacy@example.org','mentor','unchanged-password-hash','2026-01-01',1); INSERT INTO lab_projects VALUES('legacy-project','Legacy project','Keep me','active','','2026-01-01','legacy-user'); INSERT INTO lab_manuscripts VALUES('legacy-paper','Legacy paper','legacy-user','legacy-project','accepted','PRIVATE LEGACY NOTE','PRIVATE LEGACY NEXT STEP','2026-01-01','legacy-user'); DELETE FROM schema_migrations; INSERT INTO articles(id,journal_id,market,title,discovered_at,source) VALUES('legacy-article','jmir','international','Legacy article','2026-01-01','crossref');");db.close();
  for(let i=0;i<2;i++)execFileSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(entry)})`],{env});
  const migrated=new DatabaseSync(file);assert.equal(migrated.prepare('SELECT password_hash FROM lab_users').get().password_hash,'unchanged-password-hash');assert.equal(migrated.prepare('SELECT COUNT(*) n FROM articles').get().n,1);assert.equal(migrated.prepare('SELECT title FROM lab_projects').get().title,'Legacy project');assert.equal(migrated.prepare('SELECT private_note FROM lab_manuscripts').get().private_note,'');assert.equal(migrated.prepare('SELECT private_note FROM lab_private_manuscript_archive').get().private_note,'PRIVATE LEGACY NOTE');assert.equal(migrated.prepare('SELECT status FROM lab_manuscripts').get().status,'accepted');assert.equal(migrated.prepare('PRAGMA integrity_check').get().integrity_check,'ok');migrated.close();
  const backups=fs.readdirSync(dir).filter(n=>n.includes('pre-v1.2'));assert.equal(backups.length,1);const backup=new DatabaseSync(path.join(dir,backups[0]));assert.equal(backup.prepare('SELECT private_note FROM lab_manuscripts').get().private_note,'PRIVATE LEGACY NOTE');backup.close();
  execFileSync(process.execPath,[fileURLToPath(new URL('../src/backup.mjs',import.meta.url)),file,path.join(dir,'consistent.sqlite')]);assert.ok(fs.existsSync(path.join(dir,'consistent.sqlite')));
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
