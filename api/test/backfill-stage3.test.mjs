import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATABASE_PATH=path.join(os.tmpdir(),`fanscope-stage3-backfill-${process.pid}.sqlite`);
process.env.SCAN_ON_START='false';
const {db}=await import('../src/db.mjs');
const {createBackfill,getBackfill,changeBackfill,workBackfillTick,backfillSummary}=await import('../src/journal-backfill.mjs');
after(()=>{db.close();for(const ext of ['','-wal','-shm'])fs.rmSync(process.env.DATABASE_PATH+ext,{force:true})});
const issn='1469-1779';
function mockCrossref(url){
 const filter=new URL(url).searchParams.get('filter');
 const start=/from-pub-date:([^,]+)/.exec(filter)?.[1]||'bad';
 return {message:{'total-results':1,items:[{
   DOI:`10.1017/mock-${start.slice(0,10)}`,type:'journal-article',ISSN:[issn],
   title:[`Research from ${start}`],published:{'date-parts':[[2025,1,3]]},
   'container-title':['Ageing & Society']
 }]}};
}
test('historical backfill is operator-controlled and keeps independent cursor',async()=>{
 const j=db.prepare('SELECT id,enabled FROM journals WHERE id=?').get('ageing-society');assert.ok(j?.enabled);
 const b=createBackfill({journalId:'ageing-society',yearFrom:2025,yearTo:2025});
 assert.equal(b.status,'paused');
 assert.equal((await workBackfillTick({request:mockCrossref})).status,'idle');
 assert.throws(()=>createBackfill({journalId:'ageing-society',yearFrom:2025,yearTo:2025}),/重叠/);
 // Narrow the test job to 15 days without network calls.
 db.prepare('UPDATE journal_backfill_jobs SET to_date=? WHERE id=?').run('2025-01-16T00:00:00.000Z',b.id);
 changeBackfill(b.id,'start');
 const first=await workBackfillTick({maxPages:1,request:mockCrossref});
 assert.equal(first.status,'progress');assert.equal(first.added,1);
 assert.equal(getBackfill(b.id).status,'running');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM scan_windows WHERE journal_id=?').get('ageing-society').n,0);
 changeBackfill(b.id,'pause');
 assert.equal((await workBackfillTick({request:mockCrossref})).status,'idle');
 changeBackfill(b.id,'start');
 let done=false;
 for(let i=0;i<6;i++){const x=await workBackfillTick({maxPages:1,request:mockCrossref});if(x.status==='completed'){done=true;break;}}
 assert.ok(done,'job should complete after resuming');
 assert.equal(getBackfill(b.id).added_articles,3);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM articles WHERE source=?').get('crossref').n,3);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM articles WHERE notification_eligible=1').get().n,0);
 assert.equal(backfillSummary().items[0].status,'completed');
 assert.throws(()=>changeBackfill(b.id,'start'),/不能再次启动/);
});
test('bad scopes cannot silently activate unknown or unconfigured journals',()=>{
 assert.throws(()=>createBackfill({journalId:'candidate-1'}),/仅支持/);
 assert.throws(()=>createBackfill({journalId:'unknown'}),/仅支持/);
 assert.throws(()=>createBackfill({journalId:'ageing-society',yearFrom:2021,yearTo:2026}),/超过3年/);
});
test('failed fetch pauses but preserves operator resumability',async()=>{
 const b=createBackfill({journalId:'ageing-society',yearFrom:2024,yearTo:2024});
 db.prepare('UPDATE journal_backfill_jobs SET to_date=? WHERE id=?').run('2024-01-07T00:00:00.000Z',b.id);
 changeBackfill(b.id,'start');
 const x=await workBackfillTick({request:async()=>{throw Error('mock upstream outage')}});
 assert.equal(x.status,'paused');assert.match(getBackfill(b.id).error,/mock upstream outage/);
 changeBackfill(b.id,'start');assert.equal(getBackfill(b.id).status,'running');
});
