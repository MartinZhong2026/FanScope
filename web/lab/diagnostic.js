// FanScope Lab · Paper Diagnostic. All access control is enforced by the API;
// this page only renders what the server returns for the signed-in Lab member.
const API=(window.FANSCOPE_CONFIG?.API_BASE_URL||'').replace(/\/$/,'');
const token=sessionStorage.getItem('fanscope_lab_token')||'';
const app=document.getElementById('app');
const S={config:null,items:[],selected:null,run:null,members:[],notice:'',error:false,busy:false,disabled:false};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const day=s=>s?new Date(s).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}):'—';
const time=s=>s?new Date(s).toLocaleString('zh-CN',{hour12:false}):'—';
const RUN={queued:'排队中',structuring:'识别论文结构…',diagnosing:'诊断中…',done:'已完成',failed:'失败',interrupted:'已中断（可重试）',cancelled:'已取消'};
const SEV={critical:['严重','sev-critical'],major:['重要','sev-major'],minor:['次要','sev-minor']};
const TYPE={quantitative:'定量研究',qualitative:'定性研究',mixed:'混合方法',theoretical:'理论研究',review:'综述',unknown:'未能判断'};
const FACT={research_questions:'研究问题',theory:'理论框架',hypotheses:'研究假设',data:'数据与样本',methods:'研究方法',results:'主要结果',conclusions:'结论'};
const DIM={research_question:'研究问题',theory_design_fit:'理论与设计匹配',argument_logic:'论证逻辑',evidence_support:'证据支撑',contribution:'贡献',writing_structure:'写作结构',
 variables_measurement:'变量与测量',sample_data:'样本与数据',model_specification:'模型设定',statistical_inference:'统计推断',causal_claims:'因果表述',robustness:'稳健性',
 participants_sampling:'研究对象与抽样',data_collection:'资料收集',analysis_procedure:'资料分析',reflexivity_ethics:'反身性与伦理',interpretation_claims:'诠释与结论',mixed_integration:'混合方法整合'};
const CHECK={adequate:['充分','ok'],concern:['有疑问','warn'],missing:['缺失','bad'],not_applicable:['不适用','gray']};
const ERR={dx_provider_http_429:'模型服务繁忙，请稍后重试',dx_provider_timeout:'模型响应超时',dx_provider_invalid_json:'模型返回格式异常',dx_provider_truncated:'稿件过长，模型输出被截断',dx_provider_unconfigured:'诊断引擎未配置',dx_provider_network:'无法连接模型服务'};

async function api(path,{method='GET',body,raw}={}){
 const headers={Authorization:`Bearer ${token}`};let payload=body;
 if(raw){headers['Content-Type']=raw.type;headers['X-File-Name']=encodeURIComponent(raw.name);payload=raw.file}
 else if(body!==undefined){headers['Content-Type']='application/json';payload=JSON.stringify(body)}
 const res=await fetch(API+path,{method,headers,body:payload,signal:AbortSignal.timeout(raw?150000:30000)});
 let data;try{data=await res.json()}catch{throw Object.assign(Error(`接口未返回有效数据（${res.status}）`),{status:res.status})}
 if(!res.ok)throw Object.assign(Error(data.error||`请求失败（${res.status}）`),{status:res.status});
 return data;
}
const notify=(message,error=false)=>{S.notice=message;S.error=error;render()};
async function guard(fn){if(S.busy)return;S.busy=true;render();try{await fn()}catch(e){notify(e.message,true)}finally{S.busy=false;render()}}

