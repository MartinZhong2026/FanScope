import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATABASE_PATH=path.join(os.tmpdir(),`fanscope-test-${process.pid}.sqlite`);
process.env.SCAN_ON_START='false';
process.env.ADMIN_KEY='abcdefghijklmnopqrstuvwxyz9876543210';
const {classify,canonicalDoi,parseFeed,crossrefToArticle}=await import('../src/sources.mjs');
const {db}=await import('../src/db.mjs');
const {makeServer}=await import('../src/server.mjs');
const {validateAnalysis}=await import('../src/ai.mjs');
const {insertArticle}=await import('../src/monitor.mjs');
let server;after(async()=>{if(server)await new Promise(ok=>server.close(ok));db.close();for(const ext of ['','-wal','-shm'])try{fs.unlinkSync(process.env.DATABASE_PATH+ext);}catch{}});
test('research topic classification from title and abstract',()=>{
 assert.deepEqual(classify('Dementia caregivers and AI-assisted care'),['care','ai']);
 assert.deepEqual(classify('2026年极端高温与老年人健康不平等'),['climate','poverty']);
});
test('DOI normalization and Crossref fields',()=>{
 const d=crossrefToArticle({DOI:'https://doi.org/10.1000/ABC',title:['Caregiving and inequality'],type:'journal-article',published:{'date-parts':[[2026,9,6]]},author:[{given:'Mary',family:'Smith'}]}, {id:'gerontologist',market:'international'});
 assert.equal(d.id,'doi:10.1000/abc');assert.equal(d.publication_date,'2026-09-06');assert.equal(d.authors,'Mary Smith');
 assert.equal(canonicalDoi('https://doi.org/10.1234/XYZ'),'10.1234/xyz');
});
test('RSS only accepts articles with valid URL',()=>{
 const xml='<rss><channel><item><title>智能养老最新研究</title><link>https://example.org/article1</link><pubDate>Thu, 15 Oct 2026 08:00:00 GMT</pubDate></item><item><title>Bad</title><link>javascript:alert(1)</link></item></channel></rss>';
 const items=parseFeed(xml,{id:'cn',market:'chinese'});assert.equal(items.length,1);assert.ok(items[0].topics.includes('ai'));assert.equal(items[0].publication_date,'2026-10-15');
});
test('AI cannot claim sample size without verbatim evidence',()=>{
 assert.equal(validateAnalysis({sample_n:500, evidence:'imagined evidence'},'This abstract says nothing about participants.').sample_n,null);
 assert.equal(validateAnalysis({sample_n:500,evidence:'500 participants'},'We included 500 participants.').sample_n,500);
});
test('duplicate paper insert is idempotent',()=>{
 const a={id:'doi:10.1234/example',journal_id:'ageing-society',market:'international',title:'A sample paper',url:'https://doi.org/10.1234/example',publication_date:'2026-10-01',topics:['care'],matched:true};
 assert.equal(insertArticle(a),true);assert.equal(insertArticle(a),false);
});
test('public health and articles, admin protection, subscribe disabled',async()=>{
 server=makeServer();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const base=`http://127.0.0.1:${server.address().port}`;
 const health=await (await fetch(base+'/api/health')).json();assert.equal(health.status,'ok');
 const r=await (await fetch(base+'/api/articles?market=international')).json();assert.equal(r.total,1);
 const unauthorized=await fetch(base+'/api/admin/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unauthorized.status,401);
 const noMail=await fetch(base+'/api/subscriptions/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'test@example.com'})});assert.equal(noMail.status,503);
 const badOrigin=await fetch(base+'/api/health',{headers:{Origin:'https://evil.example'}});assert.equal(badOrigin.headers.get('Access-Control-Allow-Origin'),null);
});
