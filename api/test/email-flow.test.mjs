import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
process.env.DATABASE_PATH=path.join(os.tmpdir(),`fanscope-mailtest-${process.pid}.sqlite`);
process.env.SCAN_ON_START='false';
process.env.RESEND_API_KEY='mock-resend-key';
process.env.EMAIL_FROM='FanScope <test@example.org>';
process.env.PUBLIC_API_URL='https://fanscope-api.example.org';
process.env.ADMIN_KEY='this-is-a-super-long-secret-for-tests';
let sent=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 if(String(input)==='https://api.resend.com/emails'){
  sent.push(JSON.parse(init.body));
  return new Response(JSON.stringify({id:'mail-mock-id'}),{status:200,headers:{'Content-Type':'application/json'}});
 }
 return originalFetch(input,init);
};
const {db}=await import('../src/db.mjs');
const {makeServer}=await import('../src/server.mjs');
const {insertArticle}=await import('../src/monitor.mjs');
const {urgentDispatch}=await import('../src/mail.mjs');
let server;
after(async()=>{globalThis.fetch=originalFetch;if(server)await new Promise(r=>server.close(r));db.close();for(const x of ['','-wal','-shm'])try{fs.unlinkSync(process.env.DATABASE_PATH+x);}catch{}});
test('email verification, urgent deduplication, and confirmed unsubscribe',async()=>{
 server=makeServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 let signup=await originalFetch(base+'/api/subscriptions/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'professor@example.org',topics:['care'],markets:['international'],urgent:true,daily:false,weekly:false})});
 assert.equal(signup.status,200);assert.equal(sent.length,1);
 const url=sent[0].html.match(/https:\/\/fanscope-api\.example\.org\/api\/subscriptions\/confirm\?token=([^"<]+)/)?.[0];
 assert.ok(url,'verification URL embedded in real email template');
 const t=new URL(url).searchParams.get('token');
 const confirm=await originalFetch(base+'/api/subscriptions/confirm?token='+t);assert.equal(confirm.status,200);
 assert.equal(db.prepare('SELECT confirmed FROM subscribers WHERE email=?').get('professor@example.org').confirmed,1);
 const paper={id:'doi:10.4321/real-test',journal_id:'ageing-society',market:'international',title:'Dementia caregiving social support',url:'https://doi.org/10.4321/real-test',publication_date:'2026-10-24',topics:['care'],matched:true};
 assert.equal(insertArticle(paper),true);
 const first=await urgentDispatch([paper.id]);assert.equal(first.sent,1);assert.equal(sent.length,2);
 const second=await urgentDispatch([paper.id]);assert.equal(second.sent,0);assert.equal(sent.length,2);
 const unsubToken=sent[1].html.match(/unsubscribe\?token=([^"<]+)/)?.[1];assert.ok(unsubToken);
 const unsubGet=await originalFetch(base+'/api/subscriptions/unsubscribe?token='+unsubToken);assert.equal(unsubGet.status,200);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscribers').get().n,1,'GET not directly destructive');
 const unsubPost=await originalFetch(base+'/api/subscriptions/unsubscribe?token='+unsubToken,{method:'POST'});assert.equal(unsubPost.status,200);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscribers').get().n,0);
});
test('historical and initial backfill is excluded from scheduled new-publication digests',async()=>{
 const {scheduledDigest}=await import('../src/mail.mjs');
 db.prepare('INSERT INTO subscribers(id,email,topics,markets,urgent,daily,confirmed,created_at) VALUES(?,?,?,?,?,?,?,?)').run('digest-test','digest@example.org','[]','["international"]',0,1,1,new Date().toISOString());
 insertArticle({id:'old-backfill',journal_id:'jmir',market:'international',title:'Old reindexed paper',publication_date:'2016-01-01',scan_mode:'backfill',topics:[]});
 insertArticle({id:'initial-new',journal_id:'jmir',market:'international',title:'Initial recent paper',publication_date:new Date().toISOString().slice(0,10),scan_mode:'backfill',topics:[]});
 const before=sent.length;assert.equal((await scheduledDigest()).sent,0);assert.equal(sent.length,before);
 insertArticle({id:'incremental-new',journal_id:'jmir',market:'international',title:'Actually new incremental paper',publication_date:new Date().toISOString().slice(0,10),scan_mode:'incremental',topics:[]});
 db.prepare("UPDATE subscribers SET last_daily=NULL WHERE id='digest-test'").run();assert.equal((await scheduledDigest()).sent,1);assert.equal(sent.length,before+1);assert.ok(sent.at(-1).html.includes('Actually new incremental paper'));assert.ok(!sent.at(-1).html.includes('Old reindexed paper'));assert.ok(!sent.at(-1).html.includes('Initial recent paper'));
});