function mimeOf(name){const n=name.toLowerCase();return n.endsWith('.pdf')?'application/pdf':n.endsWith('.docx')?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':n.endsWith('.md')?'text/markdown':n.endsWith('.txt')?'text/plain':null}

async function refresh(selectId){
 S.items=(await api('/api/diagnostic/submissions')).items;
 const id=selectId||S.selected?.id;
 S.selected=id?await api(`/api/diagnostic/submissions/${encodeURIComponent(id)}`).catch(()=>null):null;
 const latest=S.selected?.runs?.find(r=>r.status==='done');
 S.run=latest?await api(`/api/diagnostic/runs/${latest.id}`).catch(()=>null):null;
 schedulePoll();
}
let pollTimer=null;
const STARTED='诊断已开始，通常需要 1–3 分钟，可以离开本页稍后回来查看。';
function schedulePoll(){
 clearTimeout(pollTimer);
 if(S.selected?.runs?.some(r=>['queued','structuring','diagnosing'].includes(r.status)))pollTimer=setTimeout(()=>refresh().then(render).catch(()=>{}),3000);
 else if(S.notice===STARTED)S.notice='';
}

// --- Rendering --------------------------------------------------------------
const pill=(text,cls='')=>`<span class="dx-pill ${cls}">${esc(text)}</span>`;
const quote=q=>`<blockquote class="dx-quote">${esc(q)}</blockquote>`;
function header(){
 return `<header class="dx-head"><div><div class="eyebrow">FANSCOPE / LAB WORKSPACE</div><h1>论文诊断</h1><p class="subtle">上传尚未发表的论文，获得区分“稿件事实”与“AI 判断”的诊断报告。仅课题组登录成员可用。</p></div>
 <div class="buttons"><a class="btn" href="/lab/">← 返回课题组工作台</a></div></header>${S.notice?`<div role="status" class="notice ${S.error?'error':''}">${esc(S.notice)} <button class="btn" data-dismiss>×</button></div>`:''}`;
}
function uploadBox(){
 return `<section class="box"><h2>上传论文</h2><form id="dx-upload"><div class="formrow"><label for="dx-file">PDF / Word (.docx) / Markdown / TXT，不超过 10MB；扫描版 PDF 无法识别</label><input id="dx-file" name="file" type="file" accept=".pdf,.docx,.md,.txt" required></div>
 <button class="btn primary" type="submit" ${S.busy?'disabled':''}>上传并提取文字</button></form><p class="dx-visibility">${esc(S.config.consent.visibility)}</p><p class="subtle">上传后需单独确认授权，确认前不会进行任何诊断。原稿保留 ${S.config.consent.originalDays} 天，报告保留 ${S.config.consent.reportDays} 天，可随时删除。</p></section>`;
}
function historyBox(){
 return `<section class="box"><h2>我的诊断记录</h2>${S.items.length?S.items.map(s=>{const last=s.runs?.[0];return `<button class="dx-row ${S.selected?.id===s.id?'active':''}" data-open="${esc(s.id)}"><strong>${esc(s.title||s.filename)}</strong>
 <span class="subtle">${s.is_owner?'我上传的':`来自 ${esc(s.owner.name)}`} · ${day(s.created_at)} · ${last?esc(RUN[last.status]||last.status):'未诊断'}</span></button>`}).join(''):'<p class="empty subtle">还没有上传过论文。</p>'}</section>`;
}
function consentBox(sub){
 const c=S.config.consent;
 return `<div class="dx-consent"><h3>诊断前授权</h3><p>${esc(c.text)}</p><p class="subtle">${esc(c.backupNote)}</p>
 <label class="dx-check"><input type="checkbox" id="dx-consent-check"> 我已阅读并同意以上说明</label>
 <button class="btn primary" data-consent="${esc(sub.id)}" ${S.busy?'disabled':''}>确认授权</button></div>`;
}
function detail(){
 const s=S.selected;
 if(!s)return `<section class="box dx-empty"><h2>选择或上传一篇论文</h2><p class="subtle">诊断报告会列出稿件中可核对的事实，并单独给出按严重程度排序的修改建议。</p></section>`;
 const active=s.runs?.some(r=>['queued','structuring','diagnosing'].includes(r.status));
 const canRun=s.is_owner&&s.consented&&s.original_available&&!active;
 return `<section class="box"><div class="dx-titlebar"><div><h2>${esc(s.title||s.filename)}</h2><p class="subtle">${esc(s.filename)} · 提取 ${Number(s.text_length).toLocaleString()} 字符 · 上传于 ${time(s.created_at)}</p></div>
 ${s.is_owner?`<button class="btn warn" data-delete="${esc(s.id)}" ${S.busy?'disabled':''}>删除稿件与报告</button>`:''}</div>
 <div class="dx-retention">${pill(s.original_available?`原稿保留至 ${day(s.original_expires_at)}`:'原稿已删除',s.original_available?'':'gray')}${pill(`报告保留至 ${day(s.report_expires_at)}`)}${s.is_owner?'':pill(`${s.owner.name} 共享给你`,'gray')}</div>
 ${s.is_owner&&!s.consented&&s.original_available?consentBox(s):''}
 ${canRun?`<button class="btn primary" data-run="${esc(s.id)}" ${S.busy?'disabled':''}>${s.runs?.length?'重新诊断':'开始诊断'}</button>`:''}
 ${s.runs?.length?`<div class="dx-runs">${s.runs.map(r=>`<div>${pill(RUN[r.status]||r.status,r.status==='failed'?'bad':r.status==='done'?'ok':'')} <span class="subtle">${time(r.created_at)} · ${r.provider==='rules'?'规则演示引擎':esc(r.provider)}${r.error_code?` · ${esc(ERR[r.error_code]||r.error_code)}`:''}</span></div>`).join('')}</div>`:''}
 ${s.is_owner?shareBox(s):''}</section>${S.run?.report?report(S.run):''}`;
}
function shareBox(s){
 const others=S.members.filter(m=>m.id!==S.config.user.id&&!s.shares?.some(x=>x.user_id===m.id));
 return `<details class="dx-share"><summary>共享（${s.shares?.length||0}）</summary><p class="subtle">默认只有你本人${S.config.consent.mentor?`和课题组导师（${esc(S.config.consent.mentor.name)}）`:''}可见。共享后对方可阅读报告，但不能诊断、共享或删除。</p>
 ${(s.shares||[]).map(x=>`<div class="dx-shared">${esc(x.name||x.user_id)} <button class="btn" data-unshare="${esc(x.user_id)}">撤销</button></div>`).join('')}
 ${others.length?`<div class="dx-inline"><select id="dx-share-user">${others.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select><button class="btn" data-share="${esc(s.id)}">共享</button></div>`:''}</details>`;
}
function report(run){
 const r=run.report,ai=r.provenance?.ai;
 const facts=Object.entries(FACT).map(([k,label])=>{const list=r.facts[k]||[];return `<div class="dx-fact"><h4>${label}</h4>${list.length?list.map(f=>`<p>${esc(f.text)}</p>${quote(f.quote)}`).join(''):'<p class="subtle">未在稿件中找到可核对的表述。</p>'}</div>`}).join('');
 const issues=r.issues.length?r.issues.map(i=>`<article class="dx-issue ${SEV[i.severity][1]}"><div class="dx-issue-head">${pill(SEV[i.severity][0],SEV[i.severity][1])}${pill(DIM[i.dimension]||i.dimension,'gray')}<h4>${esc(i.title)}</h4></div>
  <p>${esc(i.problem)}</p>${i.evidence.length?i.evidence.map(e=>quote(e.quote)).join(''):'<p class="subtle dx-noevidence">无可核对的原文引用：此条为推断，请自行判断。</p>'}
  ${i.reviewer_question?`<p><strong>审稿人可能会问：</strong>${esc(i.reviewer_question)}</p>`:''}<p class="dx-suggest"><strong>修改建议：</strong>${esc(i.suggestion)}</p></article>`).join(''):'<p class="subtle">未发现需要列出的问题。</p>';
 const checks=r.checks.map(c=>`<tr><td>${esc(DIM[c.dimension]||c.dimension)}</td><td>${pill(CHECK[c.status][0],CHECK[c.status][1])}</td><td>${esc(c.judgment)}${c.evidence.map(e=>quote(e.quote)).join('')}</td></tr>`).join('');
 const v=r.validation;
 return `<section class="box dx-report"><div class="dx-titlebar"><h2>诊断报告</h2><span class="subtle">${time(r.provenance?.generated_at)}</span></div>
 <div class="dx-banner ${ai?'':'demo'}">${ai?`由 ${esc(r.provenance.engine)} 模型生成（${esc(r.provenance.prompt_version)}）。AI 判断可能有误，请结合专业判断使用；报告不引用任何外部文献。`:'演示模式：规则引擎仅按关键词定位原文，不理解论证，结论不能视为 AI 或专家判断。'}</div>
 <div class="dx-meta">${pill(TYPE[r.paper_type]||r.paper_type)}${r.coverage?.truncated?pill(`仅分析前 ${r.coverage.analyzed_chars.toLocaleString()} 字符`,'warn'):''}${pill(`${v.facts_verified} 条事实已在原文中核对`,'ok')}${v.quotes_rejected?pill(`已剔除 ${v.quotes_rejected} 条无法核对的引文`,'gray'):''}</div>
 ${r.summary?`<p class="dx-summary"><span class="subtle">${ai?'AI 摘要':'说明'}：</span>${esc(r.summary)}</p>`:''}
 <h3 class="dx-section">一、稿件事实 <small>每条均附原文，可逐字核对</small></h3><div class="dx-facts">${facts}</div>
 <h3 class="dx-section">二、${ai?'AI':'规则'}判断：问题与修改建议 <small>按严重程度排序</small></h3>${issues}
 ${checks?`<h3 class="dx-section">三、分维度检查</h3><div class="dx-table"><table><thead><tr><th>维度</th><th>结论</th><th>说明</th></tr></thead><tbody>${checks}</tbody></table></div>`:''}
 ${r.strengths?.length?`<h3 class="dx-section">四、优点</h3>${r.strengths.map(s=>`<p>${esc(s.text)}</p>${s.evidence.map(e=>quote(e.quote)).join('')}`).join('')}`:''}</section>`;
}
function mentorBox(){
 if(S.config.user.role!=='lab_admin')return '';
 const mentors=S.members.filter(m=>m.role==='mentor'),current=S.config.consent.mentor;
 return `<details class="box dx-share"><summary>可查看全组诊断稿件的导师</summary><p class="subtle">课题组只指定一位导师。被指定的导师可以查看所有成员上传的诊断稿件与报告，上传和授权页面会向成员明确说明。</p>
 <p>当前：<strong>${current?esc(current.name):'未指定'}</strong></p>
 <div class="dx-inline"><select id="dx-mentor"><option value="">不指定</option>${mentors.map(m=>`<option value="${esc(m.id)}" ${current?.id===m.id?'selected':''}>${esc(m.name)}</option>`).join('')}</select><button class="btn" data-mentor>保存</button></div></details>`;
}
function render(){
 if(!token){app.innerHTML=`${header()}<section class="box"><h2>请先登录</h2><p>论文诊断仅对课题组成员开放。</p><a class="btn primary" href="/lab/">前往登录</a></section>`;return}
 if(S.disabled){app.innerHTML=`${header()}<section class="box"><h2>论文诊断尚未开放</h2><p class="subtle">功能正在验收中，开放后会在课题组工作台通知。</p></section>`;return}
 if(!S.config){app.innerHTML=`${header()}<p class="subtle">正在加载…</p>`;return}
 app.innerHTML=`${header()}<div class="dx-grid"><div class="dx-side">${uploadBox()}${historyBox()}${mentorBox()}</div><div class="dx-main">${detail()}</div></div>`;
}

// --- Events -----------------------------------------------------------------
app.addEventListener('submit',e=>{
 if(e.target.id!=='dx-upload')return;e.preventDefault();
 const file=e.target.file.files[0];
 guard(async()=>{
  if(!file)throw Error('请选择文件');if(file.size>10*1024*1024)throw Error('文件不得超过 10MB');
  const type=mimeOf(file.name);if(!type)throw Error('请使用 PDF、DOCX、Markdown 或 TXT（不支持 .doc）');
  notify('正在上传并提取文字…');
  const sub=await api('/api/diagnostic/submissions',{method:'POST',raw:{file,type,name:file.name}});
  await refresh(sub.id);S.notice=`已提取 ${sub.text_length.toLocaleString()} 字符。请阅读授权说明后开始诊断。`;S.error=false;
 });
});
app.addEventListener('click',e=>{
 const t=e.target.closest('[data-open],[data-consent],[data-run],[data-delete],[data-share],[data-unshare],[data-dismiss],[data-mentor]');if(!t)return;
 if(t.dataset.dismiss!==undefined){S.notice='';render();return}
 if(t.dataset.open)return guard(()=>refresh(t.dataset.open));
 // Read form controls before guard() re-renders the page.
 const checked=!!document.getElementById('dx-consent-check')?.checked,shareTo=document.getElementById('dx-share-user')?.value,
  mentorId=document.getElementById('dx-mentor')?.value;
 if(t.dataset.consent)return guard(async()=>{
  if(!checked)throw Error('请先勾选同意授权说明');
  const c=S.config.consent;await api(`/api/diagnostic/submissions/${t.dataset.consent}/consent`,{method:'POST',body:{accept:true,version:c.version,engine:c.engine}});
  await refresh();S.notice='已记录授权，可以开始诊断。';S.error=false;
 });
 if(t.dataset.run)return guard(async()=>{await api(`/api/diagnostic/submissions/${t.dataset.run}/runs`,{method:'POST'});await refresh();if(S.selected?.runs?.some(r=>['queued','structuring','diagnosing'].includes(r.status))){S.notice=STARTED;S.error=false}});
 if(t.dataset.delete)return guard(async()=>{
  if(!confirm('确定删除这篇稿件及其全部诊断报告？删除立即生效且无法恢复（服务器备份按运维策略轮换）。'))return;
  await api(`/api/diagnostic/submissions/${t.dataset.delete}/delete`,{method:'POST'});S.selected=null;S.run=null;await refresh();S.notice='已删除稿件与报告。';S.error=false;
 });
 if(t.dataset.share)return guard(async()=>{await api(`/api/diagnostic/submissions/${t.dataset.share}/shares`,{method:'POST',body:{user_id:shareTo}});await refresh();});
 if(t.dataset.unshare)return guard(async()=>{await api(`/api/diagnostic/submissions/${S.selected.id}/shares`,{method:'POST',body:{user_id:t.dataset.unshare,grant:false}});await refresh();});
 if(t.dataset.mentor!==undefined)return guard(async()=>{await api('/api/diagnostic/trusted-mentor',{method:'POST',body:{user_id:mentorId||null}});S.config=await api('/api/diagnostic/config');S.notice='已更新课题组导师设置。';S.error=false});
});

async function start(){
 render();if(!token)return;
 try{
  S.config=await api('/api/diagnostic/config');
  S.members=(await api('/api/diagnostic/members')).items;
  await refresh(new URLSearchParams(location.search).get('id'));
 }catch(e){if(e.status===404)S.disabled=true;else if(e.status===401){sessionStorage.removeItem('fanscope_lab_token');location.href='/lab/'}else{S.notice=e.message;S.error=true}}
 render();
}
start();
