import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..');
if(!process.env.DATABASE_PATH)throw Error('Set DATABASE_PATH to an isolated synthetic acceptance database');
process.env.ADMIN_KEY='qa-only-admin-key-12345678901234567890';process.env.SCAN_ON_START='false';process.env.AUTO_AI_ANALYSIS='false';process.env.DEEPSEEK_API_KEY='mock-only';process.env.AI_INPUT_CNY_PER_M_TOKENS='1';process.env.AI_OUTPUT_CNY_PER_M_TOKENS='4';
const {db}=await import('../src/db.mjs');const {createUser}=await import('../src/lab.mjs');const {insertArticle}=await import('../src/monitor.mjs');const {analysisFingerprint}=await import('../src/ai.mjs');const {makeServer}=await import('../src/server.mjs');
if(!db.prepare('SELECT 1 FROM lab_users LIMIT 1').get()){
createUser({name:'QA 测试导师',email:'qa@example.org',role:'mentor',password:'Acceptance-only-password'});
for(let i=0;i<40;i++){
 const a={id:'qa-browser-'+i,journal_id:'jmir',market:'international',title:'[合成验收数据] Caregiving cohort study '+i,doi:'10.9999/browser-qa-'+i,abstract:'Synthetic abstract only. A cohort of 500 persons was followed using survival analysis. 本条为测试数据，不代表真实论文。',publication_date:`2025-${String(i%12+1).padStart(2,'0')}-15`,source:'manual',topics:['care'],matched:true};insertArticle(a);
 const actual=db.prepare('SELECT * FROM articles WHERE doi=?').get(a.doi);
 if(i<20)db.prepare("UPDATE articles SET analysis_status='analyzed',analysis_json=?,analysis_input_hash=?,design='cohort',method='survival',sample_n=500,sample_unit='person' WHERE id=?").run(JSON.stringify({study_design:'cohort',statistical_methods:['survival'],data_source_type:'secondary_public',sample_n:500,sample_unit:'person',extraction_scope:'abstract-only',provider:'mock-only',evidence:{sample_n:{quote:'500 persons',confidence:0.9}}}),analysisFingerprint(actual),actual.id);
}}
globalThis.fetch=async url=>{
 const u=new URL(url);
 if(u.hostname==='api.deepseek.com')return new Response(JSON.stringify({choices:[{message:{content:'{}'}}],usage:{prompt_tokens:900,completion_tokens:220}}));
 if(u.hostname==='api.crossref.org'){
  // Deliberately foreign venue prevents accidental source activation in browser QA.
  return new Response(JSON.stringify({message:{items:[{DOI:'10.9999/mock-other',ISSN:['1471-2318'],type:'journal-article','container-title':['Mock unrelated venue']}],'total-results':1}}));
 }
 throw Error('QA blocks unexpected external request');
};
makeServer().listen(8787,'127.0.0.1');
http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/config.js'){res.setHeader('Content-Type','text/javascript');res.end("window.FANSCOPE_CONFIG={API_BASE_URL:'http://127.0.0.1:8787'};");return;}
 let rel=decodeURIComponent(url.pathname);if(rel.endsWith('/'))rel+='index.html';const f=path.resolve(root+'/web','.'+rel);
 if(!f.startsWith(root+'/web/')){res.writeHead(403);res.end();return;}
 try{res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(f)]||'application/octet-stream');res.end(fs.readFileSync(f))}catch{res.writeHead(404);res.end('Not found')}
}).listen(4173,'127.0.0.1',()=>console.log('QA web+API ready, isolated database and mock outbound APIs'));
