// Real index-date monitoring in a consistent copy of the marked acceptance DB.
import fs from 'node:fs';import path from 'node:path';
const directory=process.argv[2],copy=process.argv[3],report=process.argv[4];
if(!directory||!copy||!report||![directory,copy,report].every(path.isAbsolute)||process.env.DATABASE_PATH)throw Error('Provide absolute acceptance directory, new copy DB and report paths; unset DATABASE_PATH');
if(JSON.parse(fs.readFileSync(path.join(directory,'acceptance-marker.json'))).purpose!=='isolated public metadata acceptance; never production'||fs.existsSync(copy))throw Error('Require marked acceptance DB and a new, nonexistent copy');
const {DatabaseSync}=await import('node:sqlite');const source=new DatabaseSync(path.join(directory,'acceptance.sqlite'));source.prepare('VACUUM INTO ?').run(copy);source.close();
process.env.DATABASE_PATH=copy;process.env.SCAN_ON_START='false';process.env.DEEPSEEK_API_KEY='';process.env.RESEND_API_KEY='';
const {db}=await import('../api/src/db.mjs');const {scanAll}=await import('../api/src/monitor.mjs');
const fetchOriginal=globalThis.fetch,urls=[];
globalThis.fetch=async(url,...args)=>{if(new URL(url).hostname!=='api.crossref.org')throw Error('Acceptance refuses non-Crossref requests');urls.push(String(url));return fetchOriginal(url,...args)};
const evidence=[];
for(const j of db.prepare("SELECT * FROM journals WHERE enabled=1 AND source='crossref' ORDER BY id").all()){
 const before=db.prepare('SELECT COUNT(*) n FROM articles WHERE journal_id=?').get(j.id).n,results=[],start=urls.length;
 for(let attempt=0;attempt<10;attempt++){const r=await scanAll({journalId:j.id});results.push(r);if(r.status==='ok')break;}
 const state=db.prepare('SELECT * FROM scan_windows WHERE journal_id=?').get(j.id),requests=urls.slice(start);
 if(state?.mode!=='incremental'||state.status!=='complete'||!requests.length||requests.some(u=>!new URL(u).searchParams.get('filter').includes('from-index-date:')))throw Error('Incremental proof incomplete: '+j.id);
 evidence.push({id:j.id,at:new Date().toISOString(),before,after:db.prepare('SELECT COUNT(*) n FROM articles WHERE journal_id=?').get(j.id).n,results,state,requests});console.log(j.id,state.status);
}
fs.writeFileSync(report,JSON.stringify({scope:'separate isolated copy; historical export unchanged',journals:evidence,years:db.prepare('SELECT published_year,COUNT(*) n FROM articles GROUP BY published_year ORDER BY published_year').all(),aiUsage:db.prepare('SELECT COUNT(*) n FROM analysis_usage_log').get().n,deliveries:db.prepare('SELECT COUNT(*) n FROM deliveries').get().n},null,2)+'\n');db.close();
