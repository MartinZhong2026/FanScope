// Europe PMC's public metadata API supplies publication types and abstracts.
// No full text, API key, AI, arbitrary URLs or publisher HTML scraping.
import crypto from 'node:crypto';
import {db,now} from './db.mjs';
import {canonicalDoi,doiUrl,fetchJson,classify} from './sources.mjs';
import {classifyArticleType,relevanceScore,currentResearchYear,publicationToday} from './publication-policy.mjs';
import {publicationOrder} from './research.mjs';
db.exec(`CREATE TABLE IF NOT EXISTS article_metadata_checks (
 article_id TEXT PRIMARY KEY,checked_at TEXT NOT NULL,status TEXT NOT NULL,
 response_json TEXT,error TEXT NOT NULL DEFAULT '',
 FOREIGN KEY(article_id) REFERENCES articles(id)
);`);
const strip=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
export async function supplementArticle(id,{request=fetchJson,force=false,sourceQueryURL}={}){
 const a=db.prepare('SELECT a.*,j.issn FROM articles a JOIN journals j ON j.id=a.journal_id WHERE a.id=?').get(id);
 if(!a||!doiUrl(a.doi))return {id,status:'unsupported',reason:'A valid DOI is required'};
 const old=db.prepare('SELECT * FROM article_metadata_checks WHERE article_id=?').get(id);
 const age=old?Date.now()-Date.parse(old.checked_at):Infinity;
 if(!force&&old&&age<(old.status==='verified'?7:old.status==='not_found'?1:1/24)*86400000)return {id,status:'cached',previousStatus:old.status};
 const url='https://www.ebi.ac.uk/europepmc/webservices/rest/search?'+new URLSearchParams({query:`DOI:"${canonicalDoi(a.doi)}"`,format:'json',resultType:'core',pageSize:'5'});
 const save=(status,data,error='')=>db.prepare('INSERT INTO article_metadata_checks VALUES(?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status,response_json=excluded.response_json,error=excluded.error').run(id,now(),status,JSON.stringify(data),error);
 try{
  const body=await request(url);if(!Array.isArray(body?.resultList?.result))throw Error('Malformed Europe PMC response');
  const rows=body.resultList.result.filter(x=>canonicalDoi(x.doi)===canonicalDoi(a.doi));
  const codes=new Set([a.issn,...JSON.parse(a.issns_json||'[]')].filter(Boolean));
  const x=rows.find(x=>[x.journalInfo?.journal?.issn,x.journalInfo?.journal?.essn].some(v=>codes.has(v)));
  if(!x){const status=rows.length?'identity_mismatch':'not_found';save(status,{url,matchedDOI:!!rows.length},status==='identity_mismatch'?'DOI matched but journal ISSN did not':'');db.prepare('UPDATE articles SET abstract_checked_at=?,abstract_error=? WHERE id=?').run(now(),status,id);return {id,status};}
  const type=classifyArticleType(x.pubTypeList?.pubType||[],'Europe PMC',x.title||a.title),abstract=strip(x.abstractText);
  const evidence={provider:'Europe PMC',url:sourceQueryURL||url,request_query:body.request?.queryString||null,fetched_at:now(),doi:x.doi,provider_id:x.id,issns:[x.journalInfo.journal.issn,x.journalInfo.journal.essn].filter(Boolean),journal_title:x.journalInfo.journal.title,raw_types:x.pubTypeList?.pubType||[],type_evidence:type.evidence,abstract_provided:!!abstract,abstract_sha256:abstract?crypto.createHash('sha256').update(abstract).digest('hex'):null};
  const supplied=abstract.length>=55&&(a.abstract||'').trim().length<55;
  const finalAbstract=supplied?abstract:a.abstract||'';
  // Preserve a previously explicit, contradictory type rather than silently
  // changing it into original research. Persist both sources for review.
  let finalType=type.article_type;
  if(finalType==='unknown'&&a.article_type!=='unknown')finalType=a.article_type;
  else if(a.article_type!=='unknown'&&finalType!==a.article_type){finalType='unknown';evidence.conflict=JSON.parse(a.article_type_evidence_json||'{}');}
  db.prepare(`UPDATE articles SET abstract=?,abstract_status=?,abstract_source=CASE WHEN ? THEN 'Europe PMC' ELSE abstract_source END,abstract_checked_at=?,abstract_error='',article_type=?,article_type_evidence_json=?,metadata_supplement_json=?,relevance_score=?,topics=?,matched=?,analysis_status=CASE WHEN analysis_status='insufficient_abstract' AND ? THEN 'pending' ELSE analysis_status END WHERE id=?`).run(finalAbstract,finalAbstract.trim().length>=55?'available':'missing',supplied?1:0,now(),finalType,JSON.stringify(evidence),JSON.stringify(evidence),relevanceScore(a.title,finalAbstract),JSON.stringify(classify(a.title,finalAbstract)),classify(a.title,finalAbstract).length?1:0,supplied?1:0,id);
  save('verified',evidence);return {id,status:'verified',article_type:finalType,abstractAdded:supplied,hasAbstract:finalAbstract.trim().length>=55,evidence};
 }catch(e){save('failed',{url},String(e.message).slice(0,400));db.prepare('UPDATE articles SET abstract_checked_at=?,abstract_error=? WHERE id=?').run(now(),String(e.message).slice(0,400),id);return {id,status:'failed',error:String(e.message)};}
}
export function metadataCandidates({limit=20,year=currentResearchYear(),highRelevance=false}={}){
 if(!Number.isInteger(Number(limit))||limit<1||limit>200||!Number.isInteger(Number(year))||year<2026||year>currentResearchYear())throw Object.assign(Error('Metadata limit must be 1–200 and year must be 2026–current year'),{status:400});
 return db.prepare(`SELECT a.id,a.doi,a.title,a.abstract_status,a.article_type,a.relevance_score FROM articles a LEFT JOIN article_metadata_checks c ON c.article_id=a.id WHERE a.demo=0 AND a.doi<>'' AND substr(${publicationOrder},1,4)=? AND ${publicationOrder}<=? AND (a.article_type='unknown' OR length(trim(coalesce(a.abstract,'')))<55) AND (c.checked_at IS NULL OR julianday(c.checked_at)<julianday('now',CASE WHEN c.status='verified' THEN '-7 days' WHEN c.status='not_found' THEN '-1 day' ELSE '-1 hour' END)) AND a.relevance_score>=? ORDER BY CASE WHEN length(trim(coalesce(a.abstract,'')))<55 THEN 0 ELSE 1 END,a.relevance_score DESC,${publicationOrder} DESC,a.id LIMIT ?`).all(String(year),publicationToday(),highRelevance?3:0,Number(limit));
}
export async function enrichMetadata({limit=20,year=currentResearchYear(),highRelevance=false,request}={}){
 const candidates=metadataCandidates({limit,year,highRelevance}),items=[];
 for(let i=0;i<candidates.length;i+=20){
  const group=candidates.slice(i,i+20);
  const sourceQueryURL='https://www.ebi.ac.uk/europepmc/webservices/rest/search?'+new URLSearchParams({query:group.map(a=>`DOI:"${canonicalDoi(a.doi)}"`).join(' OR '),format:'json',resultType:'core',pageSize:'100'});
  let body;try{body=await (request||fetchJson)(sourceQueryURL)}catch(error){for(const a of group)items.push(await supplementArticle(a.id,{request:async()=>{throw error},sourceQueryURL}));continue;}
  for(const a of group)items.push(await supplementArticle(a.id,{request:async()=>body,sourceQueryURL}));
  await new Promise(r=>setTimeout(r,500));
 }
 return {year,examined:items.length,abstractsAdded:items.filter(x=>x.abstractAdded).length,items,paidAIRequests:0};
}
