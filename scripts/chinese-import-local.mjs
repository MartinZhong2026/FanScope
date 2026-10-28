// No .env, workers, external requests, production DB, or access to the corpus as a writer.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(fs.existsSync(path.join(root,'api/.env')))throw Error('请先移开api/.env；本地授权导入不读取生产凭据');
const synthetic=process.argv.includes('--synthetic'),port=synthetic?4176:4175;
const folder=path.join(root,'work/chinese-authorized-import');fs.mkdirSync(folder,{recursive:true});
const database=path.join(folder,synthetic?'synthetic.sqlite':'local.sqlite');
if(!synthetic&&!fs.existsSync(database)){
 const source=path.join(root,'work/chinese-bulk/fanscope-chinese.sqlite');
 if(!fs.existsSync(source))throw Error('349条本地基线数据库不存在；不会自动连接其他数据库');
 const baseline=new DatabaseSync(source,{readOnly:true});
 try{if(baseline.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('基线完整性检查失败');baseline.prepare('VACUUM INTO ?').run(database);}finally{baseline.close();}
}
const adminKey=crypto.randomBytes(24).toString('hex');
Object.assign(process.env,{DATABASE_PATH:database,NODE_ENV:'development',CHINESE_AUTH_IMPORT_ENABLED:'true',CHINESE_IMPORT_SYNTHETIC:String(synthetic),ADMIN_KEY:adminKey,PORT:String(port),SCAN_ON_START:'false',AUTO_AI_ANALYSIS:'false',DEEPSEEK_API_KEY:'',RESEND_API_KEY:'',OPENALEX_API_KEY:'',OPENALEX_ENABLED:'false',ENABLE_PUBLIC_SUBSCRIPTIONS:'false',ALLOWED_ORIGINS:`http://127.0.0.1:${port}`,PUBLIC_API_URL:`http://127.0.0.1:${port}`,PUBLIC_FRONTEND_URL:`http://127.0.0.1:${port}`});
globalThis.fetch=async()=>{throw Error('授权导入工作台禁止对外请求');};
const {makeServer}=await import('../api/src/server.mjs');
const {db}=await import('../api/src/db.mjs');
const api=makeServer(),webRoot=path.join(root,'web');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.woff2':'font/woff2','.csv':'text/csv; charset=utf-8'};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  if(req.method!=='GET'&&req.method!=='OPTIONS'&&!url.pathname.startsWith('/api/admin/chinese-imports')){res.writeHead(403);res.end('Only staged imports are enabled');return;}
  return api.emit('request',req,res);
 }
 if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 if(url.pathname==='/config.js'){res.setHeader('Content-Type',types['.js']);res.end("window.FANSCOPE_CONFIG={API_BASE_URL:''};");return;}
 try{
  const name=decodeURIComponent(url.pathname==='/'?'/chinese-import.html':url.pathname);
  const file=path.resolve(webRoot,'.'+name),relative=path.relative(webRoot,file);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error();
  res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.setHeader('X-Content-Type-Options','nosniff');res.end(fs.readFileSync(file));
 }catch{res.writeHead(404);res.end('Not found');}
});
server.on('error',e=>{console.error(e.message);db.close();process.exit(1);});
server.listen(port,'127.0.0.1',()=>console.log(`FanScope ${synthetic?'合成验收':'真实授权数据'}工作区\nhttp://127.0.0.1:${port}/chinese-import.html\n数据库：${database}\n本次管理员密钥（仅本机使用）：${adminKey}\n无外部请求、无后台采集、无AI。Ctrl+C停止。`));
process.once('SIGINT',()=>server.close(()=>{db.close();process.exit(0);}));
