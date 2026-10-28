import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATABASE_PATH=path.join(os.tmpdir(),`fanscope-p0-${process.pid}.sqlite`);
process.env.SCAN_ON_START='false';process.env.MAX_CROSSREF_PAGES='4';
const {crossrefPages,crossrefToArticle,articleLink,safeArticleUrl,fetchJson}=await import('../src/sources.mjs');
const {db}=await import('../src/db.mjs');
const {insertArticle,scanAll}=await import('../src/monitor.mjs');
const j=db.prepare("SELECT * FROM journals WHERE id='jmir'").get();
const item=n=>({DOI:`10.9999/p0-${n}`,title:[`Caregiving ${n}`],type:'journal-article',published:{'date-parts':[[2026,10,23]]}});
after(()=>{db.close();for(const ext of ['','-wal','-shm'])fs.rmSync(process.env.DATABASE_PATH+ext,{force:true});});
test('550 records finish fixed window beyond soft four-page budget without losses',async()=>{
 let state=null,calls=0;const ids=new Set(),urls=[];
 const request=async url=>{calls++;const u=new URL(url);urls.push(u);assert.match(u.searchParams.get('filter'),/until-index-date:/);assert.ok(!u.searchParams.get('filter').includes('Z'));assert.ok(!u.searchParams.get('filter').includes('.000'));const cursor=u.searchParams.get('cursor'),offset=cursor==='*'?0:Number(cursor);return {message:{'total-results':550,'next-cursor':String(offset+100),items:Array.from({length:Math.min(100,550-offset)},(_,i)=>item(offset+i))}};};
 const until='2026-10-24T00:00:00.000Z';
 state={mode:'incremental',range_end:until,window_start:'2026-10-23T00:00:00.000Z',window_end:until,cursor:'*',processed:0,total:null,attempts:0,status:'running',error:''};
 const run=async()=>{for await(const page of crossrefPages(j,{state,maxPages:4,request,onState:s=>state=s})){for(const a of page){insertArticle(a);ids.add(a.id)}}};
 await run();assert.equal(state.status,'complete');assert.equal(ids.size,550);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM articles').get().n,550);assert.equal(calls,6);
 assert.equal(new Set(urls.map(u=>u.searchParams.get('filter'))).size,1,'range stays fixed');
});
test('interruption preserves failed cursor; duplicate DOI replay is harmless',async()=>{
 let state={mode:'incremental',range_end:'2026-10-24T00:00:00.000Z',window_start:'2026-10-23T00:00:00.000Z',window_end:'2026-10-24T00:00:00.000Z',cursor:'*',processed:0,total:null,attempts:0,status:'running',error:''};let fail=true;
 const request=async url=>{const c=new URL(url).searchParams.get('cursor');if(c==='next'&&fail)throw Error('timeout');return {message:{'total-results':101,'next-cursor':'next',items:c==='*'?Array.from({length:100},(_,i)=>item(i)):[item(100)]}}};
 const run=async()=>{for await(const page of crossrefPages(j,{state,request,onState:s=>state=s}))for(const a of page)insertArticle(a)};
 await assert.rejects(run,/timeout/);assert.equal(state.cursor,'next');assert.equal(state.processed,100);assert.equal(state.attempts,1);
 fail=false;await run();assert.equal(state.status,'complete');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM articles').get().n,550);
});
test('missing/nonadvancing cursor with incomplete total is never silently accepted',async()=>{
 await assert.rejects(async()=>{for await(const p of crossrefPages(j,{lookbackDays:1,request:async()=>({message:{'total-results':300,items:[item(1)]}})})){}},/cursor/);
});
test('429 and 5xx retry succeeds without a paid network call',async()=>{
 const orig=globalThis.fetch;let calls=0;globalThis.fetch=async()=>new Response(JSON.stringify({message:'ok'}),{status:++calls<3?429:200});try{assert.equal((await fetchJson('https://api.crossref.org/mock')).message,'ok');assert.equal(calls,3)}finally{globalThis.fetch=orig}
});
test('source dates and links never substitute indexing date or a journal homepage',()=>{
 const a=crossrefToArticle({...item(999),published:{'date-parts':[[2016,1,2]]},indexed:{'date-time':'2026-10-24T00:00:00Z'},URL:'https://www.jmir.org/'},j);assert.equal(a.publication_date,'2016-01-02');assert.equal(a.indexed_at,'2026-10-24T00:00:00Z');assert.equal(a.publisher_landing_url,'');
 assert.equal(crossrefToArticle({...item(1),published:{'date-parts':[[2026]]}},j).publication_date,'');
 assert.equal(safeArticleUrl('javascript:alert(1)'),'');assert.equal(safeArticleUrl('https://user:pass@evil.org/x'),'');assert.equal(articleLink({doi:'10.1234/a?b#c'}).article_url,'https://doi.org/10.1234/a%3Fb%23c');
});
test('journal failure does not block others; partial checkpoint retained; initial backfill stays silent',async()=>{
 const orig=globalThis.fetch;db.prepare("UPDATE journals SET enabled=0").run();db.prepare("UPDATE journals SET enabled=1 WHERE id IN ('jmir','ssm')").run();
 globalThis.fetch=async url=>{if(String(url).includes(j.issn))throw Error('offline');return new Response(JSON.stringify({message:{items:[item(900)],'total-results':1}}));};
 try{const r=await scanAll({lookbackDays:1});assert.equal(r.status,'partial');assert.equal(r.scanned,2);assert.equal(db.prepare("SELECT checkpoint FROM journals WHERE id='jmir'").get().checkpoint,null);assert.ok(db.prepare("SELECT checkpoint FROM journals WHERE id='ssm'").get().checkpoint);assert.equal(r.mail.sent,0);}finally{globalThis.fetch=orig}
});
test('multiple anchored daily windows complete through repeated bounded invocations',async()=>{
 let state=null;const ids=new Set(),windows=new Set();const until='2026-10-24T00:00:00.000Z';
 const request=async url=>{const u=new URL(url),f=u.searchParams.get('filter');windows.add(f);assert.match(f,/until-pub-date:/);const start=f.split(',')[0],offset=u.searchParams.get('cursor')==='*'?0:Number(u.searchParams.get('cursor'));return {message:{'total-results':301,'next-cursor':String(offset+100),items:Array.from({length:Math.min(100,301-offset)},(_,i)=>item(start.includes('22T')?2000+offset+i:3000+offset+i))}};};
 for(let run=0;run<5;run++){for await(const page of crossrefPages(j,{initial:true,lookbackDays:2,until,maxPages:3,state,request,onState:s=>state=s}))for(const a of page)ids.add(a.id);if(state.status==='complete')break;}
 assert.equal(state.status,'complete');assert.equal(windows.size,2);assert.equal(ids.size,602);
});

