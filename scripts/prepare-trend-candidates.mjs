// Offline corpus + bounded public metadata enrichment, in a NEW acceptance copy.
// Never starts a paid AI batch or opens the production application database.
import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
const [sourceDirectory,output]=process.argv.slice(2);
if(!sourceDirectory||!output||![sourceDirectory,output].every(path.isAbsolute)||process.env.DATABASE_PATH)throw Error('Require absolute marked acceptance source and new output paths; unset DATABASE_PATH');
if(JSON.parse(fs.readFileSync(path.join(sourceDirectory,'acceptance-marker.json'))).purpose!=='isolated public metadata acceptance; never production')throw Error('Not a marked acceptance database');
fs.mkdirSync(output,{recursive:true});const target=path.join(output,'trend-acceptance.sqlite');
if(fs.existsSync(target))throw Error('Use a new output directory; the existing corpus is never overwritten');
const source=new DatabaseSync(path.join(sourceDirectory,'acceptance.sqlite'));source.prepare('VACUUM INTO ?').run(target);source.close();
process.env.DATABASE_PATH=target;process.env.SCAN_ON_START='false';process.env.DEEPSEEK_API_KEY='';process.env.RESEND_API_KEY='';
const {currentResearchYear}=await import('../api/src/publication-policy.mjs');const year=currentResearchYear();
const {db}=await import('../api/src/db.mjs');const {enrichMetadata}=await import('../api/src/metadata-enrichment.mjs');
const {createBatch}=await import('../api/src/analysis-batches.mjs');const {researchReport}=await import('../api/src/research.mjs');
const checks=[];let qualified=0;
for(let round=0;round<5;round++){
 const result=await enrichMetadata({limit:100,year,highRelevance:true});checks.push(result);
 qualified=db.prepare("SELECT COUNT(*) n FROM articles WHERE demo=0 AND published_year=? AND article_type='original_research' AND relevance_score>=3 AND length(trim(abstract))>=55").get(year).n;
 console.log('Metadata round',round+1,'checked',result.examined,'abstracts added',result.abstractsAdded,'qualified originals',qualified);
 fs.writeFileSync(path.join(output,'enrichment.json'),JSON.stringify(checks,null,2)+'\n');
 if(qualified>=150||!result.examined)break;
}
const batch=createBatch({limit:150});
const candidates=db.prepare('SELECT a.id,a.journal_id,j.title AS journal_title,a.title,a.doi,a.publication_date,a.publication_date_partial,a.article_type,a.article_type_evidence_json,a.abstract_status,a.abstract_source,a.relevance_score,length(a.abstract) AS abstract_characters FROM analysis_batch_items i JOIN articles a ON i.article_id=a.id JOIN journals j ON a.journal_id=j.id WHERE i.batch_id=? ORDER BY COALESCE(NULLIF(a.publication_date_partial,\'\'),NULLIF(a.published_online_date,\'\'),a.publication_date) DESC').all(batch.id);
const report={scope:'isolated acceptance copy; 2025 retained; no production access',batch,candidateCount:candidates.length,shortfall:Math.max(0,100-candidates.length),quality:researchReport({period:'ytd'}),types:db.prepare("SELECT article_type,COUNT(*) n FROM articles WHERE published_year=? GROUP BY article_type").all(year),journals:db.prepare('SELECT COUNT(*) n FROM journals').get().n,retained2025:db.prepare('SELECT COUNT(*) n FROM articles WHERE published_year=2025').get().n,aiUsage:db.prepare('SELECT COUNT(*) n FROM analysis_usage_log').get().n,aiRunning:db.prepare("SELECT COUNT(*) n FROM analysis_batches WHERE status='running'").get().n};
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
fs.writeFileSync(path.join(output,'candidates.json'),JSON.stringify(candidates,null,2)+'\n');
console.log('Prepared',candidates.length,'paused candidates; paid AI requests',report.aiUsage);db.close();
