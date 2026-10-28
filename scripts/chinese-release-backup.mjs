// Consistent backup helper: read-only source, no app imports, no migrations.
import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
const [source,target]=process.argv.slice(2);
if(!source||!target||!fs.existsSync(source)||fs.existsSync(target)||path.resolve(source)===path.resolve(target))throw Error('Existing source and NEW separate target required');
const db=new DatabaseSync(source,{readOnly:true});
try{
 if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Source integrity failure');
 db.prepare('VACUUM INTO ?').run(target);
 const restored=new DatabaseSync(target,{readOnly:true});try{
  if(restored.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||restored.prepare('PRAGMA foreign_key_check').all().length)throw Error('Backup verification failure');
 }finally{restored.close();}
 fs.chmodSync(target,0o600);console.log('Read-only-source SQLite snapshot verified');
}finally{db.close();}
