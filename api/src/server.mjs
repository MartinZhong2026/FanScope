import {chineseDiagnostics,configureChinese,createChineseJob,stepChineseJob,cancelChineseJob,createChineseBatch,chineseBatch,changeChineseBatch,stepChineseBatch} from './chinese-ingestion.mjs';
import {importCatalog,registerImportLicense,reviewImportLicense,inspectImportFile,stageImportFile,listImports,importBatch,reviewImportRows,stepImportBatch,importAudit} from './chinese-authorized-import.mjs';
import {cachedBrief,generateBrief} from './brief.mjs';
import {enrichOpenAlex} from './openalex.mjs';
import {researchWhere,publicationOrder,researchReport,articleJSON,comparableYearToDate} from './research.mjs';
import {analyzePending} from './ai.mjs';
import {automaticStatus,changeAutomatic} from './automatic-ai.mjs';
import {coverage,createBatch,batchDetail,listBatches,changeBatch,setBatchBudget,recoverBatches,workBatchTick} from './analysis-batches.mjs';
import {probeJournalSource,sourceSummary,discoverJournalSource,manageRSS} from './journal-onboarding.mjs';
import {queueJournalDiscoveries,getJournalDiscoveries,updateJournalDiscovery,startAllJournalDiscoveries,recoverJournalDiscoveries,discoveryTick} from './journal-discovery.mjs';
import {createBackfill,getBackfill,backfillSummary,changeBackfill,workBackfillTick} from './journal-backfill.mjs';
import {enrichMetadata,metadataCandidates} from './metadata-enrichment.mjs';
import http from 'node:http';
import crypto from 'node:crypto';
import {config,topics} from './config.mjs';
import {labRoute,recoverDocumentJobs} from './lab.mjs';
import {diagnosticRoute,diagnosticStatus,startPurgeTimer} from './diagnostic/service.mjs';
import {db,now} from './db.mjs';
import {migrationSummary} from './migrations.mjs';
import {safeArticleUrl} from './sources.mjs';
import {scanAll,checkScheduled,scanningNow} from './monitor.mjs';
import {sendVerification,mailReady,hash,token,esc,scheduledDigest} from './mail.mjs';
import {log,errorFields,requestIdFrom,routeTemplate,withRequestContext,processStartedAt} from './platform/log.mjs';
const sqliteVersion=db.prepare('SELECT sqlite_version() AS v').get().v;
// Read-only version facts for operators and agents; never exposes configuration values.
function runtimeInfo(){const latest=db.prepare('SELECT version,applied_at FROM schema_migrations ORDER BY applied_at DESC,rowid DESC LIMIT 1').get();return {commit:process.env.FANSCOPE_COMMIT||'unknown',startedAt:processStartedAt,node:process.versions.node,sqlite:sqliteVersion,schema:{latest:latest?.version||null,count:db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n},migrations:migrationSummary(db)};}
const rates=new Map();
function rateLimit(key,limit=10,windowMs=3600000){const ts=Date.now(),r=rates.get(key)||{start:ts,count:0};if(ts-r.start>windowMs){r.start=ts;r.count=0;}r.count++;rates.set(key,r);return r.count<=limit;}
const json=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
const html=(res,code,text)=>{res.writeHead(code,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(text);};
const parse=(u)=>new URL(u||'/',`http://localhost:${config.port}`);
const number=(s,def,max)=>Math.max(0,Math.min(max,Number(s)||def));
async function body(req,maxBytes=150000){let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>maxBytes){const e=Error('请求体超过大小限制');e.status=413;throw e;}chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{const e=Error('JSON payload required');e.status=400;throw e;}}
function adminOk(req){if(config.adminKey.length<24)return false;const supplied=Buffer.from(String(req.headers['x-admin-key']||'')),expected=Buffer.from(config.adminKey);return supplied.length===expected.length&&crypto.timingSafeEqual(supplied,expected);}
const selectFields=`a.id,a.journal_id,a.market,a.title,a.doi,a.url,a.authors,a.abstract,a.publication_date,a.discovered_at,a.topics,a.matched,a.method,a.design,a.data_origin,a.sample_n,a.sample_unit,a.evidence,a.ai_summary,a.analysis_status,a.demo,a.source,a.published_online_date,a.published_print_date,a.publication_date_partial,a.volume,a.issue,a.issns_json,a.source_evidence_json,a.metadata_fetched_at,a.source_verification_status,a.missing_fields_json,a.indexed_at,a.date_precision,a.publisher_landing_url,a.link_provenance,a.analysis_json,a.article_type,a.article_type_evidence_json,a.abstract_status,a.abstract_source,a.abstract_checked_at,a.relevance_score,j.issn,j.title AS journal_title`;
const sqlArticles=`SELECT ${selectFields} FROM articles a JOIN journals j ON j.id=a.journal_id`;
function articleList(query){const w=researchWhere(query),limit=Math.min(100,number(query.limit,20,100)),offset=Math.min(20000,number(query.offset,0,20000));
 const order=query.view==='discovered'?'a.discovered_at DESC':`${publicationOrder} DESC`;
 const rows=db.prepare(sqlArticles+w.where+` ORDER BY ${order},a.id LIMIT ? OFFSET ?`).all(...w.params,limit,offset).map(articleJSON);
 const total=db.prepare('SELECT COUNT(*) AS n FROM articles a'+w.where).get(...w.params).n;return {total,limit,offset,items:rows};
}
function stats(q={}){
 const r=researchReport(q),w=researchWhere(q),today=new Date(Date.now()-86400000).toISOString();
 const relevant=db.prepare('SELECT COUNT(*) n FROM articles a'+w.where+' AND a.matched=1').get(...w.params).n;
 const recent=db.prepare('SELECT COUNT(*) n FROM articles a'+w.where+' AND a.discovered_at>=?').get(...w.params,today).n;
 const designCounts={};for(const [key,n] of Object.entries(r.designs)){const design=key.split('|')[1];designCounts[design]=(designCounts[design]||0)+n;}
 const topicCounts={};for(const [key,n] of Object.entries(r.topics)){const id=key.split('|')[1];topicCounts[id]=(topicCounts[id]||0)+n;}
 return {count:r.n,relevant,recent,analyzed:r.analyzed,window:r.window,article_type:r.article_type,sampleCoverage:r.known.sample,years:Object.entries(r.monthly).map(([year,n])=>({year,n})),topicCounts:Object.entries(topicCounts).map(([id,n])=>({id,label:topics.find(t=>t.id===id)?.short||id,n})),designCounts:Object.entries(designCounts).map(([name,n])=>({name,n})),generatedAt:now()};
}
function page(res,ok,msg){html(res,ok?200:400,`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FanScope</title><body style="font:16px system-ui;background:#f5f8fb;padding:12vh 12vw;color:#152840"><h1>FanScope · ${ok?'已完成':'操作失败'}</h1><p>${esc(msg)}</p><p><a href="${esc(config.frontendUrl)}">返回 FanScope</a></p></body></html>`);}
async function handle(req,res){
 const u=parse(req.url),p=u.pathname,method=req.method||'GET';
 if(method==='OPTIONS'){res.writeHead(204);res.end();return;}
 if(p.startsWith('/api/diagnostic/'))return diagnosticRoute(req,res,u);
 if(p.startsWith('/api/lab/'))return labRoute(req,res,u);
 if(p==='/api/health')return json(res,200,{status:'ok',time:now(),service:'fanscope-api',monitoring:db.prepare('SELECT COUNT(*) AS n FROM journals WHERE enabled=1').get().n,emailConfigured:mailReady(),aiConfigured:!!config.dsKey,diagnostic:diagnosticStatus(),...runtimeInfo()});
 if(p==='/api/chinese-diagnostics'&&method==='GET')return json(res,200,chineseDiagnostics());
 if(p.startsWith('/api/chinese-batches/')&&method==='GET')return json(res,200,chineseBatch(p.slice('/api/chinese-batches/'.length)));
 if(p==='/api/topics')return json(res,200,{items:topics.map(({id,label,short})=>({id,label,short}))});
 if(p==='/api/journals')return json(res,200,{items:sourceSummary().items.filter(j=>!u.searchParams.get('market')||u.searchParams.get('market')==='all'||j.market===u.searchParams.get('market')).map(j=>({...j,enabled:!!j.enabled}))});
 if(p==='/api/articles'&&method==='GET')return json(res,200,articleList(Object.fromEntries(u.searchParams)));
 if(p==='/api/research-comparison'&&method==='GET')return json(res,200,comparableYearToDate(Object.fromEntries(u.searchParams)));
 if(p==='/api/research'&&method==='GET'){const q=Object.fromEntries(u.searchParams);return json(res,200,{...researchReport(q),generatedBrief:cachedBrief(q)});}
 if(p==='/api/stats'&&method==='GET')return json(res,200,stats(Object.fromEntries(u.searchParams)));
 if(p==='/api/analysis-coverage'&&method==='GET')return json(res,200,coverage({...Object.fromEntries(u.searchParams),period:u.searchParams.get('period')||'ytd'}));
 if(p==='/api/ai-auto-status'&&method==='GET')return json(res,200,automaticStatus());
 if(p==='/api/journal-source-status'&&method==='GET')return json(res,200,sourceSummary());
 if(p==='/api/journal-discoveries'&&method==='GET')return json(res,200,getJournalDiscoveries());
 if(p==='/api/journal-backfill-status'&&method==='GET')return json(res,200,backfillSummary());
 if(p==='/api/system-status'&&method==='GET'){
  const journals=sourceSummary().items;const jobs=db.prepare('SELECT id,kind,start_at,end_at,status,details FROM jobs ORDER BY id DESC LIMIT 12').all();
  return json(res,200,{journals:journals.map(j=>({...j,scan:db.prepare('SELECT * FROM scan_windows WHERE journal_id=?').get(j.id)||null})),jobs,aiQueue:db.prepare('SELECT analysis_status,COUNT(*) AS n FROM articles GROUP BY analysis_status').all(),unconfiguredChinese:journals.filter(j=>j.market==='chinese'&&!j.enabled&&!j.automatic_source_verified&&!j.article_count).length,emailsReady:mailReady(),aiReady:!!config.dsKey});
 }
 if(p==='/api/subscriptions/request'&&method==='POST'){
  if(!config.publicSubscriptions||!mailReady())return json(res,503,{error:'邮箱通知尚未配置，请联系管理员'});
  const b=await body(req),email=String(b.email||'').trim().toLowerCase();
  if(!/^[^\s@]{1,64}@[^\s@]{1,180}\.[^\s@]{2,}$/.test(email))return json(res,400,{error:'邮箱地址格式不正确'});
  if(!rateLimit(`subscribe:${req.socket.remoteAddress}`,8)||!rateLimit(`email:${email}`,3))return json(res,429,{error:'请求太频繁，请稍后重试'});
  const markets=Array.isArray(b.markets)?b.markets.filter(m=>['chinese','international'].includes(m)):['chinese','international'];
  const selected=Array.isArray(b.topics)?b.topics.filter(t=>topics.some(x=>x.id===t)):[];
  if(!markets.length)return json(res,400,{error:'至少选择一类期刊'});
  const verify=token(),unsub=token(),id=crypto.randomUUID();
  const prior=db.prepare('SELECT id,confirmed FROM subscribers WHERE email=?').get(email);
  if(prior?.confirmed)return json(res,200,{ok:true,message:'如果已经订阅，系统会保留原有设置。如需修改请联系管理员。'});
  try{await sendVerification(email,verify);}catch(e){log('warn','mail.verification_failed',errorFields(e));return json(res,502,{error:'验证邮件发送失败，请稍后重试或检查邮件服务配置'});}
  db.prepare(`INSERT INTO subscribers(id,email,topics,markets,urgent,daily,weekly,confirmed,verify_hash,unsubscribe_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET topics=excluded.topics,markets=excluded.markets,urgent=excluded.urgent,daily=excluded.daily,weekly=excluded.weekly,verify_hash=excluded.verify_hash,unsubscribe_hash=excluded.unsubscribe_hash`).run(prior?.id||id,email,JSON.stringify(selected),JSON.stringify(markets),b.urgent?1:0,b.daily?1:0,b.weekly?1:0,0,hash(verify),hash(unsub),now());
  const subscriberId=prior?.id||id;
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('unsub:'+subscriberId,unsub);
  return json(res,200,{ok:true,message:'验证邮件已提交发送，请到邮箱点击确认链接'});
 }
 if(p==='/api/subscriptions/confirm'&&method==='GET'){
  const tokenValue=u.searchParams.get('token')||'';if(tokenValue.length<20)return page(res,false,'无效确认链接');
  const s=db.prepare('SELECT id FROM subscribers WHERE verify_hash=?').get(hash(tokenValue));if(!s)return page(res,false,'链接不存在或已失效');
  db.prepare('UPDATE subscribers SET confirmed=1,confirmed_at=?,verify_hash=NULL WHERE id=?').run(now(),s.id);return page(res,true,'邮箱验证成功，论文通知已经启用。');
 }
 if(p==='/api/subscriptions/unsubscribe'&&method==='GET'){
  const t=u.searchParams.get('token')||'';if(t.length<20)return page(res,false,'无效退订链接');
  const s=db.prepare('SELECT id FROM subscribers WHERE unsubscribe_hash=?').get(hash(t));if(!s)return page(res,false,'链接无效或已退订');
  return html(res,200,`<!doctype html><html lang="zh"><meta charset="utf-8"><body style="font:16px system-ui;max-width:560px;margin:12vh auto;padding:20px"><h2>FanScope 邮件订阅</h2><p>确认停止接收邮件吗？</p><form method="POST" action="/api/subscriptions/unsubscribe?token=${encodeURIComponent(t)}"><button type="submit" style="padding:12px 18px">确认退订</button></form></body></html>`);
 }
 if(p==='/api/subscriptions/unsubscribe'&&method==='POST'){
  const t=u.searchParams.get('token')||'';const s=t.length>=20?db.prepare('SELECT id FROM subscribers WHERE unsubscribe_hash=?').get(hash(t)):null;
  if(!s)return page(res,false,'链接已失效');db.prepare('DELETE FROM subscribers WHERE id=?').run(s.id);db.prepare('DELETE FROM meta WHERE key=?').run('unsub:'+s.id);return page(res,true,'已退订，未来不会再收到 FanScope 邮件。');
 }
 if(p.startsWith('/api/admin/')){
  if(!adminOk(req))return json(res,401,{error:'管理员密钥不正确或未设置'});
  if(p==='/api/admin/ai-auto'&&method==='GET')return json(res,200,automaticStatus());
  if(p==='/api/admin/ai-auto'&&method==='POST')return json(res,200,changeAutomatic((await body(req)).action));
  if(p==='/api/admin/chinese-imports/catalog'&&method==='GET')return json(res,200,importCatalog());
  if(p==='/api/admin/chinese-imports'&&method==='GET')return json(res,200,listImports());
  if(p==='/api/admin/chinese-imports/licenses'&&method==='POST')return json(res,201,registerImportLicense(await body(req)));
  if(p==='/api/admin/chinese-imports/inspect'&&method==='POST')return json(res,200,inspectImportFile(await body(req,18*1024*1024)));
  if(p==='/api/admin/chinese-imports/files'&&method==='POST')return json(res,201,stageImportFile(await body(req,18*1024*1024)));
  const licenseRoute=p.match(/^\/api\/admin\/chinese-imports\/licenses\/([^/]+)\/review$/);
  if(licenseRoute&&method==='POST')return json(res,200,reviewImportLicense(licenseRoute[1],await body(req)));
  const importRoute=p.match(/^\/api\/admin\/chinese-imports\/batches\/([^/]+)(?:\/(review|step|audit|errors))?$/);
  if(importRoute){const [,id,action]=importRoute;
   if(method==='GET'&&action==='audit')return json(res,200,importAudit(id));
   if(method==='GET')return json(res,200,importBatch(id,{offset:u.searchParams.get('offset'),limit:u.searchParams.get('limit')||100,errorsOnly:action==='errors'}));
   if(method==='POST'&&action==='review')return json(res,200,reviewImportRows(id,await body(req)));
   if(method==='POST'&&action==='step')return json(res,200,stepImportBatch(id,await body(req)));
  }
  if(['/api/admin/import','/api/admin/chinese-import'].includes(p)&&method==='POST')return json(res,409,{error:'直接手工入库已停用；请使用授权导入工作台，先暂存并审核'});
  if(p==='/api/admin/chinese-source'&&method==='POST')return json(res,200,await configureChinese(await body(req)));
  if(p==='/api/admin/chinese-batches'&&method==='POST')return json(res,201,createChineseBatch(await body(req)));
  if(p.startsWith('/api/admin/chinese-batches/')&&method==='POST'){const b=await body(req),id=p.slice('/api/admin/chinese-batches/'.length);return json(res,200,b.action?changeChineseBatch(id,b.action,{maxSteps:b.maxSteps}):await stepChineseBatch(id));}
  if(p==='/api/admin/chinese-jobs'&&method==='POST')return json(res,201,createChineseJob(await body(req)));
  if(p.startsWith('/api/admin/chinese-jobs/')&&method==='POST'){const b=await body(req),id=p.slice('/api/admin/chinese-jobs/'.length);return json(res,200,b.action==='cancel'?cancelChineseJob(id):await stepChineseJob(id));}
  if(p==='/api/admin/metadata-candidates'&&method==='GET')return json(res,200,{items:metadataCandidates({limit:20})});
  if(p==='/api/admin/enrich-metadata'&&method==='POST')return json(res,200,await enrichMetadata(await body(req)));
  if(p==='/api/admin/journal-source/rss'&&method==='POST')return json(res,200,await manageRSS(await body(req)));
  if(p==='/api/admin/journal-source/discover'&&method==='POST'){
   const b=await body(req);return json(res,200,await discoverJournalSource(b.id));
  }
  if(p==='/api/admin/journal-discoveries/start-all'&&method==='POST')return json(res,200,startAllJournalDiscoveries());
  if(p==='/api/admin/journal-discoveries'&&method==='POST')return json(res,201,queueJournalDiscoveries(await body(req)));
  if(p.startsWith('/api/admin/journal-discoveries/')&&method==='POST'){
   const rest=p.slice('/api/admin/journal-discoveries/'.length).split('/');
   if(rest.length===2)return json(res,200,updateJournalDiscovery(rest[0],rest[1]));
  }
  if(p==='/api/admin/journal-source/test'&&method==='POST'){
   const b=await body(req);return json(res,200,await probeJournalSource({...b,enable:false}));
  }
  if(p==='/api/admin/journal-source/activate'&&method==='POST'){
   const b=await body(req);return json(res,200,await probeJournalSource({...b,enable:true}));
  }
  if(p==='/api/admin/journal-backfills'&&method==='POST')return json(res,201,createBackfill(await body(req)));
  if(p.startsWith('/api/admin/journal-backfills/')){
   const bits=p.slice('/api/admin/journal-backfills/'.length).split('/');
   if(bits.length===1&&method==='GET')return json(res,200,getBackfill(bits[0]));
   if(bits.length===2&&method==='POST')return json(res,200,changeBackfill(bits[0],bits[1]));
  }
  if(p==='/api/admin/analysis-batches'&&method==='GET')return json(res,200,{items:listBatches()});
  if(p==='/api/admin/analysis-batches'&&method==='POST')return json(res,201,createBatch(await body(req)));
  if(p.startsWith('/api/admin/analysis-batches/') ){
   const bits=p.slice('/api/admin/analysis-batches/'.length).split('/');
   if(bits.length===1&&method==='GET')return json(res,200,batchDetail(bits[0]));
   if(bits.length===2&&method==='POST')return json(res,200,bits[1]==='budget'?setBatchBudget(bits[0],await body(req)):changeBatch(bits[0],bits[1]));
  }
  if(p==='/api/admin/journal-review'&&method==='POST'){
   const b=await body(req),j=db.prepare('SELECT * FROM journals WHERE id=?').get(String(b.id||''));if(!j)return json(res,404,{error:'期刊不存在'});
   const rank=String(b.rank_system||''),evidence=safeArticleUrl(b.rank_evidence_url),host=evidence?new URL(evidence).hostname:'';
   const valid=j.market==='chinese'?['CSSCI_source','CSSCI_extended'].includes(rank)&&(host==='cssci.nju.edu.cn'||host.endsWith('.nju.edu.cn')):rank==='JCR_Q1'&&['jcr.clarivate.com','clarivate.com'].some(h=>host===h||host.endsWith('.'+h));
   if(!valid||b.manual_confirmation!==true||!/^20\d\d(?:-20\d\d)?$/.test(String(b.rank_year||''))||!String(b.rank_category||'').trim())return json(res,400,{error:'请人工确认独立排名体系、年度、学科分类及官方证据链接；不可使用 SJR / 中科院分区替代 JCR'});
   if(j.market==='chinese'){if(String(b.rank_year)!=='2025-2026'||!String(b.catalog_quote||'').includes(j.title)||!String(b.catalog_page||'').trim())return json(res,400,{error:'请提供2025—2026官方目录中本刊原文及页码，来源版与扩展版分开核对'});db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('cssci-review:'+j.id,JSON.stringify({year:'2025-2026',kind:rank,evidence,quote:String(b.catalog_quote).slice(0,1500),page:String(b.catalog_page).slice(0,50),at:now(),verification:'operator-reviewed'}));}
   db.prepare("UPDATE journals SET rank_system=?,rank_year=?,rank_category=?,rank_evidence_url=?,rank_verification_status='verified' WHERE id=?").run(rank,String(b.rank_year),String(b.rank_category).slice(0,300),evidence,j.id);
   db.prepare('INSERT INTO jobs(kind,start_at,end_at,status,details) VALUES(?,?,?,?,?)').run('journal_rank_review',now(),now(),'ok',j.id);return json(res,200,{ok:true,verification:'operator-reviewed official evidence; source enabling unchanged'});
  }
  if(p==='/api/admin/research-brief'&&method==='POST'){const b=await body(req);return json(res,200,await generateBrief(b));}
  if(p==='/api/admin/enrich-openalex'&&method==='POST')return json(res,200,await enrichOpenAlex());
  if(p==='/api/admin/analyze'&&method==='POST'){const b=await body(req);return json(res,200,await analyzePending(Math.min(5,number(b.limit,2,5)),{journal:b.journal,topic:b.topic}));}
  if(p==='/api/admin/scan'&&method==='POST'){
   const b=await body(req);const jr=String(b.journalId||'');if(jr&&!db.prepare('SELECT 1 FROM journals WHERE id=?').get(jr))return json(res,400,{error:'未知期刊 ID'});
   // HTTP scan may take minutes; use CLI for major historical backfills.
   if(scanningNow())return json(res,409,{error:'已有扫描运行中'});setImmediate(()=>scanAll({journalId:jr,backfill:!!b.backfill,lookbackDays:number(b.days,30,180)}).catch(e=>log('error','worker.failed',{worker:'admin-scan',...errorFields(e)})));return json(res,202,{status:'queued'});
  }
  if(p==='/api/admin/digest'&&method==='POST'){const b=await body(req);return json(res,200,await scheduledDigest(b.kind==='weekly'?'weekly':'daily'));}
  return json(res,404,{error:'未知管理员接口'});
 }
 return json(res,404,{error:'Not found'});
}
export function makeServer({readOnly=false}={}){return http.createServer((req,res)=>{
 const started=process.hrtime.bigint(),request_id=requestIdFrom(req.headers['x-request-id']);
 let route='/';try{route=routeTemplate(parse(req.url).pathname);}catch{}
 res.setHeader('X-Request-Id',request_id);
 // One access line per request; successful health probes are skipped to keep volume low.
 res.on('finish',()=>{const status=res.statusCode;if(route==='/api/health'&&status<400)return;log(status>=500?'error':'info','http.request',{request_id,method:req.method,route,status,duration_ms:Number(process.hrtime.bigint()-started)/1e6});});
 return withRequestContext({request_id},async()=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
 const origin=req.headers.origin;if(origin&&config.origins.includes(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Admin-Key,Authorization,X-File-Name,X-Request-Id');res.setHeader('Access-Control-Expose-Headers','X-Request-Id');}
 try{
 const requestPath=parse(req.url).pathname;
 if(process.env.NODE_ENV==='production'&&(requestPath.startsWith('/api/admin/chinese-')||requestPath==='/api/admin/import'))return json(res,404,{error:'Not found'});
 if(readOnly&&(!['GET','HEAD','OPTIONS'].includes(req.method)||requestPath==='/api/subscriptions/confirm'))return json(res,503,{error:'发布验收期间仅允许读取'});
 await handle(req,res);}catch(e){
  const status=Number.isInteger(e.status)?e.status:500;
  // Expected client errors carry a status; anything else is a server fault with a stack.
  if(status>=500)log('error','http.error',{request_id,method:req.method,route,status,...errorFields(e)});
  else log('info','http.client_error',{request_id,method:req.method,route,status,error_class:e.name||'Error'});
  if(!res.headersSent)json(res,status,{error:e.status?e.message:'内部服务错误',request_id});else res.end();}
 });
});}
if(process.argv[1]&&new URL(`file://${process.argv[1]}`).pathname===new URL(import.meta.url).pathname){
 if(process.env.NODE_ENV==='production'&&config.adminKey.length<24){log('error','service.config_invalid',{reason:'ADMIN_KEY must be at least 24 chars'});process.exit(1);}
 const server=makeServer();server.listen(config.port,'0.0.0.0',()=>log('notice','service.start',{entry:'server',port:config.port,...runtimeInfo()}));
 const failed=worker=>e=>log('error','worker.failed',{worker,...errorFields(e)});
 recoverDocumentJobs().catch(failed('document-recovery'));
 startPurgeTimer();
 setInterval(()=>recoverDocumentJobs().catch(failed('document-recovery')),15000).unref();
 if(config.scanOnStart)setTimeout(()=>scanAll().catch(failed('scan')),4000).unref();
 setInterval(()=>scanAll().catch(failed('scan')),config.intervalMinutes*60000).unref();
 recoverBatches();
 recoverJournalDiscoveries();
 setInterval(()=>discoveryTick().catch(failed('journal-discovery')),15000).unref();
 setInterval(()=>workBatchTick().catch(failed('analysis-batch')),10000).unref();
 setInterval(()=>workBackfillTick().catch(failed('journal-backfill')),15000).unref();
 // Fresh deployments must not silently spend research funds. Legacy ambient AI
 // analysis is opt-in; scheduled queue batches require explicit admin start.
 // AUTO_AI_ANALYSIS is retired: only administrator-started batches can run.
 // The incremental monitor remains metadata-only in 2027 and later.
 setInterval(()=>checkScheduled().catch(failed('digest')),60000).unref();
}
