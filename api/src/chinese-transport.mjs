// Shared transport budget for a single operator invocation, not another importer.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {secureFeed,approvedURL} from './rss-security.mjs';

export function chineseTransport({maxRequests=800,minIntervalMs=1200,maxRetries=2,maxWaitMs=30000,logFile,fetcher=fetch,readFeed=secureFeed,sleep=ms=>new Promise(r=>setTimeout(r,ms)),clock=Date.now}={}){
 if(!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>10000||minIntervalMs<1000||minIntervalMs>60000||!Number.isInteger(maxRetries)||maxRetries<0||maxRetries>3)throw Error('Invalid request budget/rate');
 let requests=0,last=0,inflight=false;
 const record=o=>{if(logFile)fs.appendFileSync(logFile,JSON.stringify({...o,at:new Date().toISOString()})+'\n');};
 async function request(url,hosts,json){
  if(inflight)throw Error('Chinese transport concurrency limit is 1');
  const u=new URL(url);approvedURL(u.href,json?['api.crossref.org','api.openalex.org']:hosts);
  if(json&&!/^\/(?:journals|sources|works)(?:\/|$)/.test(u.pathname))throw Error('Unapproved metadata API path');
  inflight=true;
  try{for(let attempt=0;;attempt++){
   if(requests>=maxRequests)throw Error('Collection request budget exhausted');
   await sleep(Math.max(0,last+minIntervalMs-clock()));last=clock();requests++;
   try{
    let body;
    if(json){const r=await fetcher(u,{headers:{'User-Agent':'FanScope-Metadata/1.3 (bounded public metadata retrieval)',Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(20000)});
     if(!r.ok){const e=Error('HTTP '+r.status);e.status=r.status;const retry=r.headers.get('retry-after');e.retryMs=retry?(Number.isFinite(Number(retry))?Number(retry)*1000:Date.parse(retry)-clock()):0;await r.body?.cancel();throw e;}
     // Bound response size even when Content-Length is absent.
     let bytes=0;const chunks=[];for await(const chunk of r.body){bytes+=chunk.length;if(bytes>8000000)throw Error('Metadata API response exceeds 8MB');chunks.push(chunk);}body=Buffer.concat(chunks).toString('utf8');
    }else body=await readFeed(u.href,hosts);
    if(/Please enable JavaScript|captcha|验证码|TOKEN无效|Access Denied/i.test(body))throw Error('Source requires authentication or anti-bot verification; stopped');
    record({url:u.href,attempt,request:requests,status:'ok',sha256:crypto.createHash('sha256').update(body).digest('hex'),bytes:Buffer.byteLength(body)});
    return json?JSON.parse(body):body;
   }catch(e){record({url:u.href,attempt,request:requests,status:e.status||'error',error:e.message,cause:e.cause?.code});
    const retry=e.status===429||e.status>=500||/HTTP (429|5\d\d)|timeout|ECONNRESET|ENOTFOUND|UND_ERR_/i.test(e.message+' '+(e.cause?.code||''));
    const wait=Math.max(1500*2**attempt,e.retryMs||0);
    if(!retry||attempt>=maxRetries){if(retry)e.retryAt=new Date(clock()+wait).toISOString();throw e;}
    if(wait>maxWaitMs)throw Object.assign(Error('Server Retry-After exceeds invocation wait budget; source paused'),{retryAt:new Date(clock()+wait).toISOString()});await sleep(wait);
   }
  }}finally{inflight=false;}
 }
 return {json:url=>request(url,[],true),read:(url,hosts)=>request(url,hosts,false),get requests(){return requests;},maxRequests};
}
