// Run before starting the upgraded application: does not import db.mjs/migrations.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
const [source,target]=process.argv.slice(2);
if(!source||!target||!fs.existsSync(source)||fs.existsSync(target))throw Error('Usage: node --experimental-sqlite src/backup.mjs EXISTING_DB NEW_BACKUP_PATH');
const db=new DatabaseSync(source);try{db.prepare('VACUUM INTO ?').run(target);const check=new DatabaseSync(target,{readOnly:true});try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Backup integrity check failed');}finally{check.close();}fs.chmodSync(target,0o600);console.log('Consistent SQLite backup verified.');}finally{db.close();}
