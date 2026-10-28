// Independent, read-only acceptance from final database records, not job claims.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const file=path.resolve(root,process.argv[2]||'work/chinese-bulk/fanscope-chinese.sqlite');
if(!file.startsWith(path.join(root,'work')+path.sep)||!file.endsWith('.sqlite'))throw Error('Only an isolated work/ database is accepted');
const out=path.join(root,'docs/chinese-bulk-backfill');fs.mkdirSync(out,{recursive:true});
const inventory=JSON.parse(fs.readFileSync(path.join(root,'api/config/chinese-journal-inventory.json')));
const identity=JSON.parse(fs.readFileSync(path.join(root,'api/config/chinese-identity-evidence.json')));
const probe=JSON.parse(fs.readFileSync(path.join(root,'work/chinese-bulk/3year/probe.json')));
const db=new DatabaseSync(file,{readOnly:true});
try{
 const rows=db.prepare("SELECT a.*,j.title journal_title FROM articles a JOIN journals j ON j.id=a.journal_id WHERE a.market='chinese' AND j.market='chinese' AND a.demo=0 ORDER BY journal_id,publication_date_partial,publication_date,id").all();
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const start=days=>new Date(Date.parse(today+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);
 const date=a=>a.publication_date_partial||a.publication_date||'';
 const inWindow=(a,days)=>{const d=date(a);if(!d)return false;return d>=start(days).slice(0,d.length)&&d<=today.slice(0,d.length);};
 const rate=(n,total)=>total?Number((n*100/total).toFixed(2)):null;
 const summarize=data=>{const total=data.length,doi=data.filter(a=>a.doi).length,authors=data.filter(a=>a.authors.trim()).length,abstract=data.filter(a=>a.abstract.trim().length>=55).length,day=data.filter(a=>a.date_precision==='day').length,month=data.filter(a=>a.date_precision==='month').length,known=data.filter(a=>date(a)).length;return {total,earliest:data.map(date).filter(Boolean).sort()[0]||null,latest:data.map(date).filter(Boolean).sort().at(-1)||null,doi,doiPercent:rate(doi,total),authors,authorsPercent:rate(authors,total),abstracts:abstract,abstractPercent:rate(abstract,total),knownDates:known,datePercent:rate(known,total),day,month,dayPercent:rate(day,total),verified:data.filter(a=>a.source_verification_status==='verified').length,analyzed:data.filter(a=>a.analysis_status==='analyzed').length,aiResults:data.filter(a=>a.analysis_json!==null).length,windows:Object.fromEntries([30,90,180,365,1096].map(days=>[days,{total:data.filter(a=>inWindow(a,days)).length,exactDay:data.filter(a=>a.date_precision==='day'&&inWindow(a,days)).length,coarse:data.filter(a=>a.date_precision!=='day'&&inWindow(a,days)).length}]))};};
 const jobs=db.prepare("SELECT value FROM meta WHERE key LIKE 'cn-job:%'").all().map(x=>JSON.parse(x.value));
 const items=inventory.map(j=>{const p=probe.items.find(p=>p.id===j.id),e=identity.items.find(e=>e.id===j.id)||{},r=rows.filter(a=>a.journal_id===j.id);return {...j,...e,probe:p,...summarize(r),jobs:jobs.filter(b=>b.journalId===j.id).map(({id,days,status,discovered,valid,added,updated,duplicates,rejected,outOfRange,pages,failures,error})=>({id,days,status,discovered,valid,added,updated,duplicates,rejected,outOfRange,pages,failures,error}))};});
 const invalidOwnership=db.prepare('SELECT COUNT(*) n FROM articles a JOIN journals j ON j.id=a.journal_id WHERE a.market<>j.market').get().n;
 const duplicateIdentities=db.prepare("SELECT COUNT(*) n FROM (SELECT journal_id,chinese_identity_key,COUNT(*) n FROM articles WHERE market='chinese' AND chinese_identity_key<>'' GROUP BY journal_id,chinese_identity_key HAVING COUNT(*)>1)").get().n;
 const excluded=db.prepare("SELECT value FROM meta WHERE key LIKE 'cn-excluded:%'").all().map(x=>JSON.parse(x.value));
 const report={generatedAt:new Date().toISOString(),database:path.relative(root,file).replaceAll('\\','/'),databaseSha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),targetCount:items.length,originalTargetCount:20,priorityCount:4,connected:items.filter(j=>j.total>0&&j.probe.ready).length,priorityConnected:items.filter(j=>j.priority&&j.total>0).length,totals:summarize(rows),checks:{integrity:db.prepare('PRAGMA integrity_check').get().integrity_check,foreignKeyViolations:db.prepare('PRAGMA foreign_key_check').all().length,invalidOwnership,duplicateIdentities,internationalRecords:db.prepare("SELECT COUNT(*) n FROM articles WHERE market='international'").get().n,nonPaperEntriesQuarantined:excluded.length},exclusions:excluded.map(x=>({id:x.record.id,title:x.record.title,url:x.record.url,reason:x.reason})),items};
 fs.writeFileSync(path.join(out,'acceptance.json'),JSON.stringify(report,null,2)+'\n');
 const columns=['id','title','issn','cn','publisher','identityEvidence','total','earliest','latest','doiPercent','abstractPercent','authorsPercent','datePercent','day','month','source','blockers','cssci'];
 const quote=x=>'"'+String(x??'').replaceAll('"','""')+'"';
 const csv=[columns.join(','),...items.map(j=>[j.id,j.title,j.issn,j.cn||'未核验',j.publisher||'未核验',(j.identityEvidence||[]).join?.(' | ')||j.identityEvidence,j.total,j.earliest,j.latest,j.doiPercent,j.abstractPercent,j.authorsPercent,j.datePercent,j.day,j.month,j.probe?.catalog?.url||(j.probe?.crossref?.count?'https://api.crossref.org/journals/'+j.issn+'/works':''),(j.probe?.blockers||[]).join(' | ')||j.probe?.catalog?.error||'',j.cssciPublisherClaim?'刊方有2025-2026入选声明；南京大学年度原文待核':'南京大学2025-2026年度原文待核'].map(quote).join(','))].join('\n')+'\n';
 fs.writeFileSync(path.join(out,'source-quality.csv'),'\uFEFF'+csv);
 fs.writeFileSync(path.join(out,'source-probe.json'),JSON.stringify(probe,null,2)+'\n');
 console.log(JSON.stringify({target:report.targetCount,connected:report.connected,totals:report.totals,checks:report.checks}));
}finally{db.close();}
