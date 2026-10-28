// Opt-in supplement: operator must confirm current API plan/terms before enabling.
import {config} from './config.mjs';
import {db,now} from './db.mjs';
import {canonicalDoi,safeArticleUrl} from './sources.mjs';
import {publicationOrder} from './research.mjs';
import {currentResearchYear} from './publication-policy.mjs';
db.exec('CREATE TABLE IF NOT EXISTS provider_cache(cache_key TEXT PRIMARY KEY,value_json TEXT NOT NULL,expires_at TEXT NOT NULL)');
let busy=false;
export async function enrichOpenAlex(limit=2){
 if(!process.env.OPENALEX_API_KEY||process.env.OPENALEX_ENABLED!=='true')return {status:'disabled',reason:'API key, plan and terms approval required'};
 if(busy)return {status:'busy'};busy=true;
 try{
  const dayKey='openalex-budget:'+now().slice(0,10),spent=Number(db.prepare('SELECT value FROM meta WHERE key=?').get(dayKey)?.value||0),budget=Math.max(0,Math.min(limit,5,Number(process.env.OPENALEX_MAX_DAILY||10)-spent));
  const rows=db.prepare(`SELECT a.*,j.issn FROM articles a JOIN journals j ON j.id=a.journal_id WHERE a.doi!='' AND ${publicationOrder}>=? AND ${publicationOrder}<=? AND (a.abstract='' OR a.publisher_landing_url='') ORDER BY a.relevance_score DESC,${publicationOrder} DESC LIMIT ?`).all(currentResearchYear()+'-01-01',now().slice(0,10),budget);
  let enriched=0,failed=0,requests=spent;
  for(const a of rows){try{
   const key='openalex:'+canonicalDoi(a.doi),cached=db.prepare('SELECT value_json FROM provider_cache WHERE cache_key=? AND expires_at>?').get(key,now());let x;
   if(cached)x=JSON.parse(cached.value_json);else{
    const p=new URLSearchParams({api_key:process.env.OPENALEX_API_KEY});requests++;db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(dayKey,String(requests));
    const response=await fetch(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(canonicalDoi(a.doi))}?${p}`,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error(`OpenAlex HTTP ${response.status}`);x=await response.json();
    db.prepare('INSERT INTO provider_cache VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET value_json=excluded.value_json,expires_at=excluded.expires_at').run(key,JSON.stringify(x),new Date(Date.now()+7*86400000).toISOString());await new Promise(r=>setTimeout(r,1000));
   }
   const location=x.primary_location,issns=location?.source?.issn||[];
   if(canonicalDoi(x.doi)!==canonicalDoi(a.doi)||!a.issn||!issns.includes(a.issn))throw Error('OpenAlex DOI / ISSN identity mismatch');
   const landing=safeArticleUrl(location?.landing_page_url);const sourceUrl=safeArticleUrl(location?.source?.homepage_url);
   const index=x.abstract_inverted_index;let abstract='';if(index&&typeof index==='object'){const words=[];for(const [word,positions] of Object.entries(index))for(const pos of positions)if(Number.isInteger(pos)&&pos>=0&&pos<3000)words[pos]=word;abstract=words.join(' ').slice(0,12000);}
   db.prepare("UPDATE articles SET abstract=CASE WHEN abstract='' THEN ? ELSE abstract END,publisher_landing_url=CASE WHEN publisher_landing_url='' THEN ? ELSE publisher_landing_url END,link_provenance=CASE WHEN publisher_landing_url='' AND ?!='' THEN 'openalex_metadata' ELSE link_provenance END,analysis_status=CASE WHEN analysis_status='insufficient_abstract' AND length(?)>=55 THEN 'pending' ELSE analysis_status END WHERE id=?").run(abstract,landing&&landing!==sourceUrl&&new URL(landing).pathname!=='/'?landing:'',landing,abstract,a.id);enriched++;
  }catch{failed++;}}
  return {enriched,failed,dailyRequests:requests};
 }finally{busy=false}
}
