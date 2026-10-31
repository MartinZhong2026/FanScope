// Chinese publisher abstracts are kept in the database but withheld from public output
// unless the owner enables them. English articles are unaffected.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-vis-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_PATH:path.join(dir,'t.sqlite'),DEEPSEEK_API_KEY:'',FANSCOPE_LOG_DIR:path.join(dir,'logs'),FANSCOPE_LOG_LEVEL:'error'});
delete process.env.FANSCOPE_CN_ABSTRACTS_PUBLIC;
const {db}=await import('../src/db.mjs');
const {makeServer}=await import('../src/server.mjs');
const server=makeServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200})});
const ABS='这是出版社网站上的完整摘要文字，用于验证默认不会通过公开接口输出，长度需要足够。'.repeat(2);
const insert=(id,market,journal)=>db.prepare("INSERT INTO articles(id,journal_id,market,title,url,authors,abstract,publication_date,discovered_at,source,topics,matched,analysis_status,demo,abstract_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,'available')").run(id,journal,market,'标题 '+id,'https://example.invalid/'+id,'甲',ABS,'2026-01-01','2026-01-02','test','[]',0,'pending');
insert('cn1','chinese','candidate-1');insert('en1','international','jmir');
const list=async q=>(await(await fetch(`${base}/api/articles?period=all&limit=50${q}`)).json()).items;

test('default: Chinese abstract is withheld in the list, with title, authors, date and link kept',async()=>{
 const [a]=(await list('&market=chinese')).filter(x=>x.id==='cn1');
 assert.equal(a.abstract,'');assert.equal(a.abstract_status,'withheld');assert.equal(a.ai_summary??null,null);
 assert.equal(a.title,'标题 cn1');assert.equal(a.authors,'甲');assert.equal(a.publication_date,'2026-01-01');assert.ok(a.url);
 assert.ok(!JSON.stringify(a).includes('出版社网站上的完整摘要'),'no abstract text anywhere in the payload');
});
test('English abstracts are unchanged',async()=>{
 const a=(await list('&market=international')).find(x=>x.id==='en1');
 assert.equal(a.abstract,ABS);assert.equal(a.abstract_status,'available');
});
test('the stored abstract is kept in the database',()=>{
 assert.equal(db.prepare("SELECT abstract FROM articles WHERE id='cn1'").get().abstract,ABS);
});
test('owner switch shows Chinese abstracts again',async()=>{
 process.env.FANSCOPE_CN_ABSTRACTS_PUBLIC='true';
 try{assert.equal((await list('&market=chinese')).find(x=>x.id==='cn1').abstract,ABS)}finally{delete process.env.FANSCOPE_CN_ABSTRACTS_PUBLIC}
});
