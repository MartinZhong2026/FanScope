// Convert existing PR browser acceptance screenshots into a visual preview.
// Never execute PR JavaScript in a deployment job or on a production origin.
import fs from 'node:fs';
import path from 'node:path';
export function gallery(source,output,sha){
 const target=path.join(output,'evidence');fs.mkdirSync(target,{recursive:true});
 const items=[];
 function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  if(e.isSymbolicLink())throw Error('Screenshot symlink rejected');
  if(e.isDirectory())walk(path.join(dir,e.name));
  else if(e.isFile()&&e.name.endsWith('.png')){
   const data=fs.readFileSync(path.join(dir,e.name));
   if(data.length>10*1024*1024||data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Invalid/oversized screenshot');
   if(items.length>=400)throw Error('Screenshot count limit exceeded');
   const filename=`screen-${items.length}.png`;fs.writeFileSync(path.join(target,filename),data);
   items.push({filename,label:path.relative(source,path.join(dir,e.name))});
  }
 }}
 walk(source);if(!items.length)throw Error('No browser acceptance screenshots for preview');
 const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 fs.writeFileSync(path.join(output,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FanScope PR preview</title><style>body{font:16px system-ui;background:#101b27;color:#edf3fa;margin:24px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}figure{margin:0}img{max-width:100%;height:auto}figcaption{overflow-wrap:anywhere;padding:8px}a{color:#8edbd5}</style><h1>FanScope PR 视觉预览</h1><p>提交 ${escape(sha)} · 使用合成数据的 Mobile、Desktop、Chinese 浏览器验收截图。此预览无脚本、无生产 API 连接。</p><main>${items.map(i=>`<figure><a href="evidence/${i.filename}"><img loading="lazy" src="evidence/${i.filename}" alt="${escape(i.label)}"></a><figcaption>${escape(i.label)}</figcaption></figure>`).join('')}</main></html>`);
 return items.length;
}
