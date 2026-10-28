// Pure directory parser shared by read-only probes and the ingestion engine.
const decode=s=>String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/<[^>]*>/g,'').trim();
export function chineseCatalogLinks(html,url,start,end){
 const links=new Set(),archive=/showOldVolumn\.do/.test(new URL(url).pathname);let sections=[html];
 if(archive)sections=[...html.matchAll(/<(tr|li)\b[^>]*>[\s\S]*?<\/\1>/gi)].map(m=>m[0]).filter(s=>{const year=decode(s).match(/\b(\d{4})\s*(?:Vol\.|年)/i)?.[1];return year&&year>=start.slice(0,4)&&year<=end.slice(0,4)});
 for(const section of sections)for(const link of section.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)){
  let target;try{target=new URL(decode(link[1]),url);target.hash='';}catch{continue;}
  const year=target.pathname.match(/\/CN\/Y(\d{4})\//)?.[1];
  if(year&&(year<start.slice(0,4)||year>end.slice(0,4)))continue;
  if(!/\/CN\/Y\d{4}\/V\d+\/I\d+\/[^/]+$/.test(target.pathname)&&!(archive&&/\/CN\/volumn\/volumn_\d+\.shtml$/.test(target.pathname))&&!/rel=["']next["']/i.test(link[0]))continue;
  links.add(target.href);
 }return [...links];
}
