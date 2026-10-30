// Paper Diagnostic browser acceptance only. NEW database under work/, rule
// engine (no AI), every outbound request blocked, real Pages CSP applied.
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
const dbPath=process.env.DATABASE_PATH;
// CI uses the standard fixture ports; local runs may override to avoid clashes.
const WEB_PORT=Number(process.env.DX_WEB_PORT||4173),API_PORT=Number(process.env.DX_API_PORT||8787);
if(!dbPath||!dbPath.replace(/\\/g,'/').includes('/work/')||fs.existsSync(dbPath))throw Error('Use a NEW database under work/ for diagnostic browser acceptance');
Object.assign(process.env,{SCAN_ON_START:'false',DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:'',ADMIN_KEY:'qa-only-admin-key-12345678901234567890',
 ALLOWED_ORIGINS:`http://127.0.0.1:${WEB_PORT}`,FANSCOPE_DIAGNOSTIC_ENABLED:'true',FANSCOPE_DIAGNOSTIC_PROVIDER:'rules'});
globalThis.fetch=async url=>{throw Error('Diagnostic acceptance blocks outbound request: '+new URL(url).hostname)};
const root=path.resolve(import.meta.dirname,'../..'),webRoot=path.join(root,'web');
const {createUser}=await import('../src/lab.mjs');const {makeServer}=await import('../src/server.mjs');
const password='Diagnostic-acceptance-only';
for(const [name,email,role] of [['验收学生','student@dx.test','member'],['验收同学','peer@dx.test','member'],['验收导师','mentor@dx.test','mentor']])createUser({name,email,role,password});
// Pages _headers rules, with the production API origin swapped for the local fixture.
const rules=[];let current=null;
for(const line of fs.readFileSync(path.join(webRoot,'_headers'),'utf8').split(/\r?\n/)){
 if(!line.trim())continue;
 if(!/^\s/.test(line)){current={pattern:new RegExp('^'+line.trim().replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*')+'$'),headers:[]};rules.push(current);continue}
 const i=line.indexOf(':');current.headers.push([line.slice(0,i).trim(),line.slice(i+1).trim().replace('https://fanscope-api.adapttochina.com',`http://127.0.0.1:${API_PORT}`)]);
}
makeServer().listen(API_PORT,'127.0.0.1');
http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 for(const r of rules)if(r.pattern.test(url.pathname))for(const [k,v] of r.headers)res.setHeader(k,v);
 if(url.pathname==='/config.js'){res.setHeader('Content-Type','text/javascript');res.end(`window.FANSCOPE_CONFIG={API_BASE_URL:'http://127.0.0.1:${API_PORT}'};`);return}
 let rel=decodeURIComponent(url.pathname);if(rel.endsWith('/'))rel+='index.html';const f=path.resolve(webRoot,'.'+rel);
 if(!f.startsWith(webRoot+path.sep)){res.writeHead(403);res.end();return}
 try{res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(f)]||'application/octet-stream');res.end(fs.readFileSync(f))}catch{res.writeHead(404);res.end('Not found')}
}).listen(WEB_PORT,'127.0.0.1',()=>console.log('Diagnostic acceptance web+API ready (rule engine, outbound blocked)'));
