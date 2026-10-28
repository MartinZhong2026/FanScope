// Explicit offline incremental importer; never use an HTTP route or replace a database.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
const args=Object.fromEntries(process.argv.slice(2).map(x=>{const i=x.indexOf('=');return i<0?[x,true]:[x.slice(0,i),x.slice(i+1)];}));
if(!args['--db']||!args['--package']||!args['--sha256']||!args['--apply'])throw Error('Usage: --db=EXISTING --package=JSON --sha256=EXPECTED --apply (writes only after review)');
const file=path.resolve(args['--db']);if(!fs.existsSync(file)||!fs.statSync(file).size)throw Error('Existing database required');
const bytes=fs.readFileSync(args['--package']),sha=crypto.createHash('sha256').update(bytes).digest('hex');
if(sha!==args['--sha256'])throw Error('Migration SHA256 mismatch');
const payload=JSON.parse(bytes);if(payload.schemaVersion!==1||payload.authorization?.kind!=='user_confirmation'||!payload.authorization.statement||!Array.isArray(payload.records)||!payload.records.length)throw Error('Invalid authorized migration package');
const pre=new DatabaseSync(file,{readOnly:true});try{
 const cols=new Set(pre.prepare('PRAGMA table_info(articles)').all().map(x=>x.name));
 for(const c of ['market','chinese_identity_key','source_updated_at','analysis_json','source_evidence_json'])if(!cols.has(c))throw Error('Target schema incompatible: '+c);
 for(const j of payload.journals){const actual=pre.prepare('SELECT market,issn,title FROM journals WHERE id=?').get(j.id);if(!actual||actual.market!=='chinese'||actual.issn&&actual.issn!==j.issn||actual.title!==j.title)throw Error('Target journal identity mismatch: '+j.id);}
}finally{pre.close()}
Object.assign(process.env,{DATABASE_PATH:file,FANSCOPE_OFFLINE_CHINESE_IMPORT:'true',DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:''});
globalThis.fetch=async()=>{throw Error('No network allowed in offline migration')};
const {db}=await import('./db.mjs');
const {importChinese,validateChineseItem,chineseIdentity}=await import('./chinese-ingestion.mjs');
const q=s=>'"'+s.replaceAll('"','""')+'"';
function protectedState(){
 const scopes={};for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
  const info=db.prepare('PRAGMA table_info('+q(name)+')').all(),keys=info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>q(c.name)),h=crypto.createHash('sha256');let count=0;
  const where=name==='articles'?" WHERE market<>'chinese'":name==='meta'?" WHERE key NOT LIKE 'cn-production-import:%'":'';
  for(const row of db.prepare('SELECT * FROM '+q(name)+where+' ORDER BY '+(keys.join(',')||'rowid')).iterate()){if(name==='journals'&&row.market==='chinese'&&payload.journals.some(j=>j.id===row.id))delete row.issn;h.update(JSON.stringify(row)+'\n');count++;}scopes[name]={count,sha256:h.digest('hex')};
 }return JSON.stringify(scopes);
}
let transaction=false;
try{
 const seen=new Set();for(const a of payload.records){const j=payload.journals.find(j=>j.id===a.journal_id);if(!j||a.market!=='chinese'||a.demo!==0||validateChineseItem(j,a))throw Error('Invalid paper: '+a.id);const key=a.journal_id+':'+chineseIdentity(a);if(seen.has(key))throw Error('Duplicate input identity');seen.add(key);}
 db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');transaction=true;
 const before=protectedState(),foreignBefore=JSON.stringify(db.prepare('PRAGMA foreign_key_check').all());
 const summary={added:0,duplicates:0,updated:0,journalIssnsFilled:0,records:payload.records.length,sha256:sha};
 for(const j of payload.journals){const original=db.prepare('SELECT * FROM journals WHERE id=?').get(j.id);if(!original.issn){db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)').run('cn-production-import:'+sha+':journal:'+j.id,JSON.stringify({original,verifiedIssn:j.issn,authorization:payload.authorization}));summary.journalIssnsFilled+=Number(db.prepare("UPDATE journals SET issn=? WHERE id=? AND market='chinese' AND coalesce(issn,'')='' AND title=?").run(j.issn,j.id,j.title).changes);}}
 for(const j of payload.journals){const rows=payload.records.filter(a=>a.journal_id===j.id);for(let offset=0;offset<rows.length;offset+=100){
  const part=rows.slice(offset,offset+100);const r=importChinese({journalId:j.id,items:part,authorized:true},()=>{},{withinTransaction:true,authorizationEvidence:payload.authorization});
  if(r.rejected.length||r.review.length||r.valid!==part.length)throw Error('Import conflict/review required: '+JSON.stringify({journal:j.id,rejected:r.rejected,review:r.review}));
  for(const k of ['added','duplicates','updated'])summary[k]+=r[k];
  for(const original of part){const row=db.prepare("SELECT id,market FROM articles WHERE journal_id=? AND (chinese_identity_key=? OR url=? OR publisher_landing_url=?) LIMIT 1").get(j.id,chineseIdentity(original),original.url,original.url);if(!row||row.market!=='chinese')throw Error('Imported record not traceable');db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)').run('cn-production-import:'+sha+':record:'+original.id,JSON.stringify({original,targetId:row.id,authorization:payload.authorization}));}
 }}
 for(const j of payload.journals)if(db.prepare('SELECT issn FROM journals WHERE id=?').get(j.id).issn!==j.issn)throw Error('Target journal ISSN mismatch after import');
 if(before!==protectedState())throw Error('Protected English/AI/tasks/users/journal data changed');
 if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||foreignBefore!==JSON.stringify(db.prepare('PRAGMA foreign_key_check').all()))throw Error('Integrity/foreign key regression');
 summary.finalChinese=db.prepare("SELECT COUNT(*) n FROM articles WHERE market='chinese' AND demo=0").get().n;
 db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('cn-production-import:'+sha+':run:'+crypto.randomUUID(),JSON.stringify({...summary,at:new Date().toISOString()}));
 db.exec('COMMIT');transaction=false;console.log(JSON.stringify({...summary,integrity:'ok',protectedDataUnchanged:true}));
}finally{if(transaction)db.exec('ROLLBACK');db.close();}
