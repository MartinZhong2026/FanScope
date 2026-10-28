// Reconcile the isolated acceptance export against already preserved metadata.
// Refuses application databases and never changes AI/cache fields.
import fs from 'node:fs';import path from 'node:path';
const output=process.argv[2];
if(!output||!path.isAbsolute(output)||process.env.DATABASE_PATH)throw Error('Provide an absolute marked acceptance directory with DATABASE_PATH unset');
const marker=JSON.parse(fs.readFileSync(path.join(output,'acceptance-marker.json')));
if(marker.purpose!=='isolated public metadata acceptance; never production')throw Error('Not an acceptance database');
process.env.DATABASE_PATH=path.join(output,'acceptance.sqlite');
const {db}=await import('../api/src/db.mjs');const {crossrefToArticle}=await import('../api/src/sources.mjs');
const corrections=[];
for(const row of db.prepare('SELECT * FROM articles WHERE source_evidence_json IS NOT NULL').all()){
 const e=JSON.parse(row.source_evidence_json),j=db.prepare('SELECT * FROM journals WHERE id=?').get(row.journal_id);
 const a=crossrefToArticle({DOI:row.doi,title:[row.title],ISSN:e.ISSN,'container-title':e.journal_titles,published:e.published,'published-online':e.published_online,'published-print':e.published_print,issued:e.issued},j);
 if(!a||row.publication_date===a.publication_date&&row.publication_date_partial===a.publication_date_partial)continue;
 corrections.push({id:row.id,before:row.publication_date||row.publication_date_partial,after:a.publication_date||a.publication_date_partial,precision:a.date_precision,reason:'earlier source publication with lower precision; later print date is not first publication'});
 const missing=JSON.parse(row.missing_fields_json||'{}');if(a.publication_date_partial)missing.publication_date='source supplies an earlier year/month; exact first publication day unknown';
 db.prepare('UPDATE articles SET publication_date=?,publication_date_partial=?,published_year=?,date_precision=?,missing_fields_json=?,notification_eligible=0 WHERE id=?').run(a.publication_date,a.publication_date_partial,Number((a.publication_date||a.publication_date_partial).slice(0,4)),a.date_precision,JSON.stringify(missing),row.id);
}
const fd=fs.openSync(path.join(output,'articles.jsonl'),'w');
for(const row of db.prepare('SELECT a.*,j.title AS journal_title FROM articles a JOIN journals j ON j.id=a.journal_id ORDER BY a.journal_id,a.publication_date,a.id').iterate())fs.writeSync(fd,JSON.stringify(row)+'\n');fs.closeSync(fd);
const results=JSON.parse(fs.readFileSync(path.join(output,'results.json')));
for(const r of results)if(r.counts)r.counts=db.prepare("SELECT COUNT(*) count,MIN(NULLIF(publication_date,'')) first,MAX(NULLIF(publication_date,'')) last,SUM(date_precision='month') monthPrecision,SUM(date_precision='year') yearPrecision,SUM(notification_eligible) notificationEligible FROM articles WHERE journal_id=?").get(r.journalId);
fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2)+'\n');
fs.writeFileSync(path.join(output,'date-reconciliation.json'),JSON.stringify(corrections,null,2)+'\n');db.close();console.log('Date corrections from original evidence:',corrections.length);
