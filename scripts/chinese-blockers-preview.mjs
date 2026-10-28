// Local QA only: clone the corpus; never open the original with the app writer.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import crypto from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');if(fs.existsSync(path.join(root,'api/.env')))throw Error('Refusing production credentials');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'work/release-readiness/pages-manifest.json'),'utf8')),webRoot=path.resolve(root,manifest.folder);
if(!webRoot.startsWith(path.join(root,'work/release-readiness')+path.sep))throw Error('Only a local release artifact is accepted');
const dir=fs.mkdtempSync(path.join(root,'work/release-readiness/blocker-preview-')),copy=path.join(dir,'preview.sqlite');
const source=new DatabaseSync(path.join(root,'work/chinese-bulk/fanscope-chinese.sqlite'),{readOnly:true});source.prepare('VACUUM INTO ?').run(copy);source.close();
Object.assign(process.env,{DATABASE_PATH:copy,NODE_ENV:'production',SCAN_ON_START:'false',CHINESE_AUTH_IMPORT_ENABLED:'false',ADMIN_KEY:crypto.randomBytes(32).toString('hex'),DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:'',OPENALEX_ENABLED:'false',ENABLE_PUBLIC_SUBSCRIPTIONS:'false',ALLOWED_ORIGINS:'http://127.0.0.1:4177'});
globalThis.fetch=async()=>{throw Error('No outbound in QA');};
const {db}=await import('../api/src/db.mjs');const {makeServer}=await import('../api/src/server.mjs');
// Explicitly exercise collected metadata WITHOUT an automatic connection in this QA copy only.
db.prepare("DELETE FROM meta WHERE key LIKE 'cn-source:%'").run();
const api=makeServer({readOnly:true}),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/'))return api.emit('request',req,res);
 if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 if(url.pathname==='/config.js'){res.setHeader('Content-Type',types['.js']);res.end("window.FANSCOPE_CONFIG={API_BASE_URL:''};");return;}
 try{const file=path.resolve(webRoot,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(webRoot+path.sep)||!fs.existsSync(file))throw Error();res.setHeader('Content-Type',types[path.extname(file)]||'text/plain');res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end('Not found');}
});
server.listen(4177,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:4177',qaCopy:copy,workbench:false,production:false})));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>{db.close();process.exit(0);}));
