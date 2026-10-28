// Read-only database proof. Never imports application modules or runs migrations.
// Store manifests privately: journal identifiers and schema names are included.
import fs from 'node:fs';import crypto from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
const [file,baselineFile]=process.argv.slice(2);if(!file||!fs.existsSync(file))throw Error('Usage: node chinese-release-db-proof.mjs EXISTING_SQLITE [BASELINE_PROOF_JSON]');
const previous=baselineFile?JSON.parse(fs.readFileSync(baselineFile,'utf8')):null;
const db=new DatabaseSync(file,{readOnly:true});const quote=s=>'"'+s.replaceAll('"','""')+'"';
try{
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name);
 const derived=new Set(['article_type','article_type_evidence_json','abstract_status','abstract_source','abstract_checked_at','abstract_error','relevance_score','analysis_input_hash','analysis_normalized_hash']);
 const scopes={};
 function scope(name,table,where='',params=[],columns=null){
  const info=db.prepare('PRAGMA table_info('+quote(table)+')').all();
  const selected=previous?.scopes[name]?.columns||columns||info.map(c=>c.name);
  if(!selected.every(c=>info.some(i=>i.name===c)))throw Error('Missing protected column: '+name);
  const pk=info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>quote(c.name));const order=pk.length?pk.join(','):'rowid';
  const h=crypto.createHash('sha256');let count=0;
  for(const row of db.prepare('SELECT '+selected.map(quote).join(',')+' FROM '+quote(table)+where+' ORDER BY '+order).iterate(...params)){h.update(JSON.stringify(row)+'\n');count++;}
  scopes[name]={table,columns:selected,count,sha256:h.digest('hex')};
 }
 const counts=Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT COUNT(*) n FROM '+quote(t)).get().n]));
 if(tables.includes('articles')){
  const columns=db.prepare('PRAGMA table_info(articles)').all().map(x=>x.name).filter(x=>!derived.has(x));
  scope('english','articles'," WHERE market='international'",[],columns);
  if(columns.includes('analysis_json'))scope('existing_ai','articles'," WHERE analysis_json IS NOT NULL",[],columns);
 }
 for(const t of tables.filter(t=>!['articles','journals','schema_migrations'].includes(t))){
  // New release import audit keys may be appended after import, never overwritten.
  scope(t,t,t==='meta'?" WHERE key NOT LIKE 'cn-production-import:%'":'');
 }
 const journalIds=previous?.journalIds||db.prepare('SELECT id FROM journals ORDER BY id').all().map(x=>x.id);
 const stableJournalColumns=['id','market','issn','source','enabled','rss_url','checkpoint','last_checked','last_success','last_error','last_count'].filter(c=>db.prepare('PRAGMA table_info(journals)').all().some(x=>x.name===c));
 scope('journal_state','journals',' WHERE id IN ('+journalIds.map(()=>'?').join(',')+')',journalIds,stableJournalColumns);
 const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check,foreignKeyViolations=db.prepare('PRAGMA foreign_key_check').all().length;
 const differences=previous?Object.keys(previous.scopes).filter(n=>!scopes[n]||previous.scopes[n].count!==scopes[n].count||previous.scopes[n].sha256!==scopes[n].sha256):[];
 const report={generatedAt:new Date().toISOString(),counts,journalIds,scopes,integrity,foreignKeyViolations,differences};
 console.log(JSON.stringify(report,null,2));
 if(integrity!=='ok'||foreignKeyViolations||differences.length)process.exitCode=1;
}finally{db.close();}
