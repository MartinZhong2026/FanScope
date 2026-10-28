// Local, read-only export. Data belongs in ignored work/, never in Git or Pages.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
const source=path.resolve(process.argv[2]||'work/chinese-bulk/fanscope-chinese.sqlite');
const folder=path.resolve(process.argv[3]||'work/v14/chinese-migration');
if(fs.existsSync(folder))throw Error('New output directory required');
const db=new DatabaseSync(source,{readOnly:true});
try{
 const records=db.prepare("SELECT * FROM articles WHERE market='chinese' AND demo=0 ORDER BY journal_id,id").all();
 if(records.length!==349)throw Error('Expected audited corpus of 349; review actual source before packaging');
 const journals=db.prepare("SELECT id,title,issn,market FROM journals WHERE id IN (SELECT DISTINCT journal_id FROM articles WHERE market='chinese' AND demo=0) ORDER BY id").all();
 const payload={schemaVersion:1,createdAt:new Date().toISOString(),authorization:{kind:'user_confirmation',recordedOn:'2026-10-28',statement:'User explicitly confirms authorization to store, analyze and display these 349 records in FanScope.'},journals,records:records.map(a=>({...a,issns:JSON.parse(a.issns_json||'[]'),source_evidence:JSON.parse(a.source_evidence_json||'{}')}))};
 fs.mkdirSync(folder,{recursive:true,mode:0o700});const file=path.join(folder,'chinese-data.json');fs.writeFileSync(file,JSON.stringify(payload),{mode:0o600,flag:'wx'});
 const sha=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 fs.writeFileSync(path.join(folder,'SHA256SUMS'),sha+'  chinese-data.json\n',{mode:0o600,flag:'wx'});
 const counts=Object.fromEntries(journals.map(j=>[j.id,records.filter(a=>a.journal_id===j.id).length]));
 const report={records:records.length,counts,missingAuthors:records.filter(a=>!a.authors).length,missingAbstracts:records.filter(a=>!a.abstract).length,datePrecision:Object.fromEntries([...new Set(records.map(a=>a.date_precision))].map(k=>[k,records.filter(a=>a.date_precision===k).length])),sha256:sha,file};
 fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify(report));
}finally{db.close()}
