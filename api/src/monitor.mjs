import {db,sql,now} from './db.mjs';
import {config} from './config.mjs';
import {relevanceScore} from './publication-policy.mjs';
import {crossrefPages,fetchRSS,canonicalDoi} from './sources.mjs';
import {urgentDispatch,scheduledDigest} from './mail.mjs';
let scanning=false;
function insert(a,demo=0){
 if(a.url&&db.prepare('SELECT 1 FROM articles WHERE journal_id=? AND (url=? OR publisher_landing_url=?) LIMIT 1').get(a.journal_id,a.url,a.url))return false;
 if(a.doi){a={...a,doi:canonicalDoi(a.doi),id:'doi:'+canonicalDoi(a.doi)};}
 const result=sql.insertArticle.run(a.id,a.journal_id,a.market,a.title,a.doi||'',a.url||'',a.authors||'',a.abstract||'',a.publication_date||'',a.publication_date?Number(a.publication_date.slice(0,4)):null,now(),a.source||'manual',JSON.stringify(a.topics||[]),a.matched?1:0,'pending',demo);
 if(result.changes)db.prepare('UPDATE articles SET published_online_date=?,indexed_at=?,date_precision=?,publisher_landing_url=?,link_provenance=? WHERE id=?').run(a.published_online_date||'',a.indexed_at||'',a.date_precision||(a.publication_date?'day':'unknown'),a.publisher_landing_url||'',a.link_provenance||'',a.id);
 if(result.changes)db.prepare('UPDATE articles SET published_print_date=?,volume=?,issue=?,issns_json=?,source_evidence_json=?,metadata_fetched_at=?,source_verification_status=?,missing_fields_json=? WHERE id=?').run(a.published_print_date||'',a.volume||'',a.issue||'',JSON.stringify(a.issns||[]),JSON.stringify(a.source_evidence||{source:a.source,url:a.url,doi:a.doi||null}),a.metadata_fetched_at||now(),a.source_verification_status||'unverified',JSON.stringify(a.missing_fields||{}),a.id);
 if(result.changes)db.prepare('UPDATE articles SET article_type=?,article_type_evidence_json=?,abstract_status=?,abstract_source=?,relevance_score=? WHERE id=?').run(a.article_type||'unknown',JSON.stringify(a.article_type_evidence||{}),(a.abstract||'').trim().length>=55?'available':'missing',a.abstract?a.source||'manual':null,relevanceScore(a.title,a.abstract),a.id);
 if(result.changes&&a.publication_date_partial)db.prepare('UPDATE articles SET publication_date_partial=?,published_year=? WHERE id=?').run(a.publication_date_partial,Number(a.publication_date_partial.slice(0,4)),a.id);
 if(result.changes){const date=Date.parse(a.published_online_date||a.publication_date||'');const recent=!a.publication_date_partial&&date>Date.now()-14*86400000&&date<=Date.now();db.prepare('UPDATE articles SET notification_eligible=? WHERE id=?').run(a.scan_mode==='incremental'&&recent?1:0,a.id);}
 return result.changes>0;
}
export {insert as insertArticle};
export async function scanAll({journalId='',lookbackDays=config.initialLookbackDays,backfill=false}={}){
 if(scanning)return {status:'busy',message:'Another scan is running'};
 scanning=true;const start=now();const id=sql.logJob.run('scan',start,'running',journalId||'all').lastInsertRowid;
 let total=0,newArticles=[],errors=[],scanned=0;const previouslyMonitored=new Set();
 try{
  const journals=db.prepare('SELECT * FROM journals WHERE enabled=1 ORDER BY market,id').all().filter(j=>!journalId||j.id===journalId);
  const scanJournal=async j=>{
   let found=0;const started=now();const checkpoint=j.checkpoint;let partial=false;
   if(checkpoint)previouslyMonitored.add(j.id);
   try{
    if(j.source==='crossref'){
      if(!j.issn)throw Error('ISSN missing');
      let state=db.prepare('SELECT * FROM scan_windows WHERE journal_id=?').get(j.id);
      const onState=st=>{state=st;db.prepare(`INSERT INTO scan_windows(journal_id,mode,range_end,window_start,window_end,cursor,processed,total,attempts,status,error,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(journal_id) DO UPDATE SET mode=excluded.mode,range_end=excluded.range_end,window_start=excluded.window_start,window_end=excluded.window_end,cursor=excluded.cursor,processed=excluded.processed,total=excluded.total,attempts=excluded.attempts,status=excluded.status,error=excluded.error,updated_at=excluded.updated_at`).run(j.id,st.mode,st.range_end,st.window_start,st.window_end,st.cursor,st.processed,st.total,st.attempts,st.status,st.error,now());};
      for await(const page of crossrefPages(j,{initial:backfill||!checkpoint,checkpoint,lookbackDays,maxPages:config.maxPages,state,onState})){
        for(const a of page){if(insert(a)){found++;newArticles.push(a.id);}}
      }
      if(state?.status!=='complete')throw Error('扫描预算已用完，窗口游标已保存，下一轮续跑');
    } else if(j.source==='rss'){
      if(!j.rss_url)throw Error('Official RSS URL not configured');
      for(const article of await fetchRSS(j)){const a={...article,scan_mode:checkpoint&&!backfill?'incremental':'backfill'};if(insert(a)){found++;newArticles.push(a.id);}}
    } else {throw Error(`Unsupported source ${j.source}`);}
    db.prepare('UPDATE journals SET last_checked=?,last_success=?,last_error=NULL,last_count=?,checkpoint=? WHERE id=?').run(started,now(),found,(db.prepare('SELECT range_end FROM scan_windows WHERE journal_id=?').get(j.id)?.range_end||now()),j.id);
   }catch(e){partial=true;errors.push({journal:j.title,error:String(e.message).slice(0,230)});
    db.prepare('UPDATE journals SET last_checked=?,last_error=? WHERE id=?').run(started,String(e.message).slice(0,230),j.id);
   }
   scanned++;total+=found;
   if(partial) console.warn('Monitor partial failure',j.title);
  };
  const queue=[...journals];await Promise.all(Array.from({length:Math.min(2,journals.length)},async()=>{while(queue.length)await scanJournal(queue.shift());}));
  const ai={status:'independent_queue'};
  // New article backfill must not trigger floods; initial monitoring pass is silent.
  const eligibleIds=newArticles.filter(aId=>{
   const a=db.prepare('SELECT * FROM articles WHERE id=?').get(aId);const j=sql.journal.get(a.journal_id);
   return a.notification_eligible===1 && !backfill && previouslyMonitored.has(j.id) && a.matched && new Date(a.published_online_date||a.publication_date||0).getTime()>Date.now()-14*86400000;
  });
  const mail=await urgentDispatch(eligibleIds);
  const outcome={status:errors.length?'partial':'ok',scanned,newCount:total,errors,ai,mail};
  sql.finishJob.run(now(),outcome.status,JSON.stringify(outcome),id);return outcome;
 }catch(e){sql.finishJob.run(now(),'failed',String(e.message),id);throw e;}
 finally{scanning=false;}
}
export function scanningNow(){return scanning;}
function shanghaiClock(){const f=new Intl.DateTimeFormat('en-CA',{timeZone:config.tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(new Date());return Object.fromEntries(f.map(x=>[x.type,x.value]));}
export async function checkScheduled(){
 const t=shanghaiClock();if(Number(t.hour)<8)return;
 const day=`${t.year}-${t.month}-${t.day}`;
 for(const kind of ['daily',...(t.weekday==='Mon'?['weekly']:[])]){
  const key=`digest:${kind}`,value=db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
  if(value===day)continue;
  const r=await scheduledDigest(kind);
  if(r.reason==='email disabled')continue;
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,day);
  console.log(`${kind} digest`,r);
 }
}
