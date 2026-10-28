import test,{after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
process.env.DATABASE_PATH=path.join(os.tmpdir(),`fanscope-openalex-${process.pid}.sqlite`);
const {db}=await import('../src/db.mjs');const {insertArticle}=await import('../src/monitor.mjs');const {enrichOpenAlex}=await import('../src/openalex.mjs');const original=globalThis.fetch;
after(()=>{globalThis.fetch=original;db.close();for(const ext of ['','-wal','-shm'])fs.rmSync(process.env.DATABASE_PATH+ext,{force:true})});
test('OpenAlex is disabled without approved plan/key, matches DOI+ISSN and caches supplement',async()=>{
 assert.equal((await enrichOpenAlex()).status,'disabled');process.env.OPENALEX_ENABLED='true';process.env.OPENALEX_API_KEY='offline-openalex-key';
 const j=db.prepare("SELECT * FROM journals WHERE id='jmir'").get(),date=new Date().toISOString().slice(0,10);insertArticle({id:'doi:10.9999/supplement',doi:'10.9999/supplement',journal_id:j.id,market:j.market,title:'Synthetic supplement',publication_date:date,topics:[]});
 let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({doi:'https://doi.org/10.9999/supplement',primary_location:{landing_page_url:'https://www.jmir.org/2026/1/e123',source:{issn:[j.issn],homepage_url:'https://www.jmir.org/'}},abstract_inverted_index:{'Synthetic':[0],'evidence':[1]}}));};
 const r=await enrichOpenAlex();assert.equal(r.enriched,1);assert.equal(db.prepare('SELECT publisher_landing_url FROM articles').get().publisher_landing_url,'https://www.jmir.org/2026/1/e123');db.prepare("UPDATE articles SET abstract='',publisher_landing_url=''").run();await enrichOpenAlex();assert.equal(calls,1,'cached response reused');
 db.prepare('DELETE FROM provider_cache').run();db.prepare("UPDATE articles SET abstract='',publisher_landing_url=''").run();globalThis.fetch=async()=>new Response(JSON.stringify({doi:'https://doi.org/10.9999/wrong',primary_location:{source:{issn:[j.issn]}}}));assert.equal((await enrichOpenAlex()).failed,1);
});
