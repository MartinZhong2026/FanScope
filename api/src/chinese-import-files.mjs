// File adapters only: no database, network, XML entity expansion or provider-specific crawler.
export const importFields={
 journal_id:['journal_id','期刊ID'],journal_title:['journal_title','journal','期刊名称','刊名'],issn:['issn','ISSN'],
 title:['title','题名','标题'],authors:['authors','author','作者'],publication_date:['publication_date','发表日期'],
 doi:['doi','DOI'],url:['url','原文链接'],record_evidence:['record_evidence','记录证据位置'],
 volume:['volume','卷'],issue:['issue','期'],published_online_date:['published_online_date','在线发布日期'],
 published_print_date:['published_print_date','纸本发布日期'],source_updated_at:['source_updated_at','来源更新时间'],abstract:['abstract','摘要']
};
export const requiredImportFields=['journal_title','issn','title','authors','publication_date','url','record_evidence'];
const fail=s=>Object.assign(Error(s),{status:400});
export function parseImportCsv(input){
 const text=String(input||'').replace(/^\uFEFF/,'');
 if(Buffer.byteLength(text)>8*1024*1024)throw fail('文件超过8MB，请按期刊或年份拆分');
 if(text.includes('\0'))throw fail('需要UTF-8文本CSV');
 if(text.includes('\uFFFD'))throw fail('文件存在编码替换字符，请另存为UTF-8 CSV后重试');
 let field='',row=[],quoted=false,closed=false,line=1,start=1;const rows=[];
 function cell(){row.push(field);field='';closed=false;}
 function finish(){cell();if(row.some(x=>x.trim()))rows.push({line:start,values:row});row=[];start=line+1;if(rows.length>5001)throw fail('每个文件最多5000条，请拆分');}
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else{field+=c;if(c==='\n')line++;}continue;}
  if(c==='"'){if(field||closed)throw fail(`CSV第${line}行引号位置错误`);quoted=true;}
  else if(c===',')cell();
  else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;finish();line++;start=line;}
  else {if(closed)throw fail(`CSV第${line}行引号后存在多余字符`);field+=c;}
 }
 if(quoted)throw fail('CSV引号未闭合');
 if(field||row.length||closed)finish();
 if(rows.length<2)throw fail('CSV需要表头及至少一条记录');
 const headers=rows.shift().values.map(x=>x.trim());
 if(headers.some(x=>!x)||new Set(headers).size!==headers.length)throw fail('CSV表头不能为空或重复');
 return {headers,rows};
}
export function suggestImportMapping(headers){return Object.fromEntries(Object.entries(importFields).map(([field,aliases])=>[field,aliases.find(x=>headers.includes(x))||'']));}
export function mapImportCsv(parsed,mapping){
 const map={...suggestImportMapping(parsed.headers),...mapping};
 for(const [field,column] of Object.entries(map))if(!Object.hasOwn(importFields,field)||typeof column!=='string'||column&&!parsed.headers.includes(column))throw fail('字段映射无效：'+field);
 for(const field of requiredImportFields)if(!map[field])throw fail('缺少必需映射：'+field);
 const selected=Object.values(map).filter(Boolean);if(new Set(selected).size!==selected.length)throw fail('同一列不能映射到多个字段');
 return {mapping:map,rows:parsed.rows.map((row,index)=>({number:index+1,line:row.line,columns:row.values.length,record:Object.fromEntries(Object.entries(map).map(([k,v])=>[k,v?String(row.values[parsed.headers.indexOf(v)]||'').trim():'']))}))};
}
