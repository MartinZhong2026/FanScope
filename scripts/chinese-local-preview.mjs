// Read-only browser transport over the dedicated local collection database.
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dbFile=path.resolve(root,process.argv[2]||'work/chinese-bulk/fanscope-chinese.sqlite');
if(!dbFile.startsWith(path.join(root,'work')+path.sep)||!dbFile.endsWith('.sqlite')||!fs.existsSync(dbFile))throw Error('An existing isolated .sqlite under work/ is required');
if(fs.existsSync(path.join(root,'api/.env')))throw Error('Refusing to load api/.env in an isolated preview');
Object.assign(process.env,{DATABASE_PATH:dbFile,NODE_ENV:'development',PORT:'8788',SCAN_ON_START:'false',AUTO_AI_ANALYSIS:'false',MAX_AI_PER_SCAN:'0',DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:'',OPENALEX_ENABLED:'false',ADMIN_KEY:crypto.randomBytes(32).toString('hex'),PUBLIC_FRONTEND_URL:'http://127.0.0.1:4174',PUBLIC_API_URL:'http://127.0.0.1:8788',ALLOWED_ORIGINS:'http://127.0.0.1:4174,http://localhost:4174',ENABLE_PUBLIC_SUBSCRIPTIONS:'false'});
globalThis.fetch=async()=>{throw Error('Outbound requests are disabled in local preview');};
const {makeServer}=await import('../api/src/server.mjs');const {db}=await import('../api/src/db.mjs');
const api=makeServer(),webRoot=path.join(root,'web');
// Restrict preview to reads even when someone guesses an admin route.
api.prependListener('request',req=>{if(!['GET','OPTIONS'].includes(req.method))req.url='/preview-read-only';});
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.woff2':'font/woff2'};
const web=http.createServer((req,res)=>{
 if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 try{let p=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(p==='/config.js'){res.setHeader('Content-Type',types['.js']);res.end("window.FANSCOPE_CONFIG={API_BASE_URL:'http://127.0.0.1:8788'};");return;}
  if(p.endsWith('/'))p+='index.html';const target=path.resolve(webRoot,'.'+p),relative=path.relative(webRoot,target);
  if(relative.startsWith('..')||path.isAbsolute(relative)){res.writeHead(403);res.end();return;}
  const content=fs.readFileSync(target);res.setHeader('Content-Type',types[path.extname(target)]||'application/octet-stream');res.end(content);
 }catch{res.writeHead(404);res.end('Not found');}
});
for(const s of [api,web])s.on('error',error=>{console.error(error.message);process.exit(1);});
api.listen(8788,'127.0.0.1');web.listen(4174,'127.0.0.1',()=>console.log('FanScope Chinese corpus: http://127.0.0.1:4174/?page=feed&market=chinese&period=all\nLocal metadata only; no outbound API or background workers. Ctrl+C stops.'));
process.once('SIGINT',()=>{web.close();api.close(()=>{db.close();process.exit(0);});});
