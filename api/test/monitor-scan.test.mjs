import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
process.env.DATABASE_PATH=path.join(os.tmpdir(),`fanscope-scan-${process.pid}.sqlite`);
process.env.SCAN_ON_START='false';
const originalFetch=globalThis.fetch;
let calls=0;
globalThis.fetch=async(input)=>{
 calls++;
 const issn=String(input).match(/\/journals\/([^/]+)\/works/)?.[1]||'unknown';
 return new Response(JSON.stringify({message:{items:[{DOI:`10.9999/${issn.toLowerCase()}`,title:['Dementia and caregiver burden 2026'],type:'journal-article',published:{'date-parts':[[2026,10,24]]},author:[{given:'Test',family:'Scholar'}],abstract:'This study assesses informal caregiving and health among older adults using an example survey.'}]}}),{status:200,headers:{'Content-Type':'application/json'}});
};
const {db}=await import('../src/db.mjs');
const {scanAll}=await import('../src/monitor.mjs');
after(()=>{globalThis.fetch=originalFetch;db.close();for(const x of ['','-wal','-shm'])try{fs.unlinkSync(process.env.DATABASE_PATH+x);}catch{}});
test('first Crossref scan inserts once and records journal health; repeat has zero new',async()=>{
 const first=await scanAll({lookbackDays:1});assert.equal(first.errors.length,0);assert.equal(first.scanned,5);assert.equal(first.newCount,5);
 const rows=db.prepare('SELECT * FROM articles').all();assert.equal(rows.length,5);assert.ok(rows.every(x=>x.matched===1));
 const journals=db.prepare("SELECT * FROM journals WHERE market='international' AND enabled=1").all();assert.ok(journals.every(j=>j.last_success&&j.checkpoint));
 const second=await scanAll();assert.equal(second.newCount,0);assert.equal(second.errors.length,0);assert.equal(calls,20);
});