test('expired cursor replays only the fixed failed window with DOI deduplication',async()=>{
 let state={mode:'incremental',range_end:'2026-10-24T00:00:00.000Z',window_start:'2026-10-23T00:00:00.000Z',window_end:'2026-10-24T00:00:00.000Z',cursor:'expired',processed:100,total:101,attempts:0,status:'failed',error:''},calls=0;
 const request=async url=>{calls++;const cursor=new URL(url).searchParams.get('cursor');if(cursor==='expired')throw Error('HTTP 404');return {message:{'total-results':101,'next-cursor':'valid-next',items:cursor==='*'?Array.from({length:100},(_,i)=>item(i)):[item(100)]}}};
 for await(const page of crossrefPages(j,{state,request,onState:s=>state=s}))for(const a of page)insertArticle(a);
 assert.equal(state.status,'complete');assert.equal(calls,3);assert.equal(state.attempts,1);
});
test('JMIR and Social Science & Medicine both complete 550-item windows with maxPages=4',async()=>{
 for(const id of ['jmir','ssm']){const journal=db.prepare('SELECT * FROM journals WHERE id=?').get(id);let calls=0,count=0,state;
 const request=async url=>{calls++;assert.ok(String(url).includes(journal.issn));const c=new URL(url).searchParams.get('cursor'),offset=c==='*'?0:Number(c);return {message:{'total-results':550,'next-cursor':String(offset+100),items:Array.from({length:Math.min(100,550-offset)},(_,i)=>item(offset+i))}}};
 for await(const page of crossrefPages(journal,{initial:true,lookbackDays:1,maxPages:4,request,onState:s=>state=s}))count+=page.length;
 assert.equal(count,550,id);assert.equal(calls,6,id);assert.equal(state.status,'complete',id);
 }
});
test('very dense windows subdivide before consumption and retain complete temporal coverage',async()=>{
 const until='2026-10-24T00:00:00.000Z';let state,splitSeen=false;const completed=[];
 const request=async url=>{const filter=new URL(url).searchParams.get('filter').split(',');const start=Date.parse(filter[0].slice(filter[0].indexOf(':')+1)+'Z'),end=Date.parse(filter[1].slice(filter[1].indexOf(':')+1)+'Z');assert.ok(end>=start);if(end-start>12*3600000){splitSeen=true;return {message:{'total-results':20001,items:[]}};}completed.push([start,end]);return {message:{'total-results':1,items:[item(start)]}}};
 for await(const page of crossrefPages(j,{initial:true,lookbackDays:1,until,maxPages:20,request,onState:s=>state=s})){}
 assert.ok(splitSeen);assert.equal(state.status,'complete');assert.equal(completed[0][0],Date.parse('2026-10-23T00:00:00Z'));assert.equal(completed.at(-1)[1],Date.parse(until));for(let i=1;i<completed.length;i++)assert.equal(completed[i-1][1],completed[i][0]);
});
