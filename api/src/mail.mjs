import {articleLink} from './sources.mjs';
import crypto from 'node:crypto';
import {config} from './config.mjs';
import {db,now} from './db.mjs';
import {log,errorFields} from './platform/log.mjs';
export const token=()=>crypto.randomBytes(32).toString('base64url');
export const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const mailReady=()=>Boolean(config.resendKey&&config.emailFrom&&config.apiUrl.startsWith('https://'));
export async function sendMail(to,subject,html){
 if(!mailReady())throw Error('Email not configured: set RESEND_API_KEY, EMAIL_FROM and HTTPS PUBLIC_API_URL');
 const result=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':`Bearer ${config.resendKey}`,'Content-Type':'application/json'},body:JSON.stringify({from:config.emailFrom,to:[to],subject,html}),signal:AbortSignal.timeout(25000)});
 if(!result.ok){
  let code;try{const body=await result.json();code=body?.name||body?.error?.code;}catch{}
  // Provider text may echo recipients or private drafts. Carry metadata only.
  throw Object.assign(Error(`Email provider HTTP ${result.status}`),{status:result.status,
   upstream:{provider:'resend',host:'api.resend.com',status:result.status,code,request_id:result.headers.get('x-request-id')||undefined}});
 }
 return true;
}
const getUnsub=s=>`${config.apiUrl}/api/subscriptions/unsubscribe?token=${encodeURIComponent(s.unsub_token||'')}`;
export function paperMarkup(a){return `<li style="margin:0 0 14px"><a href="${esc(articleLink(a).article_url||'')}" style="font-weight:700;color:#167c83">${esc(a.title)}</a><br><span style="color:#667789;font-size:13px">${esc(a.journal_title||'')} · ${esc(a.publication_date||'日期未知')} · ${esc((JSON.parse(a.topics||'[]')).join(', ')||'待分类')}</span>${a.ai_summary?`<p>${esc(a.ai_summary).slice(0,440)}</p>`:''}</li>`;}
const shell=(content,unsub)=>`<!doctype html><html lang="zh"><meta charset="utf-8"><body style="font-family:Arial,'Microsoft YaHei',sans-serif;color:#122237;max-width:660px;padding:24px;margin:auto"><h2 style="color:#168f92">◢ FanScope · Research Radar</h2>${content}<hr style="border:0;border-top:1px solid #dfe6eb"><p style="font-size:12px;color:#7b8998">课题组研究论文通知 · 数据以原始期刊和 DOI 为准${unsub?` · <a href="${esc(unsub)}">管理退订</a>`:''}</p></body></html>`;
export async function sendVerification(email,verifyToken){
 return sendMail(email,'确认订阅 FanScope 期刊监测',shell(`<p>请点击以下链接验证邮箱并开启期刊监测通知：</p><p><a href="${config.apiUrl}/api/subscriptions/confirm?token=${encodeURIComponent(verifyToken)}">确认我的订阅</a></p><p>若非本人操作，请忽略本邮件。</p>`,''));
}
function findMatchedArticles(s,articleIds=null,days=1){
 const topics=JSON.parse(s.topics||'[]'), markets=JSON.parse(s.markets||'[]');
 const since=new Date(Date.now()-days*86400000).toISOString();
 let rows=db.prepare(`SELECT a.*, j.title AS journal_title FROM articles a JOIN journals j ON j.id=a.journal_id WHERE a.discovered_at>=? AND a.demo=0 ${articleIds?'':"AND a.notification_eligible=1"} ORDER BY a.discovered_at DESC LIMIT 250`).all(since);
 if(articleIds)rows=rows.filter(a=>articleIds.includes(a.id));
 return rows.filter(a=>markets.includes(a.market)&&(!topics.length||JSON.parse(a.topics).some(t=>topics.includes(t))));
}
export async function urgentDispatch(articleIds){
 if(!mailReady()||!articleIds.length)return {sent:0,skipped:!mailReady()};
 let sent=0;
 const members=db.prepare('SELECT * FROM subscribers WHERE confirmed=1 AND urgent=1').all();
 for(const s of members){
  const picks=findMatchedArticles(s,articleIds,10).filter(a=>!db.prepare('SELECT 1 FROM deliveries WHERE subscriber_id=? AND article_id=? AND kind=? AND status=?').get(s.id,a.id,'urgent','sent')).slice(0,5);
  if(!picks.length)continue;
  try{
   const unsub=db.prepare('SELECT value FROM meta WHERE key=?').get('unsub:'+s.id)?.value||'';
   await sendMail(s.email,`FanScope · 发现 ${picks.length} 篇重点相关论文`,shell(`<p>以下是监测期刊中新发现、与你订阅领域相关的论文：</p><ol>${picks.map(paperMarkup).join('')}</ol>`,`${config.apiUrl}/api/subscriptions/unsubscribe?token=${encodeURIComponent(unsub)}`));
   const q=db.prepare(`INSERT INTO deliveries(id,subscriber_id,article_id,kind,status,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(subscriber_id,article_id,kind) DO UPDATE SET status='sent',error=NULL`);
   for(const a of picks)q.run(crypto.randomUUID(),s.id,a.id,'urgent','sent',now());sent++;
  }catch(e){log('warn','mail.send_failed',{kind:'urgent',subscriber_id:s.id,...errorFields(e)});}
 }
 return {sent};
}
export async function scheduledDigest(kind='daily'){
 if(!mailReady())return {sent:0,reason:'email disabled'};
 const col=kind==='weekly'?'weekly':'daily', days=col==='weekly'?7:1;
 const subs=db.prepare(`SELECT * FROM subscribers WHERE confirmed=1 AND ${col}=1`).all();let sent=0;
 for(const s of subs){
  const today=now().slice(0,10);if(s[col==='weekly'?'last_weekly':'last_daily']===today)continue;
  const picks=findMatchedArticles(s,null,days).slice(0,20);
  if(!picks.length){db.prepare(`UPDATE subscribers SET ${col==='daily'?'last_daily':'last_weekly'}=? WHERE id=?`).run(today,s.id);continue;}
  const unsub=db.prepare('SELECT value FROM meta WHERE key=?').get('unsub:'+s.id)?.value||'';
  const html=shell(`<p>过去${days}天，你关注的期刊发现 <b>${picks.length}</b> 篇相关新文章。</p>${picks.length?`<ol>${picks.map(paperMarkup).join('')}</ol>`:'<p>暂无新的相关论文。请查看监测健康页，确认数据源是否运行正常。</p>'}`,`${config.apiUrl}/api/subscriptions/unsubscribe?token=${encodeURIComponent(unsub)}`);
  try{await sendMail(s.email,`FanScope ${col==='daily'?'每日':'每周'}科研简报 · ${today}`,html);
   db.prepare(`UPDATE subscribers SET ${col==='daily'?'last_daily':'last_weekly'}=? WHERE id=?`).run(today,s.id);sent++;
  }catch(e){log('warn','mail.send_failed',{kind,subscriber_id:s.id,...errorFields(e)});}
 }
 return {sent};
}
