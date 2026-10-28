// Read-only compatibility proof. The only allowed import mutation outside Chinese
// article rows/audits is filling the three package-verified Chinese ISSNs.
import fs from 'node:fs';import crypto from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
const [file,payloadFile,baselineFile]=process.argv.slice(2);if(!file||!fs.existsSync(file)||!payloadFile)throw Error('Existing DB and package required');
const payload=JSON.parse(fs.readFileSync(payloadFile,'utf8')),baseline=baselineFile?JSON.parse(fs.readFileSync(baselineFile,'utf8')):null;
const db=new DatabaseSync(file,{readOnly:true}),q=s=>'"'+s.replaceAll('"','""')+'"';
try{
 db.exec('BEGIN');const scopes={};
 for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
  const info=db.prepare('PRAGMA table_info('+q(name)+')').all();const columns=baseline?.scopes[name]?.columns||info.map(x=>x.name);
  if(columns.some(c=>!info.some(x=>x.name===c)))throw Error('Protected column missing');
  const keys=info.filter(x=>x.pk).sort((a,b)=>a.pk-b.pk).map(x=>q(x.name));
  const where=name==='articles'?" WHERE market<>'chinese'":name==='meta'?" WHERE key NOT LIKE 'cn-production-import:%'":'';
  const h=crypto.createHash('sha256');let count=0;
  for(const row of db.prepare('SELECT '+columns.map(q).join(',')+' FROM '+q(name)+where+' ORDER BY '+(keys.join(',')||'rowid')).iterate()){
   if(name==='journals'&&row.market==='chinese'&&payload.journals.some(j=>j.id===row.id)){
    const j=payload.journals.find(j=>j.id===row.id);if(row.issn&&row.issn!==j.issn)throw Error('Conflicting Chinese ISSN');delete row.issn;
   }
   h.update(JSON.stringify(row)+'\n');count++;
  }scopes[name]={columns,count,sha256:h.digest('hex')};
 }
 const differences=baseline?Object.keys(baseline.scopes).filter(k=>!scopes[k]||baseline.scopes[k].count!==scopes[k].count||baseline.scopes[k].sha256!==scopes[k].sha256):[];
 const integrity=db.prepare('PRAGMA integrity_check').all();const foreignKeys=db.prepare('PRAGMA foreign_key_check').all();
 const english=db.prepare("SELECT COUNT(*) n FROM articles WHERE market='international' AND demo=0").get().n,ai=db.prepare("SELECT COUNT(*) n FROM articles WHERE market='international' AND analysis_json IS NOT NULL AND analysis_json<>''").get().n,chinese=db.prepare("SELECT COUNT(*) n FROM articles WHERE market='chinese' AND demo=0").get().n;
 const report={scopes,differences,integrity:integrity.length===1?integrity[0].integrity_check:'failed',foreignKeys,english,ai,chinese,jobs:db.prepare('SELECT COUNT(*) n FROM jobs').get().n};console.log(JSON.stringify(report));
 if(report.integrity!=='ok'||differences.length||baseline&&JSON.stringify(foreignKeys)!==JSON.stringify(baseline.foreignKeys))process.exitCode=1;
 db.exec('ROLLBACK');
}finally{db.close()}
