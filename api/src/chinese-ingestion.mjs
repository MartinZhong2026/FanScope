import {chineseCatalogLinks} from './chinese-catalog.mjs';
export {chineseCatalogLinks} from './chinese-catalog.mjs';
// Operator-started metadata ingestion. Never calls AI or accesses full text.
import crypto from 'node:crypto';
import {db,now} from './db.mjs';
import {secureFeed,approvedURL} from './rss-security.mjs';
import {feedHosts,parseFeed,canonicalJournalTitle,journalTitleMatches,validIssn,canonicalDoi,crossrefToArticle,classify} from './sources.mjs';
import {insertArticle} from './monitor.mjs';
import {publicationToday} from './publication-policy.mjs';
import {researchReport} from './research.mjs';
import {chineseTransport} from './chinese-transport.mjs';
const runtimeTransport=chineseTransport({maxRequests:1000});
const fail=(s)=>Object.assign(Error(s),{status:400});
const get=k=>{const s=db.prepare('SELECT value FROM meta WHERE key=?').get(k);return s?JSON.parse(s.value):null};
const put=(k,v)=>db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,JSON.stringify(v));
const journal=id=>{const j=db.prepare("SELECT * FROM journals WHERE id=? AND market='chinese'").get(String(id||''));if(!j)throw fail('中文期刊不存在');return j};
const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
export const startDay=(days=180)=>{if(!Number.isInteger(days)||days<1||days>1096)throw fail('回填天数必须为1至1096');return new Date(Date.parse(publicationToday()+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);};
const validDate=d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d&&d<=publicationToday();
const decode=s=>String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/<[^>]*>/g,'').trim();
export function citationArticle(html,j,url){
 const m={};for(const tag of html.matchAll(/<meta\b[^>]*>/gi)){const attrs={};for(const a of tag[0].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g))attrs[a[1].toLowerCase()]=decode(a[2]);const name=attrs.name?.toLowerCase();if(name)(m[name]??=[]).push(attrs.content||'');}
 if(!m.citation_title)return null;
 if(!m.citation_journal_title?.some(t=>journalTitleMatches(t,j))||!m.citation_issn?.includes(j.issn))throw fail('官网文章刊名 / ISSN 不匹配');
 const date=(m.citation_publication_date?.[0]||m.citation_date?.[0]||'').replaceAll('/','-');
 const title=m.citation_title[0],doi=canonicalDoi(m.citation_doi?.[0]||''),abstract=m.description?.[0]||'',topics=classify(title,abstract);
 return {id:'cn:'+crypto.createHash('sha256').update(j.id+url).digest('hex'),journal_id:j.id,market:'chinese',title,doi,url,publisher_landing_url:url,link_provenance:'official_citation_metadata',abstract,authors:(m.citation_author||[m.citation_authors?.[0]].filter(Boolean)).join(', '),publication_date:date,published_online_date:m.citation_online_date?.[0]||'',volume:m.citation_volume?.[0]||'',issue:m.citation_issue?.[0]||'',source:'official_catalog',issns:[j.issn],source_evidence:{url,journal_title:j.title,issn:j.issn,publication_date:date,html_sha256:crypto.createHash('sha256').update(html).digest('hex')},source_verification_status:'verified',topics,matched:!!topics.length};
}
// Exact normalized composite; similar titles never trigger an automatic merge.
export const chineseIdentity=a=>crypto.createHash('sha256').update(JSON.stringify([normalize(a.title),normalize(a.authors||''),String(a.volume||'').trim(),String(a.issue||'').trim(),a.publication_date_partial||a.publication_date||''])).digest('hex');
export const chineseNonPaper=a=>/^(?:《[^》]+》)?\s*\d{4}年总目录$|^(?:《[^》]+》)?\s*\d{4}\s*年第?\s*\d+\s*期整期全文$|^(?:英文目录|目录|征稿启事|编辑部公告|table of contents)$/i.test(String(a.title||'').trim());
const partialValid=d=>/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(d)&&d<=publicationToday().slice(0,d.length);
export function validateChineseItem(j,a){
 if(chineseNonPaper(a))return '非论文目录或公告记录，不纳入论文库';
 if(a.market&&a.market!=='chinese'||a.journal_id&&a.journal_id!==j.id||canonicalJournalTitle(a.journal_title||j.title)!==canonicalJournalTitle(j.title)||a.issn&&a.issn!==j.issn||a.issns&&!a.issns.includes(j.issn))return '期刊身份不匹配';
 if(!String(a.title||'').trim()||!(a.publication_date_partial?partialValid(a.publication_date_partial):validDate(a.publication_date||'')))return '题名或发表日期缺失、不合法或晚于今日';
 try{const u=new URL(a.url);if(u.protocol!=='https:'||u.username||u.password)throw Error();}catch{return '文章链接无效';}
 const doi=canonicalDoi(a.doi||'');if(doi&&!/^10\.\d{4,9}\/\S+$/.test(doi))return 'DOI无效';
 return null;
}
export function importChinese({journalId,items,authorized=false,evidenceUrl,synthetic=false}={},onCommit=()=>{},{withinTransaction=false,authorizationEvidence=null}={}){
 const j=journal(journalId);if(!authorized||!(authorizationEvidence?.kind==='user_confirmation'&&authorizationEvidence.statement||evidenceUrl&&/^https:\/\//.test(evidenceUrl)))throw fail('需要确认合法导入授权及证据地址');
 if(!Array.isArray(items)||items.length>300)throw fail('每页最多300条');let added=0,duplicates=0,updated=0,valid=0;const rejected=[],review=[];
 db.exec(withinTransaction?'SAVEPOINT chinese_import_page':'BEGIN IMMEDIATE');try{for(const [index,a] of items.entries()){
  const reason=validateChineseItem(j,a);if(reason){rejected.push({index,reason});continue;}
  const doi=canonicalDoi(a.doi||'');
  const key=chineseIdentity(a);
  const byDoi=doi?db.prepare('SELECT * FROM articles WHERE doi=?').get(doi):null;
  if(byDoi&&byDoi.journal_id!==j.id){rejected.push({index,reason:'DOI已属于另一种期刊，须人工复核'});continue;}
  const existing=byDoi||db.prepare('SELECT * FROM articles WHERE journal_id=? AND (chinese_identity_key=? OR url=? OR publisher_landing_url=?) LIMIT 1').get(j.id,key,a.url,a.url);
  if(existing&&existing.market!=='chinese'){rejected.push({index,reason:'已有记录属于其他市场，禁止修改'});continue;}
  if(existing&&normalize(existing.title)!==normalize(a.title)){rejected.push({index,reason:'DOI或URL与已存题名冲突，须人工复核'});continue;}
  valid++;
  if(existing){
   duplicates++;let changed=false;
   for(const field of ['authors','abstract','doi','volume','issue','publisher_landing_url','published_online_date','published_print_date','source_updated_at']){const value=field==='source_updated_at'?a[field]||a.source_evidence?.source_updated_at:a[field];if(!existing[field]&&value){db.prepare(`UPDATE articles SET ${field}=? WHERE id=?`).run(value,existing.id);changed=true;}}
   if(changed){updated++;db.prepare("UPDATE articles SET metadata_fetched_at=?,abstract_status=CASE WHEN length(trim(abstract))>=55 THEN 'available' ELSE 'missing' END,analysis_status=CASE WHEN analysis_json IS NULL THEN CASE WHEN length(trim(abstract))>=55 THEN 'pending' ELSE 'insufficient_abstract' END ELSE analysis_status END WHERE id=?").run(now(),existing.id);}
   continue;
  }
  const similar=db.prepare('SELECT id,title,authors FROM articles WHERE journal_id=? AND title=? LIMIT 1').get(j.id,a.title);
  if(similar&&(!a.authors||!similar.authors)){review.push({index,existingId:similar.id,reason:'同题名但作者信息不足；暂缓导入，须人工核对'});valid--;continue;}
  const topics=classify(a.title,a.abstract||'');
  const row={...a,id:'cn:'+crypto.createHash('sha256').update(j.id+key).digest('hex'),journal_id:j.id,market:'chinese',doi,source:a.source||'manual',topics,matched:!!topics.length,source_evidence:{...a.source_evidence,...(authorizationEvidence?{migration_authorization:authorizationEvidence}:{authorization:evidenceUrl})},scan_mode:'backfill'};
  if(insertArticle(row,synthetic?1:0)){added++;db.prepare('UPDATE articles SET chinese_identity_key=?,source_updated_at=? WHERE id=?').run(key,a.source_updated_at||a.source_evidence?.source_updated_at||'',doi?'doi:'+doi:row.id);if((a.abstract||'').trim().length<55)db.prepare("UPDATE articles SET analysis_status='insufficient_abstract' WHERE id=?").run(doi?'doi:'+doi:row.id);}else duplicates++;
 }onCommit({added,duplicates,updated,valid,rejected,review});db.exec(withinTransaction?'RELEASE chinese_import_page':'COMMIT');}catch(e){db.exec(withinTransaction?'ROLLBACK TO chinese_import_page':'ROLLBACK');if(withinTransaction)db.exec('RELEASE chinese_import_page');throw e;}return {added,duplicates,updated,valid,rejected,review};
}
export function auditChineseRecords({apply=false}={}){
 const excluded=db.prepare("SELECT * FROM articles WHERE market='chinese' AND demo=0").all().filter(chineseNonPaper);
 if(apply){db.exec('BEGIN IMMEDIATE');try{for(const a of excluded){put('cn-excluded:'+a.id,{reason:'journal annual table of contents, not a paper',record:a,auditedAt:now()});db.prepare('DELETE FROM articles WHERE id=?').run(a.id);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 return {applied:apply,excluded:excluded.map(({id,title,journal_id,url})=>({id,title,journal_id,url}))};
}
export async function configureChinese(opts,{read=runtimeTransport.read,json=runtimeTransport.json}={}){
 const j=journal(opts.journalId);if(!opts.confirm||!validIssn(opts.issn)||canonicalJournalTitle(opts.title)!==canonicalJournalTitle(j.title))throw fail('需要确认刊名及有效ISSN');
 const source={journalId:j.id,title:j.title,issn:opts.issn,provider:opts.provider,url:opts.url||'',seedUrls:opts.seedUrls||[],permissionEvidence:opts.permissionEvidence||'',metadataOnly:opts.metadataOnly===true,verified:false,checkedAt:now()};
 if(!Array.isArray(source.seedUrls)||source.seedUrls.length>100)throw fail('目录种子过多');
 for(const u of source.seedUrls)approvedURL(u,feedHosts(j));
 const probe={...j,issn:opts.issn};let sample=[];
 try{
 if(source.provider==='crossref'){const data=await json(`https://api.crossref.org/journals/${opts.issn}/works?rows=5`);sample=(data.message?.items||[]).map(x=>crossrefToArticle(x,probe)).filter(x=>x?.source_verification_status==='verified');}
 else if(source.provider==='openalex'){
  if(process.env.OPENALEX_ENABLED!=='true'||!process.env.OPENALEX_API_KEY)throw fail('OpenAlex需要管理员确认使用条款及服务端API配置');
  const data=await json('https://api.openalex.org/sources/issn:'+encodeURIComponent(opts.issn)+'?api_key='+encodeURIComponent(process.env.OPENALEX_API_KEY));
  if(canonicalJournalTitle(data.display_name)!==canonicalJournalTitle(j.title)||!data.issn?.includes(opts.issn)||!/^https:\/\/openalex.org\/S\d+$/.test(data.id))throw fail('OpenAlex刊名 / ISSN不匹配');source.identifier=data.id;sample=[{title:data.display_name}];
 }else if(['rss','catalog'].includes(source.provider)){
  approvedURL(source.url,feedHosts(j));const html=await read(source.url,feedHosts(j));
  if(source.provider==='rss')sample=parseFeed(html,{...probe,rss_url:source.url},{verifyIdentity:true});
  else {const article=citationArticle(html,probe,source.url);if(article)sample=[article];else if(html.includes(j.title)){const match=html.match(/href=["']([^"']*\/CN\/Y\d{4}\/[^"']+)["']/i);if(match){const articleUrl=new URL(decode(match[1]),source.url).href;approvedURL(articleUrl,feedHosts(j));const record=citationArticle(await read(articleUrl,feedHosts(j)),probe,articleUrl);if(record)sample=[record];}}}
 }else throw fail('不支持的数据源');
 if(!sample.length)throw fail('未取得可核实的期刊元数据样本');source.verified=true;source.sample=sample.slice(0,2).map(a=>({title:a.title,url:a.url,doi:a.doi}));
 db.exec('BEGIN IMMEDIATE');try{put('cn-source:'+j.id,source);db.prepare('UPDATE journals SET issn=? WHERE id=?').run(opts.issn,j.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return source;
 }catch(e){put('cn-source-error:'+j.id,{at:now(),error:'来源验证失败；请核对身份、访问权限和服务配置'});throw fail('来源验证失败；请核对身份、访问权限和服务配置');}
}
export function createChineseJob({journalId,incremental=false,days=180,maxPages=1500}={}){
 if(!Number.isInteger(maxPages)||maxPages<1||maxPages>5000)throw fail('分页预算必须为1至5000');
 const j=journal(journalId),source=get('cn-source:'+j.id);if(!source?.verified)throw fail('请先核验中文数据源');
 const active=db.prepare("SELECT value FROM meta WHERE key LIKE 'cn-job:%'").all().map(x=>JSON.parse(x.value)).find(x=>x.journalId===j.id&&['paused','running'].includes(x.status));if(active)throw fail('已有未结束任务，请继续原任务');
 const previous=get('cn-last:'+j.id),start=incremental&&previous?[startDay(days),new Date(Date.parse(previous)-7*86400000).toISOString().slice(0,10)].sort().at(-1):startDay(days);
 const job={id:crypto.randomUUID(),journalId:j.id,source,start,end:publicationToday(),days,maxPages,status:'paused',cursor:'*',queue:[...new Set([source.url,...(source.seedUrls||[])].filter(Boolean))],visited:[],pages:0,discovered:0,valid:0,added:0,updated:0,duplicates:0,rejected:0,outOfRange:0,failures:0,review:[],error:'',updatedAt:now()};put('cn-job:'+job.id,job);return job;
}
export async function refreshChineseCatalogJob(id,{read=secureFeed}={}){
 const job=get('cn-job:'+id);if(!job||job.status!=='paused'||job.source.provider!=='catalog')return job;
 const j=journal(job.journalId),issues=[];
 for(const url of job.source.seedUrls||[]){approvedURL(url,feedHosts(j));issues.push(...chineseCatalogLinks(await read(url,feedHosts(j)),url,job.start,job.end));}
 job.queue=[...new Set([...job.queue.filter(u=>/\/CN\/Y\d{4}\//.test(u)),...issues])].filter(u=>!job.visited.includes(u));
 if(!job.queue.length){job.status='completed';put('cn-last:'+j.id,now());}put('cn-job:'+id,job);return job;
}
export function cancelChineseJob(id){if(busy)throw fail('中文同步执行中，请等待页面提交后取消');const job=get('cn-job:'+id);if(!job||job.status!=='paused')throw fail('任务不能取消');job.status='cancelled';put('cn-job:'+id,job);return job;}
let busy=false;
export async function stepChineseJob(id,{read=runtimeTransport.read,json=runtimeTransport.json}={}){
 const job=get('cn-job:'+id);if(!job||job.status!=='paused')throw fail('任务不存在或不能继续');if(busy)throw fail('已有中文同步正在执行');busy=true;
 if(job.nextRetryAt&&Date.parse(job.nextRetryAt)>Date.now()){busy=false;throw fail('来源仍处于服务端退避期，请在 '+job.nextRetryAt+' 后恢复');}
 if(job.pages>=(job.maxPages||1500)){busy=false;throw fail('分页预算已用完；增加明确预算后再恢复');}
 const j={...journal(job.journalId),issn:job.source.issn};
 try{let rows=[],next=null;
 if(['rss','catalog'].includes(job.source.provider)){
  const url=job.queue[0];if(!url){job.status='completed';put('cn-job:'+id,job);return job;}approvedURL(url,feedHosts(j));const html=await read(url,feedHosts(j));
  if(job.source.provider==='rss')rows=parseFeed(html,{...j,rss_url:url},{verifyIdentity:true});else{
   const a=citationArticle(html,j,url);if(a)rows=[a];else if(!html.includes(j.title))throw fail('目录刊名不匹配或返回登录页');
   for(const target of chineseCatalogLinks(html,url,job.start,job.end)){
    approvedURL(target,feedHosts(j));if(!job.visited.includes(target)&&!job.queue.includes(target)){if(job.queue.length>=5000)throw fail('目录队列预算已用完');job.queue.push(target);}
   }
  }job.queue.shift();job.visited.push(url);next=job.queue.length?'more':null;
 }else if(job.source.provider==='crossref'){
  const data=await json(`https://api.crossref.org/journals/${j.issn}/works?`+new URLSearchParams({filter:`from-pub-date:${job.start},until-pub-date:${job.end}`,rows:'100',cursor:job.cursor}));
  if(!Array.isArray(data.message?.items))throw fail('Crossref分页响应无效');rows=data.message.items.map(x=>crossrefToArticle(x,j)).filter(x=>x?.source_verification_status==='verified');job.identityRejected=(job.identityRejected||0)+data.message.items.length-rows.length;next=data.message.items.length?data.message['next-cursor']:null;
 }else{
  if(process.env.OPENALEX_ENABLED!=='true'||!process.env.OPENALEX_API_KEY)throw fail('OpenAlex未获使用授权');
  const data=await json('https://api.openalex.org/works?'+new URLSearchParams({filter:`primary_location.source.id:${job.source.identifier},from_publication_date:${job.start},to_publication_date:${job.end}`,cursor:job.cursor,'per-page':'100',api_key:process.env.OPENALEX_API_KEY}));
  if(!Array.isArray(data.results))throw fail('OpenAlex分页响应无效');next=data.meta?.next_cursor;
  rows=data.results.filter(x=>x.primary_location?.source?.issn?.includes(j.issn)&&canonicalJournalTitle(x.primary_location.source.display_name)===canonicalJournalTitle(j.title)).map(x=>({title:x.title,doi:canonicalDoi(x.doi),url:x.primary_location.landing_page_url,publication_date:x.publication_date,abstract:'',source:'openalex'}));
 }
 if(next&&['crossref','openalex'].includes(job.source.provider)&&next===job.cursor)throw fail('数据源分页游标未前进');
 if(job.source.metadataOnly)rows=rows.map(a=>({...a,abstract:'',source_evidence:{...a.source_evidence,abstract_policy:'not retained: bibliographic metadata scope only'}}));
 const selected=rows.filter(a=>{const d=a.publication_date_partial||a.publication_date||'';return d&&d>=job.start.slice(0,d.length)&&d<=job.end.slice(0,d.length)});
 importChinese({journalId:j.id,items:selected,authorized:true,evidenceUrl:job.source.url||'https://'+(job.source.provider==='crossref'?'api.crossref.org':'api.openalex.org')},result=>{
 job.pages++;job.discovered=(job.discovered||0)+rows.length;job.valid=(job.valid||0)+result.valid;job.added+=result.added;job.updated=(job.updated||0)+result.updated;job.duplicates+=result.duplicates;job.rejected+=result.rejected.length;job.outOfRange=(job.outOfRange||0)+rows.length-selected.length;job.review=[...(job.review||[]),...result.review].slice(0,100);
 job.cursor=next;job.status=next?'paused':'completed';job.error='';job.nextRetryAt=null;job.updatedAt=now();put('cn-job:'+id,job);if(!next)put('cn-last:'+j.id,now());
 });
 }catch(e){Object.assign(job,get('cn-job:'+id));job.failures=(job.failures||0)+1;job.nextRetryAt=e.retryAt||null;job.error=/不匹配/.test(e.message)?'身份不匹配，未推进检查点':/游标/.test(e.message)?'分页游标未前进，未推进检查点':/HTTP/.test(e.message)?'数据源HTTP失败，未推进检查点':'同步失败；检查数据源、访问权限或日期后继续，检查点保留';if(job.source.provider==='crossref'&&job.cursor!=='*'&&/HTTP (400|404|410)/.test(e.message)&&(job.cursorResets||0)<2){job.cursor='*';job.cursorResets=(job.cursorResets||0)+1;job.error='游标失效；固定时间窗保持，下一次从头重放并去重';}job.status='paused';}finally{job.updatedAt=now();put('cn-job:'+id,job);busy=false;}return job;
}
export function chineseDiagnostics(){
 const jobs=db.prepare("SELECT value FROM meta WHERE key LIKE 'cn-job:%'").all().map(x=>JSON.parse(x.value));
 const items=db.prepare("SELECT * FROM journals WHERE market='chinese' ORDER BY title").all().map(j=>{
 const counts=db.prepare("SELECT COUNT(*) total,SUM(length(trim(coalesce(abstract,'')))<55) missingAbstract,SUM(analysis_status='analyzed') analyzed FROM articles WHERE journal_id=? AND market='chinese' AND demo=0").get(j.id);
 const quality=db.prepare("SELECT SUM(doi<>'') doi,SUM(authors<>'') authors,SUM(length(trim(abstract))>=55) abstracts,SUM(date_precision='day') exactDates,MIN(COALESCE(NULLIF(publication_date_partial,''),NULLIF(publication_date,''))) earliest,MAX(COALESCE(NULLIF(publication_date_partial,''),NULLIF(publication_date,''))) latest,MAX(metadata_fetched_at) fetchedAt,SUM(source_verification_status='verified') verified FROM articles WHERE journal_id=? AND market='chinese' AND demo=0").get(j.id);
 const windows=Object.fromEntries([30,90,180].map(days=>[days,db.prepare("SELECT COUNT(*) n FROM articles WHERE journal_id=? AND market='chinese' AND demo=0 AND date_precision='day' AND publication_date>=? AND publication_date<=?").get(j.id,startDay(days),publicationToday()).n]));
 const legacyEvidence=['rss','crossref'].includes(j.source)?db.prepare('SELECT verified,checked_at FROM journal_source_evidence WHERE journal_id=? AND source=? AND identifier=? ORDER BY id DESC LIMIT 1').get(j.id,j.source,j.source==='rss'?j.rss_url:j.issn):null;
 const legacyConnection=legacyEvidence?.verified?{verified:true,provider:j.source,checkedAt:legacyEvidence.checked_at}:null;
 return {id:j.id,title:j.title,issn:j.issn,source:j.source,enabled:!!j.enabled,market:j.market,rank_system:j.rank_system,rank_year:j.rank_year,rank_evidence_url:j.rank_evidence_url,rank_verification_status:j.rank_verification_status,...counts,quality,windows,connection:legacyConnection||get('cn-source:'+j.id),probe:get('cn-probe:'+j.id),lastError:legacyConnection?null:get('cn-source-error:'+j.id),scan:db.prepare('SELECT * FROM scan_windows WHERE journal_id=?').get(j.id)||null,legacyBackfills:db.prepare('SELECT id,status,from_date,to_date,pages_done,error FROM journal_backfill_jobs WHERE journal_id=?').all(j.id),jobs:jobs.filter(x=>x.journalId===j.id),gap:counts.total?'已收录真实元数据；收录不等于期刊全量覆盖':'尚未收录；请先核验来源与使用范围，不自动启动回填'};
 });return {schemaVersion:1,market:'chinese',window:{start:startDay(),end:publicationToday()},items,summary:{targetJournals:items.length,journalsWithRecords:items.filter(j=>j.total>0).length,records:items.reduce((n,j)=>n+j.total,0)},report:researchReport({market:'chinese',period:'180d'}),coverageAudited:false};
}

export function createChineseBatch({journalIds,days=180,maxPages=1500,maxSteps=1000,incremental=false,blockedSources=[]}={}){
 startDay(days);
 if(!Array.isArray(journalIds)||!journalIds.length||journalIds.length>100||new Set(journalIds).size!==journalIds.length)throw fail('选择1至100本不同期刊');
 if(!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>10000)throw fail('批次分页预算必须为1至10000');
 if(!Array.isArray(blockedSources)||blockedSources.length>100)throw fail('无效来源阻碍清单');
 const blocked=new Map(blockedSources.map(x=>[String(x.journalId),String(x.error||'来源复核未通过').slice(0,300)]));
 const batch={id:crypto.randomUUID(),days,maxSteps,steps:0,status:'paused',jobs:[],blocked:[],createdAt:now(),updatedAt:now()};
 for(const journalId of journalIds)try{if(blocked.has(journalId))throw fail(blocked.get(journalId));batch.jobs.push(createChineseJob({journalId,days,maxPages,incremental}).id);}catch(e){batch.blocked.push({journalId,error:e.message});}
 put('cn-batch:'+batch.id,batch);return batch;
}
export function chineseBatch(id){const b=get('cn-batch:'+id);if(!b)throw fail('批次不存在');return {...b,items:b.jobs.map(id=>get('cn-job:'+id))};}
export function changeChineseBatch(id,action,{maxSteps}={}){const b=get('cn-batch:'+id);if(!b||!['pause','resume','cancel','retry'].includes(action))throw fail('批次操作无效');if(['completed','cancelled'].includes(b.status)||b.status==='partial'&&action!=='retry')throw fail('已结束批次不能恢复；失败任务使用retry');if(maxSteps!==undefined){if(!Number.isInteger(maxSteps)||maxSteps<=b.steps||maxSteps>10000)throw fail('需要大于已用步数的明确预算');b.maxSteps=maxSteps;}if(action==='retry')b.blocked=b.blocked.filter(x=>!x.jobId);b.status=['resume','retry'].includes(action)?'running':action==='pause'?'paused':'cancelled';b.updatedAt=now();put('cn-batch:'+id,b);return chineseBatch(id);}
export async function stepChineseBatch(id,transport={}){
 const b=get('cn-batch:'+id);if(!b||b.status!=='running')throw fail('批次未运行');
 if(b.steps>=b.maxSteps){b.status='paused';put('cn-batch:'+id,b);return chineseBatch(id);}
 const blocked=new Set(b.blocked.map(x=>x.jobId));const pending=b.jobs.map(id=>get('cn-job:'+id)).filter(j=>j.status==='paused'&&!blocked.has(j.id));
 if(pending.length){const j=pending[b.steps%pending.length];let outcome;try{outcome=await stepChineseJob(j.id,transport);if(outcome.error)b.blocked.push({journalId:j.journalId,jobId:j.id,error:outcome.error});}catch(e){b.blocked.push({journalId:j.journalId,jobId:j.id,error:e.message});}b.steps++;}
 if(!b.jobs.some(id=>{const j=get('cn-job:'+id);return j.status==='paused'&&!b.blocked.some(x=>x.jobId===id)}))b.status=b.blocked.length?'partial':'completed';
 // Honour a pause/cancel made while a network request was in flight.
 const current=get('cn-batch:'+id);if(current.status!=='running')b.status=current.status;
 b.updatedAt=now();put('cn-batch:'+id,b);return chineseBatch(id);
}
