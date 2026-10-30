// Explicit migration entry point for operators and the release controller (K2).
// Never imports db.mjs, so `lint`/`status` cannot trigger the legacy bootstrap
// and `status` opens the database read-only.
//
//   node --experimental-sqlite src/migrate-cli.mjs lint
//   node --experimental-sqlite src/migrate-cli.mjs status  [--database FILE]
//   node --experimental-sqlite src/migrate-cli.mjs apply   [--database FILE] --expect ID:SHA256[,ID:SHA256] [--dry-run] [--commit SHA]
//
// Output is one JSON document on stdout. Exit codes: 0 ok, 2 migration error,
// 1 unexpected error. `apply` requires the exact reviewed list; `--expect ''`
// states that nothing is expected to be pending.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {parseArgs} from 'node:util';
import {applyMigrations,lintMigration,loadMigrations,MigrationError,migrationsDir,planMigrations,RUNNER_VERSION} from './migrations.mjs';

const {values,positionals}=parseArgs({allowPositionals:true,options:{database:{type:'string'},dir:{type:'string'},expect:{type:'string'},'dry-run':{type:'boolean',default:false},commit:{type:'string'},'busy-timeout-ms':{type:'string'}}});
const command=positionals[0];
const print=(value,code=0)=>{process.stdout.write(JSON.stringify(value,null,2)+'\n');process.exitCode=code};

function openDatabase(readOnly){
 const file=values.database||process.env.DATABASE_PATH;
 if(!file)throw new MigrationError('DATABASE_REQUIRED','Pass --database or set DATABASE_PATH');
 // Never create a database: a missing production file must stay a visible error.
 if(!fs.existsSync(file)||!fs.statSync(file).isFile()||!fs.statSync(file).size)throw new MigrationError('DATABASE_MISSING','Database file does not exist or is empty; refusing to create one',{database:file});
 return new DatabaseSync(file,{readOnly});
}
function parseExpect(text){
 if(text===undefined)throw new MigrationError('MIGRATION_PLAN_MISMATCH','apply requires --expect with the reviewed ID:SHA256 list (use --expect "" when none are pending)');
 return text.split(',').map(s=>s.trim()).filter(Boolean).map(s=>{const i=s.lastIndexOf(':');return {id:s.slice(0,i),checksum:s.slice(i+1)}});
}

try{
 const dir=values.dir||migrationsDir(),migrations=loadMigrations(dir);
 if(command==='lint'){
  const results=migrations.map(m=>({id:m.id,checksum:m.checksum,...lintMigration(m.sql)})).map(({declared,...r})=>r);
  print({ok:results.every(r=>r.ok),runnerVersion:RUNNER_VERSION,dir,migrations:results},results.every(r=>r.ok)?0:2);
 }else if(command==='status'){
  const db=openDatabase(true);
  try{const plan=planMigrations(db,{migrations});const ok=!plan.mismatched.length&&!plan.outOfOrder.length;print({ok,runnerVersion:RUNNER_VERSION,...plan},ok?0:2)}finally{db.close()}
 }else if(command==='apply'){
  const expect=parseExpect(values.expect),db=openDatabase(false);
  try{print({ok:true,runnerVersion:RUNNER_VERSION,...applyMigrations(db,{migrations,expect,dryRun:values['dry-run'],appCommit:values.commit||process.env.FANSCOPE_COMMIT||'',busyTimeoutMs:Number(values['busy-timeout-ms']||5000)})})}finally{db.close()}
 }else{
  print({ok:false,error:{code:'USAGE',message:'Commands: lint | status | apply'}},2);
 }
}catch(e){
 if(e instanceof MigrationError)print({ok:false,error:e.toJSON()},2);
 else print({ok:false,error:{code:'UNEXPECTED',message:String(e?.message||e).slice(0,300)}},1);
}
