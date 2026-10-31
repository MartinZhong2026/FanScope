// Run the Chinese source adapters by hand against DATABASE_PATH.
//   node --experimental-sqlite src/official-cn-cli.mjs collect [--issn 1000-6087] [--max-requests 800]
//   node --experimental-sqlite src/official-cn-cli.mjs report
// Same code path as the ingest:chinese scheduler job. Safe to repeat.
import {parseArgs} from 'node:util';
import {db} from './db.mjs';
import {chineseTransport} from './chinese-transport.mjs';
import {collectJournal} from './ingest/official-cn.mjs';
import {CHINESE_STATUS} from './ingest/jobs.mjs';

const {values,positionals}=parseArgs({allowPositionals:true,options:{issn:{type:'string'},'max-requests':{type:'string'},'local-fetch':{type:'boolean',default:false}}});
// Development machines behind a fake-IP proxy fail the SSRF address check. Never in production.
if(values['local-fetch']&&process.env.NODE_ENV==='production')throw Error('--local-fetch is for development only');
const localRead=async(url,hosts)=>{if(!hosts.includes(new URL(url).hostname))throw Error('Unapproved host');const r=await fetch(url,{headers:{'User-Agent':'FanScope-Metadata/1.3 (bounded public metadata retrieval)'},redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('HTTP '+r.status);return r.text()};
const entries=CHINESE_STATUS.journals.filter(j=>j.adapter&&(!values.issn||j.issn===values.issn));
if(positionals[0]==='collect'){
 for(const entry of entries){
  const transport=chineseTransport({maxRequests:Number(values['max-requests']||800),minIntervalMs:1500,...(values['local-fetch']?{readFeed:localRead}:{})});
  try{console.log(JSON.stringify({journal:entry.title,...await collectJournal(entry,{read:transport.read,json:transport.json}),requests:transport.requests}))}
  catch(e){console.log(JSON.stringify({journal:entry.title,stopped:String(e.message).slice(0,200),requests:transport.requests}))}
 }
}
const rows=db.prepare(`SELECT j.title,COUNT(*) total,SUM(length(trim(a.abstract))>=55) abstracts,MIN(COALESCE(NULLIF(a.publication_date,''),a.publication_date_partial)) first,MAX(COALESCE(NULLIF(a.publication_date,''),a.publication_date_partial)) last,
 SUM(json_extract(a.source_evidence_json,'$.abstract_gap') IS NOT NULL) confirmedNoAbstract FROM articles a JOIN journals j ON j.id=a.journal_id WHERE a.market='chinese' AND a.demo=0 GROUP BY j.id ORDER BY total DESC`).all();
console.log(JSON.stringify({total:rows.reduce((n,r)=>n+r.total,0),abstracts:rows.reduce((n,r)=>n+r.abstracts,0),rows},null,1));
db.close();
