import fs from 'node:fs';
import {scanAll} from './monitor.mjs';
import {scheduledDigest} from './mail.mjs';
import {db} from './db.mjs';
import {classify,canonicalDoi} from './sources.mjs';
import {insertArticle} from './monitor.mjs';
import crypto from 'node:crypto';
const [command,...rest]=process.argv.slice(2);
if(command==='scan'){
 const backfill=rest.includes('--backfill'),days=Math.max(1,Math.min(180,Number(rest.find(x=>x.startsWith('--days='))?.slice(7)||30)));
 console.log(JSON.stringify(await scanAll({backfill,lookbackDays:days}),null,2));
}else if(command==='digest'){
 console.log(JSON.stringify(await scheduledDigest(rest.includes('--weekly')?'weekly':'daily')));
}else if(command==='import'){
 const path=rest[0];if(!path){console.error('Usage: npm run import -- ./papers.json');process.exitCode=1;}
 else{const arr=JSON.parse(fs.readFileSync(path,'utf8'));if(!Array.isArray(arr))throw Error('Expected JSON array');let added=0;
  for(const a of arr){const j=db.prepare('SELECT * FROM journals WHERE id=?').get(String(a.journal_id||''));if(!j||j.market!=='chinese')continue;
   const doi=canonicalDoi(a.doi),url=String(a.url||''),title=String(a.title||'').slice(0,350);if(!/^https?:\/\//.test(url)||!title)continue;
   const ts=classify(title,a.abstract||'');const id=doi?`doi:${doi}`:`manual:${j.id}:${crypto.createHash('sha256').update(url).digest('hex').slice(0,24)}`;
   added+=insertArticle({id,journal_id:j.id,market:j.market,title,doi,url,authors:a.authors||'',abstract:a.abstract||'',publication_date:a.publication_date||'',source:'manual',topics:ts,matched:ts.length>0})?1:0;
  }console.log('Imported:',added);
 }
}else{console.log('Commands: scan [--backfill --days=30], digest [--weekly], import ./papers.json');}
