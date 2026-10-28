// Read-only public metadata evidence. Never opens the application database.
// node --use-env-proxy scripts/audit-journals.mjs work/source-audit
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.resolve(process.argv[2]||'work/source-audit');fs.mkdirSync(out,{recursive:true});
const journals=JSON.parse(fs.readFileSync(path.join(root,'api/config/journals.json')));
// These are discovery inputs, NOT verified configuration or activation.
const candidates=['2399-5300','2561-7605','1471-2318','2666-7568','2352-8273','1353-8292','0141-9889','1475-9276','0047-2794','0144-5596','0045-3102','0037-8046','0022-2445','0968-7599','2817-1705','0268-1080','1360-7863'];
const leads={
 'soc-security-cn':'https://sbpl.cbpt.cnki.net/journal/portal/sbpl/client/index',
 'soc-review-cn':'https://src.ruc.edu.cn/CN/home',
 'public-admin-cn':'https://gogl.cbpt.cnki.net/portal',
 'candidate-1':'https://rkyj.ruc.edu.cn/CN/rss_dqml_1000-6087.xml',
 'candidate-2':'https://www.ncpssd.org/journal/details.aspx?gch=97725X&langType=1&nav=1',
 'candidate-3':'https://ncpssd.org/journal/details?gch=95683X',
 'candidate-4':'https://hssra.jlu.edu.cn/xsqk/rkxk.htm',
 'candidate-5':'https://ccj.pku.edu.cn/journal/info?jid=99049&viid=15872092',
 'candidate-6':'https://shxyj.ajcass.com/',
 'candidate-7':'https://www.society.shu.edu.cn/CN/rss_dqml_1004-8804.xml',
 'candidate-9':'https://ncpssd.org/journal/details?gch=72041X&langType=1&num=2&years=2024',
 'candidate-10':'https://shjs.ruc.edu.cn/',
 'candidate-11':'https://www.ncpssd.cn/journal/details?gch=82596X',
 'candidate-12':'https://www.ncpssd.cn/journal/details?gch=71362X',
 'candidate-14':'https://gggl.cbpt.cnki.net/portal/journal/portal/client/advSearchResult',
 'candidate-16':'https://ggglyzc.ruc.edu.cn/CN/rss/showRssInfo.do',
 'candidate-17':'https://www.cpaj.com.cn/',
 'candidate-18':'https://www.cqvip.com/journal/80561A/80561A',
 'candidate-19':'https://www.las.cas.cn/qk/202112/t20211202_6286197.html',
 'candidate-20':'https://www.cssm.com.cn/zgrkx/home'
};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function read(url){
 for(let attempt=0;attempt<3;attempt++){
  try{const r=await fetch(url,{headers:{'User-Agent':'FanScope source verification/1.0',Accept:'application/json,application/xml,text/html'},signal:AbortSignal.timeout(20000),redirect:'manual'});
   if((r.status===429||r.status>=500)&&attempt<2){await wait(1000*2**attempt);continue;}
   const body=await r.text();return {url,at:new Date().toISOString(),status:r.status,contentType:r.headers.get('content-type'),location:r.headers.get('location'),body:body.slice(0,2000000)};
  }catch(e){if(attempt===2)return {url,at:new Date().toISOString(),error:String(e.message),cause:e.cause?.code};await wait(1000*2**attempt);}
 }
}
const results=[];let index=0;
for(const j of journals){
 const file=path.join(out,j.id+'.json');
 if(fs.existsSync(file)){results.push(JSON.parse(fs.readFileSync(file)));if(j.market==='international'&&!j.issn)index++;continue;}
 let evidence;
 if(j.market==='international'){
  const issn=j.issn||candidates[index++];
  const registry=await read('https://api.crossref.org/journals/'+issn);await wait(500);
  const until=new Date().toISOString().slice(0,10);
  const params=new URLSearchParams({filter:`type:journal-article,from-pub-date:2025-01-01,until-pub-date:${until}`,rows:'5',sort:'published',order:'desc'});
  const sample=await read(`https://api.crossref.org/journals/${issn}/works?${params}`);
  evidence={id:j.id,title:j.title,issn,registry,sample};
 }else evidence={id:j.id,title:j.title,issn:j.issn||null,lead:await read(leads[j.id]),priorEvidence:'docs/CHINESE-JOURNAL-SOURCES.md; lead only, no permission for bulk HTML collection'};
 fs.writeFileSync(file,JSON.stringify(evidence,null,2)+'\n');results.push(evidence);
 console.log(j.id,evidence.registry?.status||evidence.lead?.status||evidence.lead?.error);
 await wait(500);
}
fs.writeFileSync(path.join(out,'index.json'),JSON.stringify({generatedAt:new Date().toISOString(),journals:results.map(({id,title,issn,registry,sample,lead})=>({id,title,issn,registryStatus:registry?.status,sampleStatus:sample?.status,leadStatus:lead?.status,error:lead?.error||registry?.error}))},null,2)+'\n');
