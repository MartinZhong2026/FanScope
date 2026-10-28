// Run --probe first. All writes are constrained to a dedicated DB under work/.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chineseTransport} from '../api/src/chinese-transport.mjs';
import {chineseCatalogLinks} from '../api/src/chinese-catalog.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),arg=(key,fallback)=>{const i=args.indexOf('--'+key);return i<0?fallback:args[i+1];};
const action=args[0],days=Number(arg('days','180'));
if(!Number.isInteger(days)||days<1||days>1096)throw Error('--days must be 1..1096');
const output=path.resolve(root,arg('output','work/chinese-bulk'));
if(!output.startsWith(path.join(root,'work')+path.sep))throw Error('Output must be inside work/');
fs.mkdirSync(output,{recursive:true});
const manifest=JSON.parse(fs.readFileSync(path.join(root,'api/config/chinese-bulk-sources.json')));
const inventory=JSON.parse(fs.readFileSync(path.join(root,'api/config/chinese-journal-inventory.json')));
// Explicit operator-only path for system VPNs that resolve public hosts to
// synthetic private addresses. Never exposed by the HTTP API. Exact reviewed
// hosts/routes, TLS verification, size limit and redirect refusal still apply.
async function systemCatalogRead(url){
 const u=new URL(url),allowed=['rkyj.ruc.edu.cn','www.society.shu.edu.cn'];
 if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash||!allowed.includes(u.hostname)||!/^\/(?:robots\.txt|CN\/(?:\d{4}-\d{3}[\dX]\/home\.shtml|article\/showOldVolumn\.do|volumn\/volumn_\d+\.shtml|Y\d{4}\/V\d+\/I\d+\/[^/]+))$/.test(u.pathname)||u.search)throw Error('Not an approved operator catalogue URL');
 const r=await fetch(u,{headers:{'User-Agent':'FanScope-Metadata/1.3 (bibliographic metadata only)',Accept:'text/html,text/plain'},redirect:'manual',signal:AbortSignal.timeout(20000)});
 if(!r.ok){const header=r.headers.get('retry-after'),seconds=Number(header),retryMs=header?(Number.isFinite(seconds)?seconds*1000:Date.parse(header)-Date.now()):0;await r.body?.cancel();throw Object.assign(Error('HTTP '+r.status),{status:r.status,retryMs});}
 let n=0;const chunks=[];for await(const c of r.body){n+=c.length;if(n>2000000)throw Error('Catalogue exceeds 2MB');chunks.push(c);}return Buffer.concat(chunks).toString('utf8');
}
const transport=chineseTransport({maxRequests:Number(arg('requests','900')),logFile:path.join(output,'requests.jsonl'),...(args.includes('--system-network')?{readFeed:systemCatalogRead}:{})});
const until=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const from=new Date(Date.parse(until+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);
const write=(name,data)=>fs.writeFileSync(path.join(output,name),JSON.stringify(data,null,2)+'\n');
const crossref=(issn,start,rows=2)=>'https://api.crossref.org/journals/'+issn+'/works?'+new URLSearchParams({filter:`from-pub-date:${start},until-pub-date:${until}`,rows:String(rows),sort:'published',order:'desc'});

if(action==='probe'){
 // Probe does not import the application or open SQLite.
 const results=[];
 const prior=args.includes('--refresh-catalog')?JSON.parse(fs.readFileSync(path.join(output,'probe.json'))):null;
 if(prior&&(prior.days!==days||prior.until!==until||prior.items.length!==inventory.length))throw Error('Complete same-day probe required before refreshing catalogues');
 for(const j of inventory){
  const r={...j,checkedAt:new Date().toISOString(),cssciStatus:'pending',cssciEvidence:manifest.rankEvidence,ready:false,blockers:[]};
  const policy=manifest.sources.find(s=>s.journalId===j.id);
  if(prior&&policy?.provider!=='catalog'){results.push(prior.items.find(x=>x.id===j.id));continue;}
  if(prior)Object.assign(r,prior.items.find(x=>x.id===j.id),{ready:false,blockers:[]});
  if(j.issn&&!prior)try{
   const registry=await transport.json('https://api.crossref.org/journals/'+j.issn);
   const data=await transport.json(crossref(j.issn,from));
   r.crossref={title:registry.message.title,issns:registry.message.ISSN,publisher:registry.message.publisher,count:data.message['total-results'],sample:data.message.items.map(x=>({title:x.title,issns:x.ISSN,journal:x['container-title'],doi:x.DOI,published:x.published,issued:x.issued}))};
   if(policy?.provider==='crossref'&&registry.message.ISSN?.includes(policy.issn))r.ready=true;
  }catch(e){r.crossref={error:e.message};}
  if(j.issn&&!prior)try{
   const source=await transport.json('https://api.openalex.org/sources/issn:'+j.issn);
   if(!source.issn?.includes(j.issn)||!/^https:\/\/openalex.org\/S\d+$/.test(source.id))throw Error('OpenAlex source identity mismatch');
   const data=await transport.json('https://api.openalex.org/works?'+new URLSearchParams({filter:`primary_location.source.id:${source.id.split('/').at(-1)},from_publication_date:${from},to_publication_date:${until}`,per_page:'1'}));
   r.openalex={id:source.id,title:source.display_name,issns:source.issn,earliestYear:source.first_publication_year,latestYear:source.last_publication_year,count:data.meta.count,policy:'Anonymous first-page probe only; bulk cursor requires a free authorized API key'};
  }catch(e){r.openalex={error:e.message};}
  if(policy?.provider==='catalog')try{
   const hosts=[new URL(policy.url).hostname];
   const robots=await transport.read(policy.permissionEvidence,hosts);
   // Only the explicitly reviewed Allow: / policy is approved by this manifest.
   if(!/Allow:\s*\//i.test(robots)||/Disallow:\s*\/[^\r\n]*/i.test(robots))throw Error('Robots policy requires manual review');
   const sample=await transport.read(policy.sampleUrl,hosts);
   const issns=[...sample.matchAll(/<meta\b[^>]*name=["']citation_issn["'][^>]*content=["']([^"']+)/gi)].map(x=>x[1]);
   if(!issns.includes(policy.issn)||!sample.includes(policy.title))throw Error('Citation sample identity mismatch');
   r.catalog={url:policy.url,archive:policy.seedUrls,permissionEvidence:policy.permissionEvidence,robots:'Allow: /',sampleUrl:policy.sampleUrl,issns,metadataScope:policy.scope,transport:args.includes('--system-network')?'operator-reviewed system HTTPS':'DNS-pinned public HTTPS',estimatedArticles:null,note:'Catalogue count is unknown before bounded enumeration; not an assertion of complete journal coverage'};r.ready=true;
   if(args.includes('--estimate')){
    const articleLinks=new Set(),issueLinks=new Set();
    for(const u of [policy.url,...policy.seedUrls])for(const link of chineseCatalogLinks(await transport.read(u,hosts),u,from,until)){
     if(new URL(link).hostname!==hosts[0])throw Error('Foreign catalogue link');
     (link.includes('/volumn/')?issueLinks:articleLinks).add(link);
    }
    const budget=Number(arg('catalog-pages','60'));if(!Number.isInteger(budget)||budget<1||budget>100)throw Error('Invalid catalogue probe page budget');
    for(const u of [...issueLinks].slice(0,budget))for(const link of chineseCatalogLinks(await transport.read(u,hosts),u,from,until)){if(new URL(link).hostname!==hosts[0])throw Error('Foreign article link');articleLinks.add(link);}
    Object.assign(r.catalog,{estimatedArticles:articleLinks.size,estimateKind:'upper bound from matching calendar-year issue directories; exact dates, identity and non-paper types still require validation',issuePages:issueLinks.size,enumeratedIssuePages:Math.min(issueLinks.size,budget),estimateTruncated:issueLinks.size>budget});
   }
  }catch(e){r.catalog={error:e.message};r.ready=false;}
  if(!r.ready)r.blockers.push(j.blocker||'No verified permitted automatic source with recent matching records; obtain publisher/library metadata export');
  results.push(r);write('probe.json',{generatedAt:new Date().toISOString(),days,from,until,requests:transport.requests,items:results});console.log(j.id,'ready='+r.ready,'Crossref='+String(r.crossref?.count??r.crossref?.error),'OpenAlex='+String(r.openalex?.count??r.openalex?.error));
 }
 write('probe.json',{generatedAt:new Date().toISOString(),days,from,until,requests:transport.requests,items:results});
 console.log('Read-only source probe saved:',path.join(output,'probe.json'));process.exit(0);
}

if(!['run','resume','report','audit'].includes(action))throw Error('Usage: probe | run | resume --batch ID | audit | report [--days 180|365|1096]');
const dbPath=path.resolve(root,arg('db','work/chinese-bulk/fanscope-chinese.sqlite'));
if(!dbPath.startsWith(path.join(root,'work')+path.sep)||!dbPath.endsWith('.sqlite'))throw Error('Dedicated .sqlite database under work/ required');
if(fs.existsSync(path.join(root,'api/.env')))throw Error('api/.env exists: use a clean local checkout to avoid loading service credentials');
fs.mkdirSync(path.dirname(dbPath),{recursive:true});
Object.assign(process.env,{DATABASE_PATH:dbPath,SCAN_ON_START:'false',AUTO_AI_ANALYSIS:'false',DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:'',OPENALEX_ENABLED:'false'});
const lock=dbPath+'.bulk.lock';let fd;
try{fd=fs.openSync(lock,'wx');fs.writeSync(fd,String(process.pid));}catch{throw Error('Another collector holds '+lock+'; verify its PID before removing a stale lock');}
try{
 const {db}=await import('../api/src/db.mjs');
 const engine=await import('../api/src/chinese-ingestion.mjs');
 let batch;
 try{
 if(action==='audit')write('record-audit.json',engine.auditChineseRecords({apply:true}));
 if(action==='run'){
  const probe=JSON.parse(fs.readFileSync(path.join(output,'probe.json')));
  if(probe.days!==days||probe.until!==until||probe.items.length!==inventory.length)throw Error('Run a complete probe with the same --days today before collection');
  const chosen=arg('journals','all'),ids=chosen==='priority'?inventory.filter(j=>j.priority).map(j=>j.id):chosen==='all'?inventory.map(j=>j.id):chosen.split(',');
  const blockedSources=[];
  for(const id of ids){const p=probe.items.find(x=>x.id===id);if(!p)throw Error('Unknown target '+id);db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('cn-probe:'+id,JSON.stringify(p));if(!p.ready){blockedSources.push({journalId:id,error:(p.blockers||[]).join('; ')||'Source probe did not pass'});continue;}const s=manifest.sources.find(x=>x.journalId===id);try{await engine.configureChinese({...s,confirm:true},transport);}catch(e){blockedSources.push({journalId:id,error:e.message});}}
  batch=engine.createChineseBatch({journalIds:ids,days,blockedSources,incremental:args.includes('--incremental'),maxSteps:Number(arg('steps','850')),maxPages:Number(arg('pages','1500'))});
  write('last-batch.json',{batchId:batch.id,dbPath,days});
  engine.changeChineseBatch(batch.id,'resume');
 }else if(action==='resume'){
  batch=engine.chineseBatch(arg('batch',''));
  for(const job of batch.items)if(job.status==='paused'&&job.source.provider==='catalog')await engine.refreshChineseCatalogJob(job.id,transport);
  batch=engine.changeChineseBatch(batch.id,batch.status==='partial'?'retry':'resume',{maxSteps:Number(arg('steps','1000'))});
 }
 if(batch){
  let stopping=false;process.once('SIGINT',()=>{stopping=true;});
  while(batch.status!=='completed'&&batch.status!=='partial'&&batch.status!=='cancelled'){
   if(stopping||transport.requests>=transport.maxRequests){engine.changeChineseBatch(batch.id,'pause');break;}
   batch=await engine.stepChineseBatch(batch.id,transport);
   if(batch.steps%10===0||batch.status!=='running')console.log('batch',batch.id,'steps',batch.steps,batch.status,'added',batch.items.reduce((n,j)=>n+j.added,0),'requests',transport.requests);
   if(batch.status==='paused')break;
  }
  batch=engine.chineseBatch(batch.id);write('batch-'+batch.id+'.json',batch);
 }
 const report=engine.chineseDiagnostics();
 const dates=db.prepare("SELECT COUNT(*) total,MIN(COALESCE(NULLIF(publication_date_partial,''),NULLIF(publication_date,''))) earliest,MAX(COALESCE(NULLIF(publication_date_partial,''),NULLIF(publication_date,''))) latest,SUM(analysis_json IS NOT NULL) aiResults FROM articles WHERE market='chinese' AND demo=0").get();
 const records=db.prepare("SELECT id,journal_id,title,authors,publication_date,publication_date_partial,date_precision,published_online_date,published_print_date,discovered_at,metadata_fetched_at,source_updated_at,volume,issue,doi,url,publisher_landing_url,source,source_verification_status,source_evidence_json,analysis_status FROM articles WHERE market='chinese' AND demo=0 ORDER BY journal_id,publication_date_partial,publication_date,id").all();
 write('report.json',{generatedAt:new Date().toISOString(),dbPath,totals:dates,requests:transport.requests,batch,diagnostics:report});write('records.json',records);
 db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 const backup=dbPath+'.backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite';db.prepare('VACUUM INTO ?').run(backup);
 console.log(JSON.stringify({database:dbPath,backup,total:dates.total,earliest:dates.earliest,latest:dates.latest,batch:batch?.id,status:batch?.status,requests:transport.requests}));
 }finally{db.close();}
}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
