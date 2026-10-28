// Explicitly synthetic acceptance files; never represent actual publications.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const priorityJournals=JSON.parse(fs.readFileSync(path.join(root,'api/config/chinese-journal-inventory.json'),'utf8')).filter(j=>j.priority);
export const csvHeaders=['journal_id','journal_title','issn','title','authors','publication_date','doi','url','record_evidence','volume','issue','published_online_date','published_print_date','source_updated_at','abstract'];
export const csvCell=s=>'"'+String(s??'').replaceAll('"','""')+'"';
export function syntheticCsv(count,{prefix='mvp',invalid=false}={}){
 const rows=Array.from({length:count},(_,i)=>{
  const j=priorityJournals[i%4];
  return [j.id,j.title,j.issn,`合成测试 ${prefix} 第${i+1}条，非真实论文`, '合成作者甲; 合成作者乙',invalid&&i===0?'2026-02-30':i%10===0?'2025-12':'2025-12-15',i%3===0?`10.9999/fanscope-synthetic-${prefix}-${i}`:'',`https://papers.invalid/${prefix}/${i}`,`合成文件记录编号${i+1}，不构成真实论文证据`,'1','6','','','',''];
 });
 return '\uFEFF'+[csvHeaders,...rows].map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const out=path.join(root,'work/chinese-authorized-import/fixtures');fs.mkdirSync(out,{recursive:true});
 for(const count of [100,1000])fs.writeFileSync(path.join(out,`SYNTHETIC-${count}.csv`),syntheticCsv(count,{prefix:'scale-'+count}));
 fs.writeFileSync(path.join(out,'SYNTHETIC-errors-100.csv'),syntheticCsv(100,{prefix:'error-sample',invalid:true}));
 console.log('仅合成测试文件，非真实论文：'+out);
}
