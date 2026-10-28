import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
process.env.DATABASE_PATH=path.join(os.tmpdir(),`fanscope-research-${process.pid}.sqlite`);process.env.SCAN_ON_START='false';process.env.ADMIN_KEY='offline-administrator-key-26chars';process.env.DEEPSEEK_API_KEY='mock-only';process.env.ALLOWED_ORIGINS='https://fanscope.pages.dev';
const {db}=await import('../src/db.mjs');const {insertArticle}=await import('../src/monitor.mjs');const {validateResearch,analyzePending}=await import('../src/ai.mjs');const {makeServer}=await import('../src/server.mjs');const {researchReport}=await import('../src/research.mjs');let server,base;
after(async()=>{if(server)await new Promise(r=>server.close(r));db.close();for(const ext of ['','-wal','-shm'])fs.rmSync(process.env.DATABASE_PATH+ext,{force:true});});
test('publication sorting, unknown dates, period/history/discovery views and production preflight',async()=>{
 for(const [id,date,online] of [['old','2016-01-02',''],['new','2026-10-20','2026-10-23'],['unknown','','']])insertArticle({id,journal_id:'jmir',market:'international',title:id,publication_date:date,published_online_date:online,topics:[]});
 server=makeServer();server.keepAliveTimeout=60000;await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
 const list=await (await fetch(base+'/api/articles')).json();assert.equal(list.total,1);assert.equal(list.items[0].id,'new');
 const all=await (await fetch(base+'/api/articles?period=all')).json();assert.equal(all.total,3);assert.equal(all.items[0].id,'new');assert.equal(all.items[2].id,'unknown');
 assert.equal((await (await fetch(base+'/api/articles?year=2016&period=all')).json()).total,1);
 const preflight=await fetch(base+'/api/lab/login',{method:'OPTIONS',headers:{Origin:'https://fanscope.pages.dev','Access-Control-Request-Method':'POST'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'https://fanscope.pages.dev');assert.ok(preflight.headers.get('Access-Control-Allow-Methods').includes('PATCH'));
});
test('20+20+2 independent candidates do not claim official rank verification',()=>{const all=db.prepare('SELECT * FROM journals').all();assert.ok(all.filter(j=>j.market==='chinese').length>=20);assert.ok(all.filter(j=>j.rank_system==='JCR_Q1').length>=20);assert.equal(all.filter(j=>j.watchlist_class==='high_relevance_non_Q1').length,2);assert.ok(all.every(j=>j.rank_verification_status==='pending'));});
test('structured AI rejects unsupported claims, invalid units and invented numerical evidence',()=>{
 const text='A cohort of 500 persons was followed using survival analysis.';
 const x=validateResearch({study_design:'cohort',sample_n:500,sample_unit:'person',statistical_methods:['survival','DID'],evidence:{study_design:{quote:'A cohort of 500 persons',confidence:.9},sample_n:{quote:'500 persons was followed',confidence:.9},sample_unit:{quote:'500 persons was followed',confidence:.9},'method:survival':{quote:'using survival analysis',confidence:.9},'method:DID':{quote:'invented quote',confidence:1}}},text);
 assert.equal(x.sample_n,500);assert.equal(x.study_design,'cohort');assert.deepEqual(x.statistical_methods,['survival']);assert.equal(x.country,null);assert.equal(x.extraction_scope,'abstract-only');assert.equal(validateResearch({sample_n:600,evidence:{sample_n:{quote:'500 persons was followed',confidence:1}}},text).sample_n,null);
});
test('failed AI item does not block next; retries and daily budget are recorded',async()=>{
 const orig=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{if(++calls===1)return new Response('failure',{status:503});return new Response(JSON.stringify({choices:[{message:{content:'{}'}}],usage:{total_tokens:30}}));};
 for(const id of ['ai-fail','ai-ok'])insertArticle({id,journal_id:'jmir',market:'international',title:id,abstract:'An abstract long enough to be analyzed. This is synthetic text for offline testing.',publication_date:'2026-10-24',topics:[]});
 try{const r=await analyzePending(2,{policy:'custom'});assert.equal(r.failed,1);assert.equal(r.analyzed,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM articles WHERE analysis_status='needs_retry'").get().n,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM articles WHERE analysis_status='insufficient_abstract'").get().n,3);}finally{globalThis.fetch=orig}
});
test('8/1590 does not produce global trend inference',()=>{db.prepare('DELETE FROM articles').run();const stmt=db.prepare("INSERT INTO articles(id,journal_id,market,title,publication_date,discovered_at,source,analysis_status,analysis_json) VALUES(?,'jmir','international','synthetic','2026-10-23',?,'manual',?,?)");for(let i=0;i<1590;i++)stmt.run(String(i),new Date().toISOString(),i<8?'analyzed':'pending',i<8?JSON.stringify({study_design:'unknown',data_source_type:'unknown',statistical_methods:[]}):null);const r=researchReport({period:'all'});assert.equal(r.n,1590);assert.equal(r.analyzed,8);assert.equal(r.evidenced,0);assert.equal(r.insufficient,true);assert.match(r.brief,/样本不足/);assert.deepEqual(r.samples,{});});
test('Research Brief refuses low coverage before any network request',async()=>{const {generateBrief}=await import('../src/brief.mjs');const orig=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not call')};try{const r=await generateBrief({period:'all'});assert.equal(r.status,'insufficient');assert.equal(calls,0)}finally{globalThis.fetch=orig}});

test('rank review separates CSSCI from JCR, requires official evidence and never enables a source',async()=>{
 const post=async b=>{const r=await fetch(base+'/api/admin/journal-review',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':process.env.ADMIN_KEY},body:JSON.stringify(b)});await r.arrayBuffer();return r.status};
 const j=db.prepare("SELECT * FROM journals WHERE market='international' AND enabled=0 LIMIT 1").get();
 assert.equal(await post({id:j.id,rank_system:'SJR_Q1',rank_year:'2025',rank_category:'Test category',rank_evidence_url:'https://scimagojr.com/test',manual_confirmation:true}),400);
 assert.equal(await post({id:j.id,rank_system:'JCR_Q1',rank_year:'2025',rank_category:'Synthetic operator review',rank_evidence_url:'https://jcr.clarivate.com/synthetic-test',manual_confirmation:true}),200);
 const reviewed=db.prepare('SELECT * FROM journals WHERE id=?').get(j.id);assert.equal(reviewed.rank_verification_status,'verified');assert.equal(reviewed.enabled,0);
});
