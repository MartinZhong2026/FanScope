// Scan only the public artifact, never read host credentials or private env files.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
export function verifyPagesRelease(folder){
 const files=fs.readdirSync(folder,{recursive:true}).filter(f=>fs.statSync(path.join(folder,f)).isFile()),assets=[];
 for(const file of files){
  const relative=file.replaceAll('\\','/');
  if(/(?:^|\/)(?:\.[^/]+|work|data|node_modules|private_inputs|lab-documents|import-templates)(?:\/|$)|chinese-import\.|\.(?:sqlite(?:-[a-z]+)?|db|csv|pem|key|env|tar|zip|map)$/i.test(relative))throw Error('Forbidden public artifact: '+relative);
  const data=fs.readFileSync(path.join(folder,file));
  if(!/\.(?:png|woff2)$/i.test(relative)){
   const text=data.toString('utf8');
   if(/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|\b(?:sk-|re_)[A-Za-z0-9]{24,}|(?:ADMIN_KEY|DEEPSEEK_API_KEY|CLOUDFLARE_API_TOKEN)\s*[:=]\s*['"][^'"]{16,}/.test(text))throw Error('Credential pattern in public asset: '+relative);
   if(/href=["']chinese-import\.html/.test(text))throw Error('Local workbench link in public asset');
  }
  assets.push({file:relative,sha256:crypto.createHash('sha256').update(data).digest('hex')});
 }
 for(const required of ['index.html','config.js','app.js','chinese-quality.mjs','chinese-diagnostics.mjs','404.html'])if(!files.includes(required))throw Error('Missing public asset: '+required);
 const app=fs.readFileSync(path.join(folder,'app.js'),'utf8');if(!app.includes('chinesePanel(edit=false){edit=false;'))throw Error('Chinese management controls are not read-only');
 return {passed:true,assets};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const folder=process.argv[2];if(!folder)throw Error('Artifact directory required');console.log(JSON.stringify(verifyPagesRelease(folder)));}
