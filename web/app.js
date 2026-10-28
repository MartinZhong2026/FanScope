import {chineseQualityPanel,chineseSourceStatus} from './chinese-quality.mjs';
import {readChineseDiagnostics} from './chinese-diagnostics.mjs';
import {translate as t,locale} from './i18n.mjs';
import {chartColors,designName,methodName as methodText,sourceName as sourceText,unitName as unitText,distributionRows,barOption,distributionOption,temporalOption} from './trend-charts.mjs';
import {matrixDistribution,topicGrowth,sampleBins,sourceDistribution} from './research-visuals.mjs';
import {mobileQuery,mobileIcon,mobileDock,mobileHeader,launcherHtml,mobilePageAllowed,openAppDialog,installMobileEnvironment} from './mobile-ui.js';
import {pendingEnglishSources,activatePendingEnglishSources} from './source-batch.mjs';
const API=(window.FANSCOPE_CONFIG?.API_BASE_URL||'').replace(/\/$/,'');
const S={page:'home',trendTab:'topics',sampleUnit:'',trendFiltersOpen:false,articleId:'',articleTitle:'',filtersOpen:false,loading:false,market:'all',topic:'',journal:'',search:'',status:'loading',data:{},busy:false,emailMessage:'',emailError:false,viewLimit:20,period:'90d',view:'publication',year:'',link:'',articleType:'all',comparison:null,sourceMessage:'',sourceError:false,discoveries:[],opsMessage:'',opsError:false,sourceBatch:null};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const date=s=>s?new Date(s).toLocaleDateString(locale(),{year:'numeric',month:'2-digit',day:'2-digit'}):'未知';
const nt=n=>Number(n||0).toLocaleString('en-US');
const color=['#149e96','#5b82d0','#967cd3','#eaa552','#7db7ca','#d06a85'];
const icon={home:'▦',feed:'▤',journals:'▣',trends:'◉',alerts:'♧',health:'◷',opportunity:'◇',fit:'▧',lab:'♙',sources:'◈',operations:'▥'};
const names={me:'我的工作台',article:'论文详情',home:'学术情报总览',feed:'文献发现',journals:'期刊画像',trends:'研究趋势',alerts:'邮件通知订阅',health:'监测健康状态',opportunity:'研究机会',fit:'投稿适配分析',lab:'课题组数据资产',sources:'期刊来源管理',operations:'AI 解析与历史回填'};
const marketLabel=x=>x==='chinese'?'国内 C 刊':'国外英文期刊';
const topicLabel=id=>S.data.topics?.items?.find(t=>t.id===id)?.short||'未分类主题';
const marketSelect=()=>`<div class="segmented" role="group" aria-label="期刊体系"><button data-market="all" ${S.page==='trends'?'hidden':''} class="${S.market==='all'?'active':''}">全部期刊</button><button data-market="chinese" class="${S.market==='chinese'?'active':''}">国内 C 刊</button><button data-market="international" class="${S.market==='international'?'active':''}">国外英文</button></div>`;
const opts=(arr,sel)=>arr.map(([value,label])=>`<option value="${esc(value)}" ${sel===value?'selected':''}>${esc(label)}</option>`).join('');
const topicFilter=()=>`<select id="topic-filter" aria-label="研究主题" class="select"><option value="">全部研究主题</option>${opts((S.data.topics?.items||[]).map(t=>[t.id,t.short]),S.topic)}</select>`;
const tag=(s,c='')=>`<span class="tag ${c}">${esc(s)}</span>`;
const statusTag=()=>S.status==='ready'?`<span class="statuspill ok">● 数据服务已连接</span>`:S.status==='loading'?`<span class="statuspill">◌ 正在连接数据服务</span>`:`<span class="statuspill off">● 数据服务未连接</span>`;
const title=(eyebrow,headline,desc,buttons='')=>`<div class="eyebrow">${esc(eyebrow)}</div><div class="heading-row"><div class="heading"><h1>${headline}</h1><p>${desc}</p></div><div class="heading-actions">${buttons}</div></div>`;
const nav=()=>{
 const group=(label,arr)=>`<div class="nav-title">${label}</div><div class="nav-links">${arr.map(([id,locked])=>`<button class="nav-item ${S.page===id?'active':''} ${locked?'locked':''}" ${locked?'disabled':''} data-page="${id}"><span class="nav-icon">${icon[id]}</span>${names[id]}${locked?'<span class="mini">SOON</span>':''}</button>`).join('')}</div>`;
 return `<aside class="sidebar"><div class="brand"><div class="brand-logo">◢</div><div><strong>FanScope</strong><small>RESEARCH INTELLIGENCE</small></div></div>${group('WORKSPACE',[['home'],['feed'],['journals'],['trends']])}<div style="height:22px"></div>${group('RESEARCH TOOLS',[['alerts'],['health'],['sources'],['operations'],['opportunity',true],['fit',true],['lab',true]])}<div class="nav-title">LAB WORKSPACE</div><div class="nav-links"><a href="/lab/" class="nav-item"><span class="nav-icon">▣</span>科研项目与 AI 组会更新 ↗</a></div><div class="sidebar-footer"><div class="footline"><span class="avatar">YF</span><div><strong>Yang Fan Research Group</strong><small>课题组研究工作台</small></div></div><p>FanScope · Research Radar + Lab v1.3</p></div></aside>`;
};
const hdr=()=>`<header class="topbar"><div class="breadcrumb">Research Workspace <span class="slash">/</span> <b>${names[S.page]}</b></div><div class="topright"><button class="theme-switch" data-theme-next="1" type="button" title="切换深色、浅色、系统主题" aria-label="切换显示主题">${window.FanScopeTheme?.preference==='light'?'☼ 浅色':window.FanScopeTheme?.preference==='system'?'◐ 系统':'☾ 深色'}</button>${statusTag()} <span class="datepill">◷ ${date(new Date().toISOString())}</span><span class="top-avatar">YF</span></div></header>`;
const warning=()=>{
 if(S.status==='loading')return '<div class="notice info">◌ 正在连接数据服务后端并载入真实论文数据…</div>';
 if(S.status==='error')return `<div class="notice error"><strong>后端暂不可用：</strong> 请检查服务器、HTTPS API 地址和跨域配置。当前不展示任何虚构论文或统计数据。<button class="btn slim" data-reload="1">重试连接</button></div>`;
 const j=S.data.journals?.items||[];const cnDisabled=j.filter(x=>x.market==='chinese'&&!x.article_count&&!x.automatic_source_verified&&!x.verified&&!x.enabled).length;
 if(cnDisabled)return `<div class="notice">⚠ ${cnDisabled} 本中文期刊尚无已核验接入来源。已收录期刊的历史元数据与自动监测状态分别展示；不能承诺全量覆盖或实时更新。 <button class="linkbtn" data-page="health">查看来源状态 ↗</button></div>`;
 return '';
};
const chartLine=(data,key='n')=>{
 if(!data?.length||data.every(x=>!x[key]))return '<div class="chart-empty">目前尚无足够的真实论文记录，趋势图将在积累数据后自动出现。</div>';
 const rows=data.slice(-8);let max=Math.max(1,...rows.map(x=>Number(x[key])||0));max=Math.ceil(max/4)*4;
 const W=700,H=250,L=46,R=16,T=24,B=40,iw=W-L-R,ih=H-T-B;
 const pts=rows.map((r,i)=>[L+(rows.length===1?iw/2:i*iw/(rows.length-1)),T+ih-(Number(r[key])||0)/max*ih]);
 const grid=Array.from({length:5},(_,i)=>{const y=T+i*ih/4;return `<line x1="${L}" y1="${y}" x2="${W-R}" y2="${y}" stroke="#edf1f4"/><text x="${L-10}" y="${y+4}" text-anchor="end" font-size="11" fill="#94a6b9">${Math.round(max*(4-i)/4)}</text>`;}).join('');
 const path=pts.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
 const fill=`${path} L${pts.at(-1)[0]},${T+ih} L${pts[0][0]},${T+ih}Z`;
 return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="逐年真实文章数折线图">${grid}<defs><linearGradient id="linefill" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#18a6a0" stop-opacity=".15"/><stop offset="1" stop-color="#18a6a0" stop-opacity="0"/></linearGradient></defs><path d="${fill}" fill="url(#linefill)"/><path d="${path}" stroke="#129c94" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>${pts.map((p,i)=>`<circle cx="${p[0]}" cy="${p[1]}" r="4.5" fill="#fff" stroke="#139c95" stroke-width="2.5"/><text x="${p[0]}" y="${H-13}" text-anchor="middle" font-size="11" fill="#8da0b4">${esc(rows[i].year)}</text>`).join('')}</svg>`;
};
const barChart=rows=>{
 if(!rows?.length)return '<div class="chart-empty">没有足够的已分类文章</div>';
 const max=Math.max(...rows.map(r=>r.n),1);
 return `<div class="bars">${rows.slice(0,6).map((r,i)=>`<div class="barrow"><span title="${esc(r.label||r.name)}">${esc(r.label||r.name)}</span><div class="progress-wrap"><div class="progress-fill" style="background:${color[i%color.length]};width:${Math.max(2,Math.round(100*r.n/max))}%"></div></div><b>${nt(r.n)}</b></div>`).join('')}</div>`;
};
const donut=rows=>{
 if(!rows?.length)return '<div class="chart-empty">尚无经过摘要核实的研究设计数据</div>';
 const top=rows.slice(0,5),total=rows.reduce((a,b)=>a+b.n,0),parts=[];let pos=0;
 for(let i=0;i<top.length;i++){const pct=top[i].n/total*100;parts.push(`${color[i]} ${pos.toFixed(1)}% ${(pos+pct).toFixed(1)}%`);pos+=pct;}
 if(pos<100)parts.push(`#dbe4ec ${pos.toFixed(1)}% 100%`);
 return `<div class="donut-wrap"><div class="donut" style="background:conic-gradient(${parts.join(',')})"><div class="donut-center"><strong>${nt(total)}</strong><small>已判定设计</small></div></div><div class="donut-legend">${top.map((x,i)=>`<div><i style="background:${color[i]};width:8px;height:8px;border-radius:2px"></i><span>${esc(designLabel(x.name))}</span><span class="num">${Math.round(x.n/total*100)}%</span></div>`).join('')}</div></div>`;
};
const designLabel=designName;
const methodName=methodText,sourceName=sourceText,unitName=unitText;
const evidenceField=key=>key.startsWith('method:')?'统计方法 · '+methodName(key.slice(7)):({study_design:'研究设计',statistical_methods:'统计方法',data_source_type:'数据来源',sample_n:'样本量',sample_unit:'样本单位',research_question:'研究问题',summary_zh:'摘要',topic_tags:'研究主题',wave_count:'调查波次',country:'国家 / 地区',study_period:'研究时期'})[key]||'其他证据';
const kpi=(label,value,note,ic,sty='')=>`<div class="card kpi"><div class="kpi-label">${label}<span class="kpi-icon ${sty}">${ic}</span></div><div class="kpi-value">${value}</div><div class="kpi-note">${note}</div></div>`;
const methodEvidence=a=>a.analysis?`<details><summary>AI 研究方法与证据（仅题名与摘要）</summary><p>设计：${esc(designLabel(a.analysis.study_design))} · 方法：${esc((a.analysis.statistical_methods||[]).map(methodName).join('、')||'未知')} · 数据来源：${esc(sourceName(a.analysis.data_source_type))} · 波次：${esc(a.analysis.wave_count??'未知')}</p><p>${esc(a.analysis.research_question||'研究问题证据不足')}</p>${Object.entries(a.analysis.evidence||{}).map(([field,e])=>`<blockquote>${esc(evidenceField(field))} · 置信度 ${esc(e.confidence)}<br>${esc(e.quote)}</blockquote>`).join('')}<p>提供商 ${esc(a.analysis.provider)} · 模型 ${esc(a.analysis.model)} · ${esc(a.analysis.extracted_at)}</p></details>`:'';
const paper=(a,full=false)=>`<article class="article-item"><div class="article-top"><div class="tags">${tag(marketLabel(a.market),a.market==='chinese'?'teal':'')}${tag(a.article_type_label||typeLabel(a.article_type||'unknown'),a.article_type==='original_research'?'teal':'gray')}${tag(a.abstract_status==='available'?'摘要可用':'摘要缺失 / 不足',a.abstract_status==='available'?'teal':'gray')}${a.demo?tag('演示数据','gray'):''}${a.matched?tag('课题组相关','teal'):tag('领域外 / 待分类','gray')}</div><span class="meta">${a.publication_date_partial?esc(a.publication_date_partial)+'（'+(a.date_precision==='month'?'月':'年')+'精度）':date(a.published_online_date||a.publication_date)}</span></div><a target="_blank" rel="noopener noreferrer" href="${esc(a.article_url||'#')}" class="article-title">${esc(a.title)}</a><div class="meta">${esc(a.journal_title)} · ${esc(a.authors||'作者未收录').slice(0,140)} ${a.doi?' · DOI: '+esc(a.doi):''}</div><div class="tags">${(a.topics||[]).map(t=>tag(topicLabel(t))).join('')}${a.design&&a.design!=='unknown'?tag(designLabel(a.design),'teal'):''}${a.sample_n?tag('样本 '+nt(a.sample_n)+' '+(a.sample_unit||'单位未知')):''}</div>${a.article_url?`<a class="linkbtn" href="${esc(a.article_url)}" target="_blank" rel="noopener noreferrer">${a.link_provenance==='doi'?'通过 DOI 打开':a.link_provenance==='unverified_source'?'原始文章链接（待核验）':'查看出版社文章页'} ↗</a>`:tag('链接待确认','gray')}${a.doi?` <button class="linkbtn" data-copy="${esc(a.doi)}">复制 DOI</button> <button class="linkbtn" data-copy="${esc(`${a.authors}. ${a.title}. ${a.journal_title}. ${a.publication_date}. DOI: ${a.doi}`)}">复制引用</button>`:''}${full?`${methodEvidence(a)}<p class="article-summary">${esc(a.ai_summary||a.abstract||'暂未获得可用于摘要提取的文章摘要；点击原文查看。').slice(0,550)}</p><div class="meta">${a.evidence?`样本规模证据：${esc(a.evidence).slice(0,240)} · `:''}研究设计仅依据可核查摘要证据；摘要缺失不推断方法与样本量。来源 ${esc(paperSourceLabel(a))} · ISSN ${esc(a.issn||'未知')} · 首次收录 ${date(a.discovered_at)} · 日期精度 ${esc(({day:'日精度',month:'月精度',year:'年精度'})[a.date_precision]||'未知')} · AI ${esc(analysisStatus(a))}。订阅全文请自行登录学校图书馆/Campus VPN。</div>`:''}</article>`;
const metricFilter=()=>`<div class="switches">${marketSelect()}<div class="filters">${topicFilter()}<button class="btn slim" data-page="feed">查看新增论文 →</button></div></div>`;
const workspaceModules=()=>`<div class="workspace-intro"><div class="overline">RESEARCH WORKSPACE · YANG FAN GROUP</div><h2>连接文献、分析与课题组</h2><p>每一次可靠收录，都是下一次研究发现的起点。</p></div>
 <div class="module-heading"><h2>核心功能</h2><small>RESEARCH INTELLIGENCE</small></div>
 <div class="module-grid">
 ${[
 ['feed','▤','最新论文','发现真实新发表研究','teal'],
 ['trends','⌁','研究趋势','方法、主题与样本量','blue'],
 ['journals','▦','期刊画像','中文 C 刊 / 英文期刊','purple'],
 ['health','◈','来源监测','监测覆盖与 AI 进度','amber'],
 ['sources','◉','期刊配置','管理员验证数据源','blue'],
 ['lab','▣','课题组协作','项目、稿件与组会','teal']
 ].map(([id,ic,name,desc,tone])=>id==='lab'?`<a class="module-card" href="/lab/" data-tone="${tone}"><span class="module-icon">${ic}</span><strong>${name}</strong><small>${desc}</small><span class="arrow">↗</span></a>`:`<button type="button" class="module-card" data-page="${id}" data-tone="${tone}"><span class="module-icon">${ic}</span><strong>${name}</strong><small>${desc}</small><span class="arrow">↗</span></button>`).join('')}
 </div>`;
const mobileTabs=()=>mobileDock(S.page);
const home=()=>{
 if(isMobile())return mobileHome();
 const s=S.data.stats||{count:0,relevant:0,recent:0,analyzed:0,years:[],topicCounts:[],designCounts:[]};const journals=S.data.journals?.items||[];
 const monitored=journals.filter(j=>j.status==='healthy'&&(S.market==='all'||j.market===S.market));
 const latest=S.data.recentPublications?.items||[];
 return `${title('FANSCOPE / DISCOVER WHAT MATTERS','看见学术趋势，发现下一个研究方向。','从国内 C 刊到国外英文期刊，用真实论文更新与方法证据辅助课题组研究选题。',`<button class="btn" data-page="health">◷ 检查监测状态</button><button class="btn primary" data-page="feed">↗ 查看最新论文</button><button class="btn" data-page="operations">▥ AI 解析中心</button>`)}${warning()}${workspaceModules()}${trendFilters()}${researchBrief()}<div class="kpis">${kpi('当前筛选文章',nt(s.count),'仅计算真实已导入与检索记录','▤')}${kpi('有效观察期刊',nt(monitored.length),'按两套期刊体系独立维护','▣','blue')}${kpi('关联研究主题',nt(s.relevant),'标题／摘要关键词初筛','◇','orange')}${kpi('近24小时发现',nt(s.recent),'按首次发现时间，而非发表时间','◷','purple')}</div>
 <div class="cols"><section class="card panel"><div class="panel-head"><h2>最新发表趋势</h2><button class="linkbtn" data-page="trends">查看趋势分析 ↗</button></div><p class="panel-sub">按当前观察期逐月统计，文章类型与缺失比例见下方；非期刊全量发文</p><div class="legend"><span><i style="background:#129b94"></i> 论文数量</span><span>当前年度尚未结束</span></div>${chartLine(s.years)}<div class="panel-foot">数据覆盖：${nt(s.count)} 篇 · 收录覆盖率尚未审计，不能作为期刊完整发文量。${chartQuality(0)}</div></section><section class="card panel"><div class="panel-head"><h2>已提取论文的研究设计</h2><button class="linkbtn" data-page="trends">详细画像 ↗</button></div><p class="panel-sub">仅统计有明确摘要证据及模型判定结果的文章</p>${S.data.research?.insufficient?'<div class="chart-empty">样本不足，暂不能推断趋势。请逐条查看摘要证据。</div>':donut(s.designCounts)}<div class="panel-foot">AI 已分析 ${nt(s.analyzed)} 篇；无法识别的数据不按任何方法推断。${chartQuality(2)}</div></section></div>
 <div class="cols"><section class="card panel"><div class="panel-head"><h2>研究领域前沿</h2><button class="linkbtn" data-page="trends">打开主题分析 ↗</button></div><p class="panel-sub">关键词初筛命中次数，一篇文章可属于多个研究方向</p>${barChart(s.topicCounts)}<div class="panel-foot">关键词主题筛选受题名与摘要覆盖影响。${chartQuality(1)}</div></section><section class="card panel"><div class="panel-head"><h2>最近发现</h2><button class="linkbtn" data-page="feed">全部文章 ↗</button></div><p class="panel-sub">最近90天发表 · 按发表日期倒序 · DOI 去重</p>${latest.length?latest.slice(0,3).map(x=>paper(x)).join(''):'<div class="empty"><span>⌁</span>最近90天暂无发表日期明确的论文。<br>可在文献页切换观察期。</div>'}</section></div>
 <div class="cols equal"><section class="card panel cta-card"><h2>不要错过重要论文</h2><p class="panel-sub">订阅课题组重点主题，收到新论文提醒、每日简报和每周趋势报告。</p><button class="btn" data-page="alerts">✉ 设置电子邮件通知 →</button></section><section class="card panel"><h2>研究资产与课题组协作</h2><p class="panel-sub">独立 Lab 工作台提供项目、稿件与组会资料的权限管理。</p><a class="btn" href="/lab/">打开课题组工作台 ↗</a></section></div>`;
};
const researchYear=()=>Math.max(2026,Number(new Intl.DateTimeFormat('en',{timeZone:'Asia/Taipei',year:'numeric'}).format(new Date())));
const typeLabel=x=>({original_research:'原创研究',review:'综述',conference_abstract:'会议摘要',editorial:'社论',book_review:'书评',unknown:'类型未确认',all:'全部类型'})[x]||'类型未确认';
const typeFilter=()=>`<label>文章类型<select id="article-type-filter">${opts(['all','original_research','review','conference_abstract','editorial','book_review','unknown'].map(x=>[x,typeLabel(x)]),S.articleType)}</select></label>`;
const periodOptions=()=>[['30d','最近30天'],['90d','最近90天'],['180d','最近180天'],['ytd',researchYear()+'年至今'],['2025','2025年（可选基线）'],['all','全部历史（可选）']];
const chartQuality=i=>{const q=S.data.research?.chart_quality?.[i];if(!q?.selected_n)return '<span class="chart-quality">有效样本 n=0 / 0 · 暂无样本，覆盖率与缺失率不适用。</span>';return `<span class="chart-quality">有效样本 n=${nt(q?.valid_n)} / ${nt(q?.selected_n)} · 本图覆盖 ${q?.selected_n?(100*q.valid_n/q.selected_n).toFixed(1):'0.0'}% · 缺失 ${((q?.missing_ratio??1)*100).toFixed(1)}% · 类型：${esc(typeLabel(S.articleType))}${[1,3,5].includes(i)?' · 时间图排除日期不足记录':''}</span>`};
const trendFilters=()=>`<div class="switches">${S.page==='trends'?'':marketSelect()}${topicFilter()}<label>观察期<select id="trend-period-filter">${opts(periodOptions(),S.period)}</select></label>${typeFilter()}</div>`;
const periodFilter=()=>`<div class="field"><label>时间范围</label><select id="period-filter">${opts(periodOptions(),S.period)}</select></div><div class="field"><label>排列视图</label><select id="view-filter">${opts([['publication','最新发表'],['discovered','最近新收录']],S.view)}</select></div><div class="field"><label>发表年份（选填）</label><input id="year-filter" value="${esc(S.year)}" placeholder="2026"></div><div class="field"><label>官方链接</label><select id="link-filter">${opts([['','全部'],['1','含 DOI / 出版社链接']],S.link)}</select></div>`;
const researchBrief=()=>{const r=S.data.research;return `<section class="card panel"><h2>AI Research Brief · 学术情报</h2>${r&&!r.insufficient?'<button class="btn slim" data-generate-brief="1">管理员生成简报（有费用上限）</button>':''}${r?.generatedBrief?.claims?.map(c=>`<p><span data-i18n-skip>${esc(c.text)}</span> <small>依据 ${c.evidence_n} 篇；覆盖率 ${(r.coverage*100).toFixed(1)}%</small><br>${claimLinks(c)}</p>`).join('')||''}${r?.generatedBrief?.candidate_gaps?.map(c=>`<p>候选研究机会：<span data-i18n-skip>${esc(c.text)}</span> · 依据 ${c.evidence_n} 篇<br>${claimLinks(c)}</p>`).join('')||''}<p>${esc(r?.brief||'正在计算分析覆盖')}</p><p class="meta">有证据分析 ${r?.evidenced||0} / ${r?.n||0}，覆盖率 ${((r?.coverage||0)*100).toFixed(1)}%。${esc(r?.warning||'')}</p>${r?.evidence?.slice(0,3).map(a=>`<p class="meta research-evidence"><a data-i18n-skip href="${esc(a.article_url||'#')}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a> · DOI ${esc(a.doi)}<br><span data-i18n-skip>${esc(a.summary)}</span></p>`).join('')||''}<p class="meta">仅基于题名/摘要；候选研究机会需人工评估。</p></section>`;};
const desktopFeed=()=>`${title('LATEST PUBLICATIONS / MONITOR','最新论文雷达','默认最近90天，可切换180天、当前年度及2025基线；类型与摘要缺失单独标记。',`<button class="btn" data-page="alerts">✉ 订阅新论文</button>`)}${warning()}<div class="switches">${marketSelect()}<div class="filters">${topicFilter()}</div></div><div class="article-grid"><section class="card panel"><div class="panel-head"><h2>新论文发现列表</h2><span class="meta">当前筛选共 ${nt(S.data.feed?.total||0)} 篇</span></div><p class="panel-sub">论文发表日与系统首次发现日不同；历史补录不会被伪称为今日发表。</p>${(S.data.feed?.items||[]).length?S.data.feed.items.map(x=>paper(x,true)).join(''):'<div class="empty"><span>▤</span>当前条件下暂无论文。<br>首次同步会从期刊最新元数据开始。</div>'}${(S.data.feed?.total||0)>S.viewLimit&&S.viewLimit<20000?`<button class="btn" id="more-articles" style="width:100%">再加载 20 篇</button>`:''}</section><aside class="card panel sticky-filter"><h2>文章搜索与筛选</h2><p class="panel-sub">可按标题和摘要关键词搜索</p><div class="field"><label for="q-search">关键词</label><input id="q-search" type="text" value="${esc(S.search)}" placeholder="dementia / 长期照护" /></div><div class="field"><label for="journal-filter">指定期刊</label><select id="journal-filter"><option value="">所有期刊</option>${opts((S.data.journals?.items||[]).filter(x=>S.market==='all'||x.market===S.market).map(j=>[j.id,j.title]),S.journal)}</select></div>${periodFilter()}${typeFilter()}<button class="btn primary" id="apply-search" style="width:100%">搜索论文</button><div class="panel-foot">每篇文章保留 DOI / 原始链接。摘要和方法提取都受可获取信息完整度限制。</div></aside></div>`;
const journalsPage=()=>{
 const all=(S.data.journals?.items||[]).filter(j=>S.market==='all'||j.market===S.market);
 return `${title('JOURNAL WATCHLIST / SOURCES','期刊观察名单','中文 C 刊与国外英文期刊分开维护。实际分区须按具体年度核验，未验证的分区不自动宣称为 Q1 或 CSSCI。')}${warning()}<div class="switches">${marketSelect()}<div class="filters">${tag('监测成功 ≠ 新文章零遗漏')}</div></div><div class="journal-list">${all.map(j=>{const state=j.status==='healthy'?'ok':j.status==='failed'?'error':'pending';return `<div class="card journal-card"><div class="article-top"><span class="statuspill ${state==='ok'?'ok':state==='error'?'off':'warn'}">${state==='ok'?'● 最近同步成功':state==='error'?'● 最近同步失败':'○ 尚未完成监测'}</span><span class="meta">${esc(j.source.toUpperCase())}</span></div><strong>${esc(j.title)}</strong><div class="meta">${esc(marketLabel(j.market))} · ISSN ${esc(j.issn||'未配置')}</div><p>${esc(j.rank_system||'观察名单')} ${esc(j.rank_year)} · ${esc(j.rank_verification_status==='verified'?'已核验':'待核验')}</p><div class="health-line"><span class="meta">${j.collection_status==='metadata_ready'?'真实元数据已收录 · '+(j.enabled?'自动监测已启用':'自动监测未启用'):j.collection_status==='source_verified'?'来源已核验 · 待回填':!j.enabled?'来源待配置':`上次成功：${j.last_success?date(j.last_success):'未完成'}`}</span><a href="${esc(/^https?:\/\//.test(j.homepage)?j.homepage:'#')}" target="_blank" rel="noopener noreferrer" class="linkbtn">期刊官网 ↗</a></div>${j.last_error?`<p style="color:#bf6363">错误：${esc(j.last_error)}</p>`:''}</div>`;}).join('')}</div>`;
};
function chinesePanel(edit=false){const d=S.data.chinese;if(!d)return '';if(d.available===false)return chineseQualityPanel(d);const total=d.items.reduce((n,j)=>n+j.total,0);return `${chineseQualityPanel(d)}<section class="card panel cn-diagnostics"><h2>中文期刊接入与覆盖诊断</h2><p>最近180天 ${esc(d.window.start)} — ${esc(d.window.end)}；累计已收录 ${nt(total)} 篇。CSSCI来源版与扩展版按2025—2026官方目录独立核验，待确认不等于已入选。收录覆盖率尚未审计。</p>${edit?`<form data-cn-source class="ops-form"><label>中文期刊<select name="journalId">${opts(d.items.map(j=>[j.id,j.title]),'')}</select></label><label>刊名<input name="title" required></label><label>ISSN<input name="issn" required></label><label>来源<select name="provider">${opts([['catalog','官网公开目录 / 文章元数据'],['rss','官方RSS'],['crossref','Crossref'],['openalex','OpenAlex（需服务端授权）']],'catalog')}</select></label><label>官方地址<input name="url" type="url"></label><label><input name="confirm" type="checkbox" required>已核实公开访问权限、刊名与ISSN；不绕过登录、验证码或付费墙</label><button class="btn" type="submit">验证来源</button><div class="ops-actions"><button class="btn" type="button" data-cn-job="backfill">创建180天回填（暂停）</button><button class="btn" type="button" data-cn-job="incremental">创建增量同步（暂停）</button></div></form><p><a class="btn" href="chinese-import.html">打开中文授权导入工作台</a> · 先暂存、审核许可与论文证据，再分批入库。</p>`:''}<details ${!total?'open':''}><summary>逐刊来源、摘要及分析缺口</summary>${d.items.map(j=>`<div class="cn-source-row"><strong>${esc(j.title)}</strong><p>${esc(j.source)} · enabled=${j.enabled} · market=${esc(j.market)} · ${esc(j.issn||'ISSN待核对')} · ${esc(j.rank_system)} ${esc(j.rank_year)} · ${esc(j.rank_verification_status)}</p><p>收录 ${j.total} · 摘要缺失 ${j.missingAbstract||0} · AI分析成功 ${j.analyzed||0} · ${esc(j.gap)}；独立有效证据见当前市场趋势。</p><p>${esc(chineseSourceStatus(j).metadata)} · ${esc(chineseSourceStatus(j).automatic)} · ${esc(chineseSourceStatus(j).monitoring)} ${esc(chineseSourceStatus(j).error)}</p>${j.jobs.map(b=>`<p>回填 ${esc(b.status)} · ${b.pages}页 · 新增 ${b.added} · 去重 ${b.duplicates} · 日期/身份排除 ${b.rejected}<br>${esc(b.error)} ${edit&&b.status==='paused'?`<button class="btn" data-cn-step="${esc(b.id)}">继续一页（不调用AI）</button><button class="btn" data-cn-cancel="${esc(b.id)}">取消回填</button>`:''}</p>`).join('')}</div>`).join('')}</details></section>`;}
const sourcesPage=()=>{
 const v=S.data.sources||{},list=(v.items||S.data.journals?.items||[]).filter(j=>S.market==='all'||j.market===S.market);
 const remaining=pendingEnglishSources(v.items||[]).length;
 const batch=S.sourceBatch;
 const batchStatus=batch?'<div class="notice info" role="status" aria-live="polite">批量核验：已处理 '+nt(batch.processed)+'/'+nt(batch.total)+' · 成功启用 '+nt(batch.activated)+' · 失败 '+nt(batch.failed)+' · 缺少 ISSN '+nt(batch.skipped)+(batch.cancelRequested?' · 正在停止…':batch.running?' · 正在逐本核验…':batch.cancelled?' · 已停止':batch.unauthorized?' · 管理员认证失败':' · 已结束')+'</div>'+(batch.failures?.length?'<details><summary>查看 '+nt(batch.failures.length)+' 项失败或需人工核对的原因</summary><ul>'+batch.failures.map(f=>'<li>'+esc(f.title)+'：'+esc(f.message)+'</li>').join('')+'</ul></details>':''):'';
 const summary=v.total===undefined?'<div class="notice info">来源状态正在载入；如果升级了前端但后端仍是旧版，请先检查 /api/journal-source-status 接口。</div>':`<div class="source-summary">${[['观察名单',v.total],['已验证自动来源',v.verifiedAutomatic],['已有元数据记录',v.metadataCollected??v.metadataConnected],['监测正常',v.monitored],['中文人工导入后备',v.manualFallback],['自动来源待确认',v.pendingConfirmation],['历史回填进行中',v.backfillRunning],['来源范围已遍历',v.backfillEnumerated],['已启用',v.enabled]].map(([n,x])=>`<div class="source-stat"><small>${n}</small><b>${nt(x)}</b></div>`).join('')}</div>`;
 const state=j=>j.collection_status==='metadata_ready'?['ok','真实元数据已收录']:j.collection_status==='source_verified'?['warn','来源已核验，尚未收录']:j.market==='chinese'?['warn','尚未收录元数据']:j.status==='healthy'?['ok','最近同步成功']:j.status==='failed'?['off','同步失败']:['warn',({pending:'待接入',unverified:'来源待核验',stale:'成功记录已过期',awaiting_first_scan:'待首次监测'})[j.status]||'待核验'];
 return `${title('JOURNAL SOURCE CONTROL / OPERATIONS','期刊来源管理','在公开页面查看真实数据源状态。管理员可以测试 Crossref 的期刊身份，验证通过后才允许启用。',`<button class="btn" data-reload="1">↻ 刷新来源</button>`)}${warning()}${chinesePanel(true)}${summary}
 <div class="notice info">期刊历史回填与 AI 解析进度可以在 <button class="linkbtn" data-page="operations">AI 解析与历史回填中心 ↗</button> 查看。期刊接入不需要 DeepSeek。Crossref 验证仅适用于英文期刊；中文 C 刊必须先有可合法使用的官方目录、RSS 或管理员导入渠道。此页面不会保存管理员密钥。</div>
 <div class="switches">${marketSelect()}<span class="meta">ISSN 与 DOI 样本都匹配后才可启用 · ${list.length} 本</span></div>
 ${S.sourceMessage?`<div role="status" class="source-result ${S.sourceError?'notice error':''}">${esc(S.sourceMessage)}</div>`:''}
 <section class="card panel source-discover-panel"><div class="panel-head"><div><h2>英文期刊 ISSN 自动调查</h2><p class="panel-sub">参考 Crossref 已注册论文反向寻找 ISSN，任务可以断点恢复；仅提出建议，不会自行启用期刊或调用 DeepSeek。</p></div></div>
 <div class="source-actions"><button type="button" class="btn slim primary" data-bulk-source-activate="1" ${S.busy||!remaining?"disabled":""}>${remaining?"批量核验并启用剩余 "+nt(remaining)+" 本英文期刊":"英文期刊已全部启用"}</button>${batch?.running?`<button type="button" class="btn slim" data-bulk-source-cancel="1" ${batch.cancelRequested?"disabled":""}>停止后续核验</button>`:""}</div>
 <p class="panel-sub">每次只输入一次管理员密钥，逐本请求 Crossref 核验 ISSN、期刊名称与 DOI；已启用期刊自动跳过，未验证通过的不启用，也不调用 DeepSeek。关闭页面会中止后续操作。</p>
 ${batchStatus}
 <div class="source-actions"><button class="btn slim" data-discovery-create="1">创建待配置英文期刊调查</button><button class="btn slim primary" data-discovery-start-all="1">启动待调查任务</button><button class="btn slim" data-discovery-refresh="1">刷新调查状态</button></div>
 <div class="discovery-items">${(S.discoveries||[]).length?(S.discoveries||[]).map(d=>`<div class="discovery-item"><div class="article-top"><strong>${esc(d.title)}</strong><span class="statuspill ${d.status==='completed'?'ok':d.status==='failed'?'off':'warn'}">${esc(({paused:'待启动',queued:'排队中',running:'调查中',completed:'已找到候选',needs_review:'人工调查',failed:'调查失败'})[d.status]||d.status)}</span></div><div class="meta">${d.candidates?.length?d.candidates.map(c=>`${esc(c.issn)}（证据 ${nt(c.evidenceCount)} 篇）`).join('；'):'暂无可核验的 ISSN 候选'} ${d.last_error?`· 错误 ${esc(d.last_error)}`:''}</div>${(d.candidates||[]).map(c=>`<div class="source-actions"><button class="btn slim" data-use-discovery="${esc(d.journal_id)}" data-issn="${esc(c.issn)}">填入 ${esc(c.issn)} 并准备检测</button><small class="meta">DOI 证据：${esc((c.doiSamples||[]).join(' · '))}</small></div>`).join('')}${d.status==='failed'?`<button class="btn slim" data-discovery-retry="${esc(d.id)}">重试</button>`:''}</div>`).join(''):'<div class="meta">尚无调查任务；管理员可批量创建并启动。</div>'}</div>
 </section>
 <div class="source-journal-grid">${list.map(j=>{const [tone,status]=state(j),canTest=j.market==='international';return `<article class="card journal-card"><div class="article-top"><span class="statuspill ${tone}">● ${status}</span><span class="meta">${esc((j.source||'manual').toUpperCase())}</span></div><strong>${esc(j.title)}</strong><div class="meta">${esc(marketLabel(j.market))} · ${esc(j.rank_system||'分区待核验')} · ${esc(j.rank_verification_status==='verified'?'分区已核验':'分区待核验')}</div><div class="meta">ISSN ${esc(j.issn||'尚未配置')} · 上次检查 ${date(j.last_checked)} · 上次成功 ${date(j.last_success)} · 最近新增 ${nt(j.last_count)}</div><div class="meta">${j.history?`历史回填：${esc(j.history.status)} · ${esc(j.history.from_date)} → ${esc(j.history.to_date)} · 本任务新增 ${nt(j.history.added_articles)} 篇 · 本刊累计 ${nt(j.article_count)} 篇（来源遍历完成不等于全部文献齐全）`:'尚无历史回填任务'}</div>${j.evidence?`<details><summary>查看来源验证证据</summary><p class="meta">${esc(j.evidence.checked_at)} · ${esc(j.evidence.error||'身份验证通过')}</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(j.evidence.sample||[],null,2))}</pre></details>`:''}${j.last_error?`<p style="color:#d88a88">最近错误：${esc(j.last_error)}</p>`:''}<form class="source-form" data-rss-form="${esc(j.id)}"><label>RSS / Atom 地址（仅允许逐刊审核的 HTTPS 主机）<input name="rss_url" type="url" maxlength="2048" value="${esc(j.rss_url||'')}" placeholder="https://官方主机/实际订阅地址"></label><small>已审核主机：${esc((j.rss_allowed_hosts||[]).join('、')||'尚无；需先在期刊配置中审核来源')}</small><div class="source-actions">${[['test','测试'],['save','保存并暂停'],['enable','验证并启用'],['pause','暂停']].map(([action,label])=>`<button type="button" class="btn slim" data-rss-action="${action}">${label}</button>`).join('')}</div></form>${canTest?`<form class="source-form" data-source-form="${esc(j.id)}"><label for="source-${esc(j.id)}">Crossref 数据源 ISSN（需由管理员核实）</label><div class="source-actions"><input id="source-${esc(j.id)}" type="text" name="issn" placeholder="1234-567X" pattern="[0-9]{4}-[0-9]{3}[0-9Xx]" maxlength="9" value="${esc(j.issn||j.candidate_issn||'')}" required aria-label="${esc(j.title)} ISSN"><button type="submit" class="btn slim">检测来源</button>${!j.enabled?`<button type="button" class="btn slim primary" data-source-activate="${esc(j.id)}">核验并启用</button>`:''}</div></form>`:`<div class="source-form"><small>中文来源尚未验证，禁止直接开通 Crossref。</small><a class="linkbtn" href="${esc(/^https:\/\//.test(j.homepage||'')?j.homepage:'#')}" target="_blank" rel="noopener noreferrer">查看期刊主页 ↗</a></div>`}</article>`}).join('')}</div><div class="chart-notes">来源验证只检验少量真实元数据样本，不等于零漏检或全部年份覆盖。启用后请前往「监测健康状态」检查首次正式同步。</div>`;
};
const opsState=status=>({paused:'已暂停',running:'进行中',completed:'已完成',cancelled:'已取消',failed:'失败'})[status]||status;
const automaticPanel=()=>{const a=S.data.autoAI,c=a?.counts||{};return `<section id="automatic-ai-panel" class="card panel"><h2>英文论文持续自动分析</h2>${a?`<p>状态：${esc(({running:'持续处理中',paused:'已暂停',stopped:'已停止',blocked:'异常暂停'})[a.state]||a.state)} · ${esc(a.reason||'')}</p><p>已完成 ${nt((c.completed||0)+(c.cached||0))} · 待处理 ${nt(c.queued)} · 正在处理 ${nt(c.running)} · 失败 ${nt(c.failed)} · 累计入队 ${nt(a.total)} · 符合条件 ${nt(a.eligible)} · 最近180天 ${nt(a.eligibleRecent180)}</p><p class="meta">优先最近180天、来源已核验且摘要充分的英文论文。已有结果不重复提交；不设金额或累计篇数上限。暂停或停止后，已发出的当前请求可能仍会完成。</p><div class="source-actions"><button class="btn primary" data-auto-ai="resume" ${!a.enabled||!a.keyConfigured?'disabled':''}>继续自动分析</button><button class="btn" data-auto-ai="pause">暂停自动分析</button><button class="btn" data-auto-ai="stop">停止自动分析</button></div>${!a.enabled?'<p class="meta">生产 AI 服务尚未启用。</p>':''}`:'<p>自动分析状态暂不可用。</p>'}</section>`;};
const opsPage=()=>{
 const journals=(S.data.journals?.items||[]).filter(j=>j.enabled&&j.source==='crossref');
 const backfills=S.data.backfills?.items||[],batches=S.data.batches||[];
 const coverage=S.data.coverage;
 const progress=b=>`${b.progress?.percent??0}%`;
 return `${title('RESEARCH OPERATIONS / DURABLE TASKS','AI 解析与历史回填','期刊监测不调用 DeepSeek；AI 解析由管理员明确启动，费用由 DeepSeek 账户余额控制。任务状态存入 SQLite，服务器重启不会清空进度。',`<button type="button" class="btn" data-ops-refresh="1">↻ 更新进度</button>`)}
 ${warning()}
 ${automaticPanel()}
 <p class="meta">覆盖范围：${esc(coverage?.window?.start||'全部收录')} — ${esc(coverage?.window?.end||'当前')} · 分析成功 ${nt(coverage?.statuses?.analyzed)} 篇 · 有效证据 ${nt(coverage?.evidenced)} 篇 · 证据覆盖 ${((coverage?.evidenceCoverage||0)*100).toFixed(1)}%。</p>
 ${S.opsMessage?`<div class="notice ${S.opsError?'error':'info'}" role="status">${esc(S.opsMessage)}</div>`:''}
 <div class="kpis">${kpi('收录论文',nt(coverage?.total||0),'当前年度观察期','▤')}${kpi('AI 已解析',nt(coverage?.statuses?.analyzed||0),'并非全部有有效方法证据','✓','blue')}${kpi('有效研究设计',nt(coverage?.validDesign||0),'仅计已识别方法证据','◇','orange')}${kpi('摘要不足',nt(coverage?.missingAbstract||0),'不能凭题目编造研究设计','!','purple')}</div>
 <section class="card panel"><h2>优先补充当前年度摘要与文章类型</h2><p>通过 Europe PMC 公开元数据核对 DOI / ISSN；不下载全文，不调用 AI，不覆盖既有 AI 结果。</p><button type="button" class="btn" data-enrich-metadata="1">管理员补充20篇开放元数据</button></section><div class="cols equal">
 <section class="card panel"><h2>① 创建 AI 批量解析任务</h2><p class="panel-sub">默认只准备当前年度最新、高相关且有类型证据的原创研究；摘要充足才入选，数量不足不凑数。已有有效解析结果自动复用；无需每日调用限额或单批预算。仅分析标题和有效摘要，按 Token 计费，由 DeepSeek 账户余额结算。</p>
 <form data-ai-batch-form="1" class="ops-form"><input type="hidden" name="policy" value="trend_candidates">
 <div class="ops-fields"><label>起始年<input name="yearFrom" type="number" min="2000" max="2100" value="${researchYear()}" required></label><label>结束年<input name="yearTo" type="number" min="2000" max="2100" value="${researchYear()}" required></label><label>最多篇数<input name="limit" type="number" min="1" max="200" value="20" required></label></div>
 <label>指定期刊（可选）<select name="journalId"><option value="">所有已收录期刊</option>${(S.data.journals?.items||[]).map(j=>`<option value="${esc(j.id)}">${esc(j.title)}</option>`).join('')}</select></label>
 <button class="btn primary" type="submit">创建任务（不会自动付费）</button>
 </form><div class="panel-foot">任务创建后默认为暂停；管理员点击「启动」才会调用 DeepSeek。不设 FanScope 金额或每日次数上限；费用估算仅供参考，实际余额与收费以 DeepSeek 平台为准。</div>
 </section>
 <section class="card panel"><h2>② 创建期刊历史回填任务</h2><p class="panel-sub">优先回填当前年度；2025 年保留为可选基线。与正常监测分开保存检查点，分页去重；不会调用 AI。</p>
 <form data-backfill-form="1" class="ops-form"><label>优先时间窗口<select name="period"><option value="ytd">当前年度至今（优先）</option><option value="30d">最近30天</option><option value="90d">最近90天</option><option value="180d">最近180天</option><option value="">按下方年份（2025可选）</option></select></label>
 <label>期刊<select name="journalId" required><option value="">选择已启用 Crossref 期刊</option>${journals.map(j=>`<option value="${esc(j.id)}">${esc(j.title)}</option>`).join('')}</select></label>
 <div class="ops-fields"><label>起始年<input name="yearFrom" type="number" min="2000" max="2100" value="${researchYear()}" required></label><label>结束年<input name="yearTo" type="number" min="2000" max="2100" value="${researchYear()}" required></label></div>
 <button class="btn primary" type="submit">创建回填（暂不执行）</button>
 </form><div class="panel-foot">只支持正式启用的 Crossref 期刊。中文期刊尚无可靠来源时仍处于待配置状态，不会假装抓到真实文章。首次回填不触发新增论文邮件轰炸。</div>
 </section></div>
 <section class="card panel ops-queue"><h2>③ 中文授权批量导入</h2><p>CSV文件先进入隔离暂存区；来源许可和论文证据分别人工审核后，每批最多100条入库。</p><a class="btn primary" data-open-authorized-import="1" href="chinese-import.html">打开授权导入工作台</a></section>
 <section class="card panel ops-queue"><div class="panel-head"><h2>AI 解析任务</h2><button class="btn slim" type="button" data-ops-load-batches="1">管理员读取任务详情</button></div>
 <p class="panel-sub">任务详情需要管理员密钥，每次操作临时输入，不存放在浏览器。页面默认不会公开研究经费账本。</p>
 ${batches.length?batches.map(b=>`<div class="ops-job"><div><div class="ops-job-heading"><strong>任务 ${esc(b.id.slice(0,8))}</strong>${tag(b.status==='completed'&&b.counts?.failed?'处理结束 · 含失败项':opsState(b.status))}</div><small>${esc(b.filter?.yearFrom)}–${esc(b.filter?.yearTo)} · ${nt(b.total)} 篇</small><div class="ops-track" role="progressbar" aria-label="任务已处理比例" aria-valuemin="0" aria-valuemax="${b.total||1}" aria-valuenow="${b.progress?.settled||0}" aria-valuetext="已处理 ${b.progress?.settled||0} / ${b.total}，不是分析成功率"><span style="width:${progress(b)}"></span></div><small>已处理 ${nt(b.progress?.settled)} / ${nt(b.total)}（${b.total?progress(b):'空批次'}） · 分析成功 ${nt(b.counts?.completed)} · 缓存复用 ${nt(b.counts?.cached)} · 有效证据 ${nt(b.progress?.evidenced)} · 成功但证据不足 ${nt(b.progress?.withoutEvidence)}</small><small>进行中 ${nt(b.counts?.running)} · 等待 ${nt(b.counts?.queued)} · 摘要不足 ${nt(b.counts?.insufficient_abstract)} · 失败 ${nt(b.counts?.failed)} · 排除 ${nt(b.counts?.excluded)}${b.progress?.nextRetryAt?' · 下次退避重试 '+esc(new Date(b.progress.nextRetryAt).toLocaleString('zh-CN')):''}</small><small>API 请求 ${nt(b.usage?.requests)} 次 · 已报告 Token：输入 ${nt(b.usage?.inputTokens)} / 输出 ${nt(b.usage?.outputTokens)}<br>费用估算 ${b.usage?.estimatedCostCny==null?'未知（价格未配置，不能合计）':'¥'+Number(b.usage.estimatedCostCny).toFixed(6)} · 已定价且用量已报告估算 ¥${Number(b.usage?.reportedCostCny||0).toFixed(6)} · 用量未知预留 ¥${Number(b.usage?.reservedCostCny||0).toFixed(6)}<br>用量未知 ${nt(b.usage?.uncertainRequests)} 次 · 未定价 ${nt(b.usage?.unpricedRequests)} 次；预留不是已确认扣费，最终以供应商账单为准。缓存复用不产生新的 API 请求。</small>${b.failures?.length?`<details class="ops-failures"><summary>查看失败与等待原因</summary>${b.failures.map(f=>`<p>${f.status==='queued'?'等待重试':'失败'} ${nt(f.count)} 篇：${esc(f.message)}${f.mayHaveCost?'。该请求可能已产生费用；人工重试可能再次收费。':''}</p>`).join('')}</details>`:''}</div><div class="ops-actions">${b.counts?.failed>0&&!['running','cancelled'].includes(b.status)?`<button class="btn slim" data-ai-action="retry" data-ai-id="${esc(b.id)}">人工重试失败项（可能再次收费）</button>`:''}${b.status==='paused'?`<button class="btn slim primary" data-ai-action="start" data-ai-id="${esc(b.id)}">启动</button>`:''}${b.status==='running'?`<button class="btn slim" data-ai-action="pause" data-ai-id="${esc(b.id)}">暂停</button>`:''}${!['cancelled','completed'].includes(b.status)?`<button class="btn slim" data-ai-action="cancel" data-ai-id="${esc(b.id)}">取消</button>`:''}</div></div>`).join(''):'<div class="empty">点击「管理员读取任务详情」加载已有任务；创建新任务后本页也会显示。</div>'}</section>
 <section class="card panel ops-queue"><h2>期刊历史回填任务</h2><p class="panel-sub">公开展示非敏感任务进度；回填只存储论文元数据和来源证据。后台每轮有抓取预算，失败时暂停等待管理员处理。</p>
 ${backfills.length?backfills.map(b=>`<div class="ops-job"><div><strong>${esc(b.journal_title)}</strong> · ${tag(opsState(b.status))}<small>${esc((b.from_date||'').slice(0,10))} → ${esc((b.to_date||'').slice(0,10))} · 已收录 ${nt(b.added_articles)} 篇 · 已处理 ${nt(b.pages_done)} 页</small><small>当前扫描窗：${esc((b.window_start||'').slice(0,10))||'尚未开始'} → ${esc((b.window_end||'').slice(0,10))||'尚未开始'}</small>${b.error?`<div class="meta ops-error">${esc(b.error)}</div>`:''}</div><div class="ops-actions">${b.status==='paused'?`<button class="btn slim primary" data-backfill-action="start" data-backfill-id="${esc(b.id)}">启动 / 继续</button>`:''}${b.status==='running'?`<button class="btn slim" data-backfill-action="pause" data-backfill-id="${esc(b.id)}">暂停</button>`:''}${!['cancelled','completed'].includes(b.status)?`<button class="btn slim" data-backfill-action="cancel" data-backfill-id="${esc(b.id)}">取消</button>`:''}</div></div>`).join(''):'<div class="empty">暂无历史回填任务。创建任务后不会立即启动。</div>'}</section>
 `;
};
const chartTitles=['观察期内逐月文章量','主题 × 月份','研究设计 × 期刊','统计方法 × 月份','样本量箱线图（按单位分开）','数据来源 × 月份','主题 × 统计方法'];
const desktopTrends=()=>`${title('RESEARCH TRENDS / EVIDENCE','研究趋势与方法画像','仅描述系统收录和有证据的分析样本，不计算投稿录用概率。')}${warning()}${trendFilters()}<details class="trend-evidence"><summary>分析成功 ${nt(S.data.research?.analyzed)} 篇 · 有效证据 ${nt(S.data.research?.evidenced)} 篇 · 证据覆盖 ${((S.data.research?.coverage||0)*100).toFixed(1)}% · 查看证据与限制</summary>${researchBrief()}</details><div class="notice">${esc(S.data.research?.warning||'')}<button class="btn slim" data-compare-baseline="1">可选同区间基线比较</button></div>${S.comparison?`<section class="card panel"><h2>同区间基线（${esc(typeLabel(S.comparison.article_type))}）</h2><p>${S.comparison.status==='insufficient'?'暂无可比较的同类型共同期刊，不能进行同比。':'仅描述相同期刊、相同类型、相同月日区间的收录样本。'}</p><p>${esc(S.comparison.current.start)} → ${esc(S.comparison.current.end)}：${nt(S.comparison.current.n)} 篇；${esc(S.comparison.baseline.start)} → ${esc(S.comparison.baseline.end)}：${nt(S.comparison.baseline.n)} 篇</p><p>共同期刊 ${nt(S.comparison.journals.length)} 本；排除日期精度不足 ${nt(S.comparison.excludedImprecise)} 篇。${esc(S.comparison.warning)}</p></section>`:''}<div class="cols equal trend-desktop-grid">${chartTitles.map((t,i)=>`<section class="card panel"><h2>${t}</h2><div class="echart" id="chart-${i}" role="img" aria-label="${t}"></div><p class="meta">${chartQuality(i)}</p></section>`).join('')}</div>`;
let charts=[];
function drawCharts(){
 for(const c of charts)c.dispose();charts=[];if(S.page!=='trends'||!window.echarts)return;
 document.querySelectorAll('.visual-mode').forEach(el=>el.remove());
 if(isMobile()){drawMobileTrends();return;}
 const r=S.data.research;if(!r)return;
 const temporal=(id,matrix,label,n)=>mountTrend(id,temporalOption(matrix,r.monthly,label,n),Object.keys(matrix||{}).length>0);
 temporal('chart-0',Object.fromEntries(Object.entries(r.monthly||{}).map(([m,n])=>[m+'|收录论文',n]).filter(([,n])=>n>0)),x=>t(x),r.known.date);
 temporal('chart-1',r.topics,topicLabel,r.dated?.topics??r.known.topics);
 temporal('chart-3',r.methods,methodName,r.dated?.methods??r.known.methods);
 temporal('chart-5',r.sources,sourceName,r.dated?.data??r.known.data);
 // Full HTML labels keep long journal names readable and keyboard-selectable.
 const records=(id,rows)=>{const el=document.getElementById(id);if(!el)return;el.classList.add('chart-records');el.innerHTML=rows.length?`<div class="evidence-bars">${rows.map(row=>`<div class="evidence-bar"><span>${esc(row.name)}<small>${esc(row.detail||'')}</small></span><meter min="0" max="${Math.max(...rows.map(x=>x.n))}" value="${row.n}">${row.n}</meter><b>${nt(row.n)}</b></div>`).join('')}</div>`:'<div class="chart-empty">当前没有有效证据记录。</div>';};
 const known=r.known.design;if(known===0)records('chart-2',[]);else records('chart-2',Object.entries(r.designs).map(([key,n])=>{const at=key.lastIndexOf('|');return {name:key.slice(0,at),detail:designLabel(key.slice(at+1)),n};}).sort((a,b)=>b.n-a.n));
 records('chart-6',Object.entries(r.matrix).map(([key,n])=>{const at=key.indexOf('|');return {name:topicLabel(key.slice(0,at)),detail:methodName(key.slice(at+1)),n};}).sort((a,b)=>b.n-a.n));
 const groups=Object.entries(r.samples||{}).map(([unit,values])=>({unit,values:values.slice().sort((a,b)=>a-b)}));
 const el=document.getElementById('chart-4');if(el){el.innerHTML=groups.length?groups.map((g,i)=>`<p class="visual-note">${esc(unitName(g.unit))} · 有效样本 n=${g.values.length}${g.values.length<5?' · 少于5篇，逐篇展示样本量':''}</p><div id="sample-unit-${i}" class="visual-chart"></div>`).join(''):'<div class="chart-empty">当前没有有效样本证据记录。</div>';groups.forEach((g,i)=>{const q=f=>g.values[Math.floor((g.values.length-1)*f)];if(g.values.length<5)mountTrend('sample-unit-'+i,barOption(g.values.map((n,j)=>({name:t('论文')+' '+(j+1),n})),x=>x));else mountTrend('sample-unit-'+i,{tooltip:{trigger:'item'},grid:{left:8,right:12,top:18,bottom:26,containLabel:true},xAxis:{type:'category',data:[unitName(g.unit)]},yAxis:{type:'value',minInterval:1},series:[{type:'boxplot',data:[[g.values[0],q(.25),q(.5),q(.75),g.values.at(-1)]],itemStyle:{color:chartColors[i%chartColors.length]}}]});});}
}
window.addEventListener('fanscope-language-change',()=>{if(S.page==='trends')drawCharts();});
window.addEventListener('resize',()=>charts.forEach(c=>c.resize()));window.addEventListener('fanscope-theme-change',()=>{if(S.page==='trends')drawCharts();});
const alerts=()=>`${title('EMAIL DIGEST / SUBSCRIBE','论文更新通知','只发送你关心的课题方向。邮箱需验证成功后才会启用通知。')}${warning()}<div class="cols equal"><section class="card panel"><div class="panel-head"><h2>订阅 FanScope 研究雷达</h2><span class="statuspill ${S.data.health?.emailConfigured?'ok':'warn'}">${S.data.health?.emailConfigured?'● 邮件服务就绪':'○ 邮件服务未配置'}</span></div><p class="panel-sub">验证邮件发送后，请到收件箱点击确认。没有配置邮件服务时不会假装发送成功。</p><form id="subscribe-form"><div class="field"><label for="subscriber-email">接收邮箱</label><input required id="subscriber-email" name="email" type="email" placeholder="yourname@sjtu.edu.cn"/></div><div class="field"><label>研究领域</label>${(S.data.topics?.items||[]).map(t=>`<label class="alert-row"><span>${esc(t.label)}</span><input class="toggle" type="checkbox" name="topic" value="${t.id}" checked/></label>`).join('')}</div><div class="field"><label>期刊体系</label><label class="alert-row">国内中文 C 刊<input class="toggle" type="checkbox" name="market" value="chinese" checked/></label><label class="alert-row">国外英文期刊<input class="toggle" type="checkbox" name="market" value="international" checked/></label></div><div class="field"><label>通知频率</label><label class="alert-row"><span><strong>重点文章及时提醒</strong><p>发现新增相关论文后自动发送（受来源收录延迟影响）</p></span><input class="toggle" type="checkbox" name="urgent" checked/></label><label class="alert-row"><span><strong>每日论文简报</strong><p>按北京时间 08:00 左右汇总过去24小时</p></span><input class="toggle" type="checkbox" name="daily" checked/></label><label class="alert-row"><span><strong>每周趋势摘要</strong><p>每周一上午按近7天新发现论文发送</p></span><input class="toggle" type="checkbox" name="weekly"/></label></div><button type="submit" class="btn primary" style="width:100%" ${S.data.health?.emailConfigured?'':'disabled'}>✉ 发送邮箱验证链接</button>${S.emailMessage?`<div class="form-feedback ${S.emailError?'error':''}">${esc(S.emailMessage)}</div>`:''}</form></section><section class="card panel"><h2>邮件是怎样产生的？</h2><p class="panel-sub">服务器持续监测，无需你保持浏览器或电脑开启。</p>${[['01','期刊数据源更新','期刊官方元数据 / 配置的 RSS'],['02','自动识别相关主题','照护、老龄化、AI、社会救助、灾害健康'],['03','DeepSeek 补充结构化摘要','仅有摘要时不臆造样本量及研究方法'],['04','投递电子邮件','双重确认订阅 · 自动去重 · 可退订']].map(([n,t,d])=>`<div class="alert-row"><div style="display:flex;gap:12px;align-items:center"><div class="kpi-icon">${n}</div><div><strong>${t}</strong><p>${d}</p></div></div></div>`).join('')}<div class="notice info" style="margin-top:18px">注意：微信普通群自动推送不在 v1 范围内。避免将付费全文或课题组内部数据发往第三方模型。</div></section></div>`;
const health=()=>{
 const h=S.data.system||{journals:[],jobs:[]},js=h.journals||[];
 const cov=S.data.coverage;
 const coveragePanel=cov?`<section class="card panel" style="margin-bottom:17px"><div class="panel-head"><h2>AI 论文解析覆盖率</h2><span class="meta">只统计真实数据库记录</span></div><p class="panel-sub">已收录与已解析不是一回事；有效设计、方法和样本是三个独立口径。</p><div class="kpis" style="margin-top:16px">${kpi('收录文章',nt(cov.total),'当前年度观察期','▤')}${kpi('成功解析',nt(cov.statuses.analyzed||0),'结构化 AI 记录','✓','blue')}${kpi('已识别研究设计',nt(cov.validDesign),'有可用分类','◇','orange')}${kpi('摘要不足',nt(cov.missingAbstract),'不能仅凭题名推断','!','purple')}</div><div class="panel-foot">有效证据 ${nt(cov.evidenced)} 篇 · 证据覆盖 ${((cov.evidenceCoverage||0)*100).toFixed(1)}% · 已识别数据来源 ${nt(cov.validData)} 篇 · 已识别统计方法 ${nt(cov.validMethods)} 篇 · 已识别样本量 ${nt(cov.validSamples)} 篇 · 其余不自动填补为虚构数据。批量解析由管理员在服务器创建，默认不会自动产生 AI 费用。</div></section>`:'';
 return `${title('MONITOR HEALTH / OPERATIONS','数据源与监测状态','区分「没发现新论文」与「监测失败」。期刊上线前必须检查来源是否真正可用。',`<button class="btn" data-reload="1">↻ 刷新状态</button>`)}${warning()}${chinesePanel()}${coveragePanel}<div class="kpis">${kpi('已启用监测',nt(js.filter(j=>j.enabled).length),'启用数量不等于来源健康','▣')}${kpi('最近同步成功',nt(js.filter(j=>j.status==='healthy').length),'完成至少一次来源同步','✓','blue')}${kpi('故障数据源',nt(js.filter(j=>j.last_error).length),'需要排查 API / 网络 / 来源','!','orange')}${kpi('中文待接入',nt(js.filter(j=>j.market==='chinese'&&!j.bulk_connection?.verified).length),'不能宣称实时监测','◌','purple')}</div><section class="card panel"><h2>来源监测记录</h2><p class="panel-sub">来自服务器实际任务记录，无静态演示值</p><div class="table-wrap"><table><thead><tr><th>期刊</th><th>体系</th><th>状态</th><th>上次检查</th><th>上次成功</th><th>最新结果</th></tr></thead><tbody>${js.map(j=>`<tr><td>${esc(j.title)}</td><td>${esc(marketLabel(j.market))}</td><td><span class="dot ${j.status==='healthy'?'ok':j.status==='failed'?'error':'warn'}"></span>${j.collection_status==='metadata_ready'?'元数据已收录':j.collection_status==='source_verified'?'来源已核验':!j.enabled?'待配置':j.scan?.status==='paused'?'部分完成 / 待续跑':j.last_error?'失败':j.status==='healthy'?'成功':j.status==='stale'?'成功记录已过期':j.status==='unverified'?'来源待核验':'待首次检查'}</td><td>${date(j.last_checked)}</td><td>${date(j.last_success)}</td><td>${j.last_error?`<span style="color:#c26d6d">${esc(j.last_error)}</span>`:`发现 ${nt(j.last_count)} 篇`}${j.scan?`<p class="meta">窗口 ${esc(j.scan.window_start)} → ${esc(j.scan.window_end)}<br>${esc(j.scan.status)} · 已处理 ${j.scan.processed}/${j.scan.total??'?'} · 重试 ${j.scan.attempts}</p>`:''}${j.enabled?`<button class="btn slim" data-retry-journal="${j.id}">管理员重试</button>`:''}</td></tr>`).join('')}</tbody></table></div></section><div class="cols equal"><section class="card panel"><h2>最近执行任务</h2><p class="panel-sub">只展示最近12条记录</p>${(h.jobs||[]).length?(h.jobs||[]).slice(0,8).map(j=>`<div class="alert-row"><div><strong>${esc(j.kind)} · ${esc(j.status)}</strong><p>${date(j.start_at)} · ${esc(String(j.details||'').slice(0,95))}</p></div></div>`).join(''):'<div class="empty">暂无执行记录</div>'}</section><section class="card panel"><h2>部署检查</h2><p class="panel-sub">运行环境的实际配置情况</p><div class="alert-row"><strong>DeepSeek API</strong><span class="statuspill ${S.data.health?.aiConfigured?'ok':'warn'}">${S.data.health?.aiConfigured?'已配置':'未配置'}</span></div><div class="alert-row"><strong>邮件服务</strong><span class="statuspill ${S.data.health?.emailConfigured?'ok':'warn'}">${S.data.health?.emailConfigured?'已配置':'未配置'}</span></div><div class="alert-row"><strong>前端 HTTPS 访问</strong><span class="statuspill ${location.protocol==='https:'?'ok':'warn'}">${location.protocol==='https:'?'HTTPS':'本地 / HTTP'}</span></div><div class="panel-foot">手动触发同步请在服务器运行 npm run scan，或通过带管理员密钥的管理接口操作。</div></section></div>`;
};
const locked=()=>`${title('LAB / ROADMAP',names[S.page],'本模块已列入规划，但第一版不上传、不解析、不对外披露课题组内部数据库。')}<div class="locked-block"><span style="font-size:37px">♙</span><strong>${names[S.page]} · 待开放</strong><p>当前优先保证国内外期刊监测、最新论文发现、邮件通知与趋势可视化真实可靠。后续模块在数据授权和质量评估完成后再开发。</p><button class="btn" data-page="home">返回学术情报首页</button></div>`;
async function get(path){const r=await fetch(API+path,{signal:AbortSignal.timeout(17000)});if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();}
async function load(){S.status='loading';render();try{
 const [health,topics,journals,system]=await Promise.all([get('/api/health'),get('/api/topics'),get('/api/journals'),get('/api/system-status')]);
 S.data.health=health;S.data.topics=topics;S.data.journals=journals;S.data.system=system;S.status='ready';
 await refreshPage();
 }catch(e){console.warn('FanScope API not available',e.message);S.status='error';render();}
}
async function fetchFeed(qs,append=false){
 const key=qs.toString();let items=append&&S.data.feedQuery===key?[...(S.data.feed?.items||[])]:[],total=Infinity;
 while(items.length<S.viewLimit&&items.length<total){
  const page=await get('/api/articles?'+key+'&limit='+Math.min(100,S.viewLimit-items.length)+'&offset='+items.length);
  total=page.total;if(!page.items?.length)break;items.push(...page.items);
 }
 return {items,total:Number.isFinite(total)?total:items.length,query:key};
}
async function refreshPage({append=false}={}){if(S.status!=='ready')return;const version=++refreshVersion;S.loading=true;render();
 const qs=new URLSearchParams();if(S.market!=='all')qs.set('market',S.market);if(S.topic)qs.set('topic',S.topic);if(S.journal)qs.set('journal',S.journal);if(S.search)qs.set('q',S.search);qs.set('period',S.period);qs.set('view',S.view);qs.set('article_type',S.articleType);if(S.year)qs.set('year',S.year);if(S.link)qs.set('link',S.link);
 try{const [stats,latest,feed,research]=await Promise.all([get('/api/stats?'+qs.toString()),get('/api/articles?limit=8&'+qs.toString()),fetchFeed(qs,append),get('/api/research?'+qs.toString())]);if(version!==refreshVersion)return;S.data.research=research;S.data.stats=stats;S.data.latest=latest;S.data.feed=feed;S.data.feedQuery=feed.query;for(const a of [...latest.items,...feed.items])articleCache.set(a.id,a);
 if(S.page==='article'&&!articleCache.has(S.articleId)&&S.articleTitle){const found=await get('/api/articles?period=all&limit=100&q='+encodeURIComponent(S.articleTitle.slice(0,80)));for(const a of found.items||[])articleCache.set(a.id,a);}
 if(S.page==='home'){const recent=await get('/api/articles?limit=3&view=publication&period=90d&precise_date=1');if(version!==refreshVersion)return;S.data.recentPublications=recent;for(const a of recent.items||[])articleCache.set(a.id,a);}
 if(S.page==='health'){S.data.system=await get('/api/system-status');S.data.coverage=await get('/api/analysis-coverage').catch(()=>null);}
 if(['sources','health','trends','feed','journals','home'].includes(S.page))S.data.chinese=await readChineseDiagnostics(get);
 if(S.page==='sources'){S.data.sources=await get('/api/journal-source-status').catch(()=>null);S.discoveries=(await get('/api/journal-discoveries').catch(()=>({items:[]}))).items||[];}
 if(S.page==='operations'){S.data.coverage=await get('/api/analysis-coverage').catch(()=>null);S.data.backfills=await get('/api/journal-backfill-status').catch(()=>({items:[]}));S.data.autoAI=await get('/api/ai-auto-status').catch(()=>null);}
 }catch(e){if(version!==refreshVersion)return;console.warn('API refresh failed',e.message);S.status='error';}
 if(version!==refreshVersion)return;S.loading=false;render();
}
const mainSection=()=>S.page==='me'?myWorkspace():S.page==='article'?articleDetail():S.page==='home'?home():S.page==='feed'?feed():S.page==='journals'?journalsPage():S.page==='trends'?trends():S.page==='alerts'?alerts():S.page==='health'?health():S.page==='sources'?sourcesPage():S.page==='operations'?opsPage():locked();
const section=()=>mainSection()+(['feed','journals'].includes(S.page)&&S.market==='chinese'?chineseQualityPanel(S.data.chinese):'');
const claimLinks=c=>(c.evidence_ids||[]).map(id=>{const a=S.data.research?.generatedBrief?.evidence?.find(a=>a.id===id);return a?`<a href="${esc(a.article_url||'#')}" target="_blank" rel="noopener noreferrer">DOI ${esc(a.doi||id)}</a>`:''}).join(' · ');
function render(){
 const y=window.scrollY,focus=document.activeElement?.id,selection=document.activeElement?.selectionStart;
 document.title=`${names[S.page]||'FanScope'} · FanScope`;
 document.getElementById('app').innerHTML=`<div class="layout">${nav()}<main class="main">${hdr()}${mobileHeader(names[S.page]||'FanScope',{home:S.page==='home',page:S.page})}<div class="content" id="page-content">${S.loading?'<div class="loading-note" role="status">正在更新…</div>':''}${section()}<footer class="footer"><span>FanScope · Inspired by Yang Fan · Research Intelligence</span><span>公开元数据仅用于学术检索研究 · 期刊分区待年度核验 · 不展示伪造统计</span></footer></div></main>${mobileTabs()}</div>`;
 document.querySelectorAll('.table-wrap table').forEach(table=>{const labels=[...table.querySelectorAll('th')].map(x=>x.textContent);table.querySelectorAll('tbody tr').forEach(row=>[...row.children].forEach((cell,i)=>cell.dataset.label=labels[i]||''));});
 if(focus&&document.getElementById(focus)){const el=document.getElementById(focus);el.focus({preventScroll:true});if(typeof selection==='number'&&el.type==='text')el.setSelectionRange(selection,selection);}
 window.scrollTo(0,y);drawCharts();
}
async function adminSourceAction(form,activate=false){
 if(S.busy)return;
 if(!form?.reportValidity())return;
 const id=form.dataset.sourceForm,issn=form.elements.issn.value.trim().toUpperCase();
 if(!/^[0-9]{4}-[0-9]{3}[0-9X]$/.test(issn)){alert('请先填写有效格式的 ISSN');return;}
 if(activate&&!confirm(t('确认已核对期刊标题、ISSN、来源与真实 DOI 样本？启用会进入自动扫描名单，但不代表已完成首次同步。')))return;
 const key=prompt(t('管理员密钥（仅用于本次请求，不保存）'));if(!key)return;
 S.busy=true;const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try{
  const res=await fetch(API+'/api/admin/journal-source/'+(activate?'activate':'test'),{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':key},body:JSON.stringify({id,issn,confirm:activate}),signal:AbortSignal.timeout(28000)});
  const data=await res.json();if(!res.ok)throw Error(data.error||`HTTP ${res.status}`);
  S.sourceMessage=data.verified?`已核实来源身份：${id} / ${issn}。匹配 ${data.sample?.length||0} 个展示样本；${activate?'已启用，等待正式同步。':'尚未启用，管理员可以人工确认后启用。'}\n${(data.sample||[]).map(x=>x.doi+' · '+x.title).join('\n')}`:'未验证通过：期刊名称、ISSN 与 DOI 样本未能同时对应。请检查 ISSN 或更换来源。';
  S.sourceError=!data.verified;
  if(activate){S.data.journals=await get('/api/journals');S.data.sources=await get('/api/journal-source-status');}
 }catch(e){S.sourceMessage='操作未完成：'+e.message;S.sourceError=true;}
 finally{S.busy=false;render();}
}
// The administrator key is temporary, held only for this browser operation.
async function bulkActivateEnglishSources() {
 if (S.busy) return;
 const items=S.data.sources?.items||[];
 const pending=pendingEnglishSources(items);
 if (!pending.length) {
  S.sourceMessage='全部英文期刊已经启用。若仍显示「待首次监测」，请检查监测健康状态和历史回填。';
  S.sourceError=false;render();return;
 }
 if (!confirm('将对剩余 '+pending.length+' 本英文期刊逐本执行实时 Crossref 验证，通过的立即启用。不会调用 DeepSeek，可能需要几分钟。确认继续？'))return;
 let key=prompt(t('本次批量操作的管理员密钥（只输入一次，不保存）'));
 if (!key) return;
 S.busy=true;
 const state={running:true,processed:0,total:pending.length,activated:0,failed:0,skipped:0,failures:[],cancelRequested:false};
 S.sourceBatch=state;S.sourceMessage='';S.sourceError=false;render();
 try {
  const report=await activatePendingEnglishSources({
   items,isCancelled:()=>state.cancelRequested,
   onProgress:progress=>{Object.assign(state,progress);render();},
   submit:async ({id,issn})=>{
    const response=await fetch(API+'/api/admin/journal-source/activate',{
     method:'POST',
     headers:{'Content-Type':'application/json','X-Admin-Key':key},
     body:JSON.stringify({id,issn,confirm:true}),
     signal:AbortSignal.timeout(30000)
    });
    const data=await response.json();
    if (!response.ok) {
     const error=new Error(data.error||'HTTP '+response.status);
     error.status=response.status;
     throw error;
    }
    return data;
   }
  });
  S.sourceMessage=(report.unauthorized?'管理员认证失败，已停止后续请求':report.cancelled?'已停止后续请求':'批量处理结束')+'：成功启用 '+report.activated+' 本；失败 '+report.failed+' 本；缺少候选 ISSN '+report.skipped+' 本。';
  S.sourceError=report.unauthorized||report.failed>0||report.skipped>0;
 }catch(error) {
  S.sourceMessage='批量核验中断：'+String(error.message||error);
  S.sourceError=true;
 }finally{
  key=null;state.running=false;S.busy=false;
  try {
   S.data.sources=await get('/api/journal-source-status');
   S.data.journals=await get('/api/journals');
  }catch(error){S.sourceMessage+='（刷新列表失败，请手动刷新页面）';}
  render();
 }
}
async function adminRequest(path,payload,method='POST'){
 const key=prompt(t('输入管理员密钥（本次请求使用，不保存）'));
 if(!key)return null;
 const r=await fetch(API+path,{method,headers:{'X-Admin-Key':key,...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify(payload||{})}:{}),signal:AbortSignal.timeout(30000)});
 const data=await r.json();if(!r.ok)throw Error(data.error||`HTTP ${r.status}`);return data;
}
async function opsAction(path,payload,method='POST'){
 if(S.busy)return;
 S.busy=true;
 try{const r=await adminRequest(path,payload,method);if(!r)return;
  S.opsError=false;S.opsMessage=path.includes('/admin/import')?`导入结果：成功 ${Number(r.imported||0)} 篇，跳过 ${Number(r.skipped||0)} 篇（包含重复或无效来源）。`:'操作完成，最新任务状态已载入。';
  if(path.includes('analysis-batches')){
   if(Array.isArray(r.items))S.data.batches=r.items;
   else if(r.id)S.data.batches=[r,...(S.data.batches||[]).filter(x=>x.id!==r.id)];
  }
  if(path==='/api/admin/ai-auto')S.data.autoAI=r;
  S.data.backfills=await get('/api/journal-backfill-status').catch(()=>S.data.backfills);
  S.data.coverage=await get('/api/analysis-coverage').catch(()=>S.data.coverage);
 }catch(e){S.opsError=true;S.opsMessage=e.message;}
 finally{S.busy=false;render();}
}
document.addEventListener('click',async e=>{
 const cancel=e.target.closest('[data-cn-cancel]');if(cancel){await opsAction('/api/admin/chinese-jobs/'+cancel.dataset.cnCancel,{action:'cancel'});await refreshPage();return;}
 const step=e.target.closest('[data-cn-step]');if(step){await opsAction('/api/admin/chinese-jobs/'+step.dataset.cnStep,{});await refreshPage();return;}
 const cn=e.target.closest('[data-cn-job]');if(cn){const f=document.querySelector('[data-cn-source]');await opsAction('/api/admin/chinese-jobs',{journalId:f.elements.journalId.value,incremental:cn.dataset.cnJob==='incremental'});await refreshPage();return;}
 if(e.target.closest('[data-open-search]')){await navigate('feed');document.getElementById('q-search')?.focus();return;}
 if(e.target.closest('[data-open-literature-filters]')){const panel=document.querySelector('.discovery-filter-panel');if(panel){panel.open=!panel.open;S.filtersOpen=panel.open;}return;}
 if(e.target.closest('[data-open-trend-filters]')){const panel=document.querySelector('.trend-filter-panel');if(panel){panel.open=!panel.open;S.trendFiltersOpen=panel.open;panel.querySelector('select')?.focus();}return;}
 const trendTab=e.target.closest('[data-trend-tab]');if(trendTab){S.trendTab=trendTab.dataset.trendTab;syncUrl();render();return;}
 const topicChip=e.target.closest('[data-topic-chip]');if(topicChip){S.topic=S.topic===topicChip.dataset.topicChip?'':topicChip.dataset.topicChip;S.viewLimit=20;syncUrl();await refreshPage();return;}

 if(e.target.closest('[data-bulk-source-cancel]')){if(S.sourceBatch?.running){S.sourceBatch.cancelRequested=true;render();}return;}
 if(e.target.closest('[data-bulk-source-activate]')){await bulkActivateEnglishSources();return;}
 if(e.target.closest('[data-enrich-metadata]')){await opsAction('/api/admin/enrich-metadata',{limit:20});return;}
 if(e.target.closest('[data-compare-baseline]')){S.comparison=await get('/api/research-comparison?'+new URLSearchParams({article_type:S.articleType==='all'?'original_research':S.articleType,market:S.market,journal:S.journal,topic:S.topic})).catch(error=>({error:error.message}));if(S.comparison.error){alert(S.comparison.error);S.comparison=null;}render();return;}

 const rss=e.target.closest('[data-rss-action]');if(rss){const form=rss.closest('[data-rss-form]'),action=rss.dataset.rssAction;if(action==='enable'&&!confirm(t('确认验证该官方 RSS 并启用监测？')))return;try{const r=await adminRequest('/api/admin/journal-source/rss',{id:form.dataset.rssForm,rss_url:form.elements.rss_url.value,action,confirm:action==='enable'});if(!r)return;S.sourceError=false;S.sourceMessage=action==='pause'?'监测已暂停':`RSS 操作成功：${r.count} 篇有效文章。`+(r.sample||[]).map(a=>a.title+' · '+a.url+' · '+a.publication_date).join('\n');await load();}catch(error){S.sourceError=true;S.sourceMessage=error.message;render()}return;}

  const automatic=e.target.closest('[data-auto-ai]');if(automatic){await opsAction('/api/admin/ai-auto',{action:automatic.dataset.autoAi});return;}
  const aiAction=e.target.closest('[data-ai-action]');if(aiAction){const action=aiAction.dataset.aiAction;if(action==='retry'&&!confirm(t('失败请求可能已计费。请先核对供应商账单；确认将失败项重新排队？重新启动后可能再次收费。')))return;if(action==='start'&&!confirm(t('确认使用课题组的 DeepSeek API 余额启动该分析任务？每笔 API 调用可能产生费用。')))return;await opsAction('/api/admin/analysis-batches/'+encodeURIComponent(aiAction.dataset.aiId)+'/'+action,{});return;}
  const fillAction=e.target.closest('[data-backfill-action]');if(fillAction){await opsAction('/api/admin/journal-backfills/'+encodeURIComponent(fillAction.dataset.backfillId)+'/'+fillAction.dataset.backfillAction,{});return;}
  if(e.target.closest('[data-ops-load-batches]')){await opsAction('/api/admin/analysis-batches',null,'GET');return;}
  if(e.target.closest('[data-ops-refresh]')){await refreshPage();return;}
  const theme=e.target.closest('[data-theme-next]');if(theme){window.FanScopeTheme?.cycle();render();return;}
  if(e.target.closest('[data-discovery-refresh]')){await refreshPage();return;}
  const choice=e.target.closest('[data-use-discovery]');if(choice){
   const f=document.querySelector(`[data-source-form="${CSS.escape(choice.dataset.useDiscovery)}"]`);
   if(f){f.elements.issn.value=choice.dataset.issn;f.scrollIntoView({behavior:'smooth',block:'center'});S.sourceMessage='候选 ISSN 已填入表单；请点击检测来源，检查 DOI 证据后再决定是否启用。';S.sourceError=false;}
   return;
  }
  if(e.target.closest('[data-discovery-create]')||e.target.closest('[data-discovery-start-all]')){
   const start=!!e.target.closest('[data-discovery-start-all]');
   const key=prompt(t('管理员密钥（只用于本次请求，不保存）'));if(!key)return;
   try{const resp=await fetch(API+'/api/admin/journal-discoveries'+(start?'/start-all':''),{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':key},body:'{}',signal:AbortSignal.timeout(25000)});
    const j=await resp.json();if(!resp.ok)throw Error(j.error||`HTTP ${resp.status}`);
    S.sourceMessage=start?`成功将 ${j.started} 项来源调查加入队列；后台逐本处理，不调用 DeepSeek。`:`创建 ${j.created} 项调查任务，当前暂停；点击「启动待调查任务」后才会访问 Crossref。`;
    S.sourceError=false;await refreshPage();
   }catch(error){S.sourceMessage=error.message;S.sourceError=true;render();}return;
  }
  const discoveryRetry=e.target.closest('[data-discovery-retry]');if(discoveryRetry){
   const key=prompt(t('管理员密钥（只用于本次请求，不保存）'));if(!key)return;
   try{const r=await fetch(API+'/api/admin/journal-discoveries/'+encodeURIComponent(discoveryRetry.dataset.discoveryRetry)+'/retry',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':key},body:'{}'});
    const j=await r.json();if(!r.ok)throw Error(j.error||`HTTP ${r.status}`);await refreshPage();
   }catch(error){S.sourceMessage=error.message;S.sourceError=true;render();}return;
  }
  const sourceActivate=e.target.closest('[data-source-activate]');if(sourceActivate){await adminSourceAction(sourceActivate.closest('form'),true);return;}
  const brief=e.target.closest('[data-generate-brief]');if(brief){const key=prompt(t('管理员密钥（不保存）；每日最多3次，最多1200输出Token/次'));if(!key)return;const res=await fetch(API+'/api/admin/research-brief',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':key},body:JSON.stringify({market:S.market,topic:S.topic,journal:S.journal,period:S.period,article_type:S.articleType})});if(!res.ok)alert('生成失败，请检查 API 配置和预算');await refreshPage();return;}
 const copy=e.target.closest('[data-copy]');if(copy){await navigator.clipboard.writeText(copy.dataset.copy);copy.textContent='已复制';return;}
 const retry=e.target.closest('[data-retry-journal]');if(retry){const key=prompt(t('请输入管理员密钥（仅本次使用，不保存）'));if(!key)return;const res=await fetch(API+'/api/admin/scan',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':key},body:JSON.stringify({journalId:retry.dataset.retryJournal})});alert(res.ok?'已提交续跑，请稍后刷新状态':'提交失败，请检查权限');return;}
 const detail=e.target.closest('[data-paper]');if(detail){e.preventDefault();const a=articleCache.get(detail.dataset.paper);await navigate('article',{article:a});return;}
 const back=e.target.closest('[data-app-back]');if(back){appBack();return;}
 const zoom=e.target.closest('[data-expand-visual]');if(zoom){const el=document.getElementById(zoom.dataset.expandVisual);if(!el)return;const parent=el.parentNode,next=el.nextSibling;const dialog=openAppDialog(`<div class="bar"><h2>${esc(el.getAttribute('aria-label'))}</h2><button class="btn" data-close>关闭</button></div>`,{label:'展开图表',onClose:()=>{if(parent.isConnected){parent.insertBefore(el,next);echarts.getInstanceByDom(el)?.resize();}}});dialog.append(el);echarts.getInstanceByDom(el)?.resize();return;}
 const p=e.target.closest('[data-page]');if(p&&!p.disabled){await navigate(p.dataset.page);return;}
 const m=e.target.closest('[data-market]');if(m){S.market=m.dataset.market;S.journal='';S.topic='';S.sampleUnit='';S.viewLimit=20;syncUrl();await refreshPage();return;}
 if(e.target.closest('[data-reload]')){await load();return;}
 if(e.target.closest('#apply-search')||e.target.closest('[data-apply-filters]')){S.search=document.getElementById('q-search')?.value.trim()||'';S.period=document.getElementById('period-filter')?.value||S.period;S.view=document.getElementById('view-filter')?.value||S.view;S.year=document.getElementById('year-filter')?.value.trim()||S.year;S.link=document.getElementById('link-filter')?.value||S.link;S.viewLimit=20;syncUrl();await refreshPage();return;}
 if(e.target.closest('#more-articles')){S.viewLimit=Math.min(20000,S.viewLimit+20);syncUrl();await refreshPage({append:true});return;}
});
document.addEventListener('change',async e=>{
 if(e.target.id==='sample-unit-filter'){S.sampleUnit=e.target.value;syncUrl();render();return;}
 const draftFilters={'period-filter':'period','view-filter':'view','link-filter':'link'};
 if(draftFilters[e.target.id]){S[draftFilters[e.target.id]]=e.target.value;S.viewLimit=20;syncUrl();}

 if(e.target.id==='trend-period-filter'){S.period=e.target.value;S.comparison=null;syncUrl();await refreshPage();return;}
 if(e.target.id==='article-type-filter'){S.articleType=e.target.value;S.comparison=null;syncUrl();await refreshPage();return;}
 if(e.target.id==='topic-filter'){S.topic=e.target.value;S.viewLimit=20;syncUrl();await refreshPage();}
 if(e.target.id==='journal-filter'){S.journal=e.target.value;S.viewLimit=20;syncUrl();}
});
document.addEventListener('keydown',async e=>{if(e.key==='Enter'&&e.target.id==='q-search'){e.preventDefault();S.search=e.target.value.trim();syncUrl();await refreshPage();}});
document.addEventListener('submit',async e=>{
 if(e.target.matches('[data-cn-source]')){e.preventDefault();const v=Object.fromEntries(new FormData(e.target));v.confirm=e.target.elements.confirm.checked;await opsAction('/api/admin/chinese-source',v);await refreshPage();return;}
 if(e.target.matches('[data-ai-batch-form]')){e.preventDefault();const f=new FormData(e.target);await opsAction('/api/admin/analysis-batches',Object.fromEntries([...f].map(([k,v])=>[k,v])));return;}
 if(e.target.matches('[data-backfill-form]')){e.preventDefault();const f=new FormData(e.target);await opsAction('/api/admin/journal-backfills',Object.fromEntries([...f].map(([k,v])=>[k,v])));return;}
 if(e.target.matches('[data-source-form]')){e.preventDefault();await adminSourceAction(e.target,false);return;}if(e.target.id!=='subscribe-form')return;e.preventDefault();
 const f=e.target,form=new FormData(f);const b={email:String(form.get('email')||''),topics:form.getAll('topic'),markets:form.getAll('market'),urgent:form.has('urgent'),daily:form.has('daily'),weekly:form.has('weekly')};
 const btn=f.querySelector('[type=submit]');btn.disabled=true;btn.textContent='发送请求中…';
 try{const response=await fetch(API+'/api/subscriptions/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b),signal:AbortSignal.timeout(25000)});const data=await response.json();if(!response.ok)throw Error(data.error||'请求失败');S.emailMessage=data.message||'已提交';S.emailError=false;}
 catch(err){S.emailMessage=err.message;S.emailError=true;}
 render();
});
const isMobile=()=>matchMedia(mobileQuery).matches;
const articleCache=new Map();let refreshVersion=0;
const routeFields={market:'market',topic:'topic',journal:'journal',search:'q',period:'period',view:'view',year:'year',link:'link',articleType:'article_type',viewLimit:'limit',trendTab:'trend_tab',sampleUnit:'sample_unit'};
function readRoute(){
 const q=new URLSearchParams(location.search),page=q.get('page')||'home';S.page=mobilePageAllowed(page)?page:'home';S.articleId=q.get('id')||'';S.articleTitle=q.get('title')||'';
 const defaults={market:'all',topic:'',journal:'',search:'',period:'90d',view:'publication',year:'',link:'',articleType:'all',viewLimit:20,trendTab:'topics',sampleUnit:''};
 for(const [key,param] of Object.entries(routeFields))S[key]=q.has(param)?q.get(param):defaults[key];
 S.viewLimit=Math.max(20,Math.min(20000,Number(S.viewLimit)||20));
 if(!['topics','methods','samples','sources'].includes(S.trendTab))S.trendTab='topics';
 if(!['all','chinese','international'].includes(S.market))S.market='all';
 if(S.page==='trends'&&S.market==='all')S.market='international';
 if(!['publication','discovered'].includes(S.view))S.view='publication';
 if(!['all','original_research','review','conference_abstract','editorial','book_review','unknown'].includes(S.articleType))S.articleType='all';
 if(!periodOptions().some(([v])=>v===S.period))S.period='90d';
}
function syncUrl(push=false){
 const url=new URL(location.href);url.searchParams.set('page',S.page);
 for(const [key,param] of Object.entries(routeFields))url.searchParams.set(param,String(S[key]));
 if(S.page==='article'){url.searchParams.set('id',S.articleId);url.searchParams.set('title',S.articleTitle)}else{url.searchParams.delete('id');url.searchParams.delete('title')}
 history[push?'pushState':'replaceState']({...history.state,scroll:push?0:scrollY,depth:push?(history.state?.depth||0)+1:(history.state?.depth||0),app:true},'',url.pathname+url.search);
}
async function navigate(page,{article,pop=false,replace=false}={}){
 if(!mobilePageAllowed(page))return;
 if(!pop)history.replaceState({...history.state,scroll:scrollY,app:true},'');
 S.page=page;S.loading=false;if(page==='trends'&&S.market==='all')S.market='international';
 if(article){S.articleId=article.id;S.articleTitle=article.title;articleCache.set(article.id,article);}
 if(!pop)syncUrl(!replace);
 const target=pop?history.state?.scroll||0:0;
 render();window.scrollTo(0,target);if(S.status==='ready')await refreshPage();
 window.scrollTo(0,target);if(!pop){const h=document.querySelector('.content h1');h?.setAttribute('tabindex','-1');h?.focus({preventScroll:true});}
}
function appBack(){if(history.state?.depth>0)history.back();else navigate(S.page==='article'?'feed':['feed','trends','me'].includes(S.page)?'home':'me',{replace:true});}
const analysisStatus=a=>({analyzed:'AI 已分析',pending:'AI 待分析',needs_retry:'AI 待重试',failed:'AI 分析失败',analyzing:'AI 分析中',insufficient_abstract:'摘要不足',disabled:'AI 未启用'})[a.analysis_status]||'AI 尚未分析';
const paperSourceLabel=a=>({crossref:'Crossref',rss:'RSS',manual:'人工导入',openalex:'OpenAlex',europe_pmc:'Europe PMC'})[a.source]||a.source||'来源未登记';
const sourceTags=a=>[tag(marketLabel(a.market),a.market==='chinese'?'source-chinese':'source-international'),...(a.topics||[]).map(t=>tag(topicLabel(t)))].join('');
const mobilePaper=a=>`<article class="paper-card"><a class="paper-title" data-paper="${esc(a.id)}" href="?page=article&id=${encodeURIComponent(a.id)}&title=${encodeURIComponent(a.title)}">${esc(a.title)}</a><span class="paper-chevron">${mobileIcon('chevron',19)}</span><div class="tags">${sourceTags(a)}${tag(analysisStatus(a),'analysis-state')}</div><div class="paper-foot"><p class="paper-journal">${esc((a.publication_date_partial||a.published_online_date||a.publication_date||'').slice(0,4)||'年份未知')} · ${esc(a.journal_title||'期刊待确认')}</p>${a.article_url?`<a class="linkbtn" href="${esc(a.article_url)}" target="_blank" rel="noopener noreferrer">原文 / DOI ↗</a>`:''}</div></article>`;
function mobileHome(){
 const latest=S.data.recentPublications?.items||[],r=S.data.research,journals=S.data.journals?.items||[];
 const content=`<div class="app-section-head"><h2>最近发现</h2><button data-page="feed">全部文献 ${mobileIcon('chevron',15)}</button></div><p class="meta">最近90天发表 · 按发表日期倒序</p><div class="app-activity">${latest.length?latest.slice(0,3).map(a=>`<button class="app-activity-row" data-paper="${esc(a.id)}"><span><strong>${esc(a.title)}</strong><small><span class="discovery-source">${esc(marketLabel(a.market))}</span> <span class="discovery-source">${esc(paperSourceLabel(a))}</span> · 发表 ${esc(a.publication_date_partial||a.published_online_date||a.publication_date)} · ${esc(a.journal_title)}</small></span>${mobileIcon('chevron',19)}</button>`).join(''):'<div class="empty">最近90天暂无发表日期明确的论文。<br>可在文献页切换观察期。</div>'}</div><div class="app-section-head"><h2>研究观察</h2><button data-page="trends">查看证据 →</button></div><section class="app-brief-preview"><strong>AI 学术简报</strong><p>${esc(r?.brief||'连接后查看当前研究观察')}</p><p class="meta">有证据 ${nt(r?.evidenced)} / 收录 ${nt(r?.n)} · 覆盖 ${((r?.coverage||0)*100).toFixed(1)}%。仅题名与摘要，样本不足不能推断趋势。</p><button class="btn" data-page="trends">查看趋势与覆盖说明</button></section><div class="app-section-head"><h2>期刊动态</h2><button data-page="journals">期刊画像 →</button></div><div class="app-activity">${journals.filter(j=>j.last_success).slice(0,2).map(j=>`<button class="app-activity-row" data-page="journals"><span><strong>${esc(j.title)}</strong><small>${esc(marketLabel(j.market))} · 最近同步 ${date(j.last_success)} · 新增 ${nt(j.last_count)}</small></span>${mobileIcon('chevron',17)}</button>`).join('')||'<div class="empty">暂无期刊同步记录，可在个人工作台查看来源状态。</div>'}</div>`;
 return launcherHtml(statusTag(),(S.status!=='ready'?warning():'')+content);
}
function myWorkspace(){
 const links=[['journals','journal','期刊画像'],['alerts','bell','论文通知'],['health','health','监测与覆盖状态'],['sources','shield','期刊来源管理'],['operations','ai','AI 解析与批次管理']];
 return `${title('YOUR WORKSPACE','我的工作台','文献发现与课题组协作，在这里连接。')}<div class="app-menu"><a href="/lab/?view=overview">${mobileIcon('user',22)}<span>进入成员工作台</span>${mobileIcon('chevron',18)}</a><a href="/lab/?view=projects">${mobileIcon('project',22)}<span>科研项目</span>${mobileIcon('chevron',18)}</a><a href="/lab/?view=manuscripts">${mobileIcon('manuscript',22)}<span>论文进度</span>${mobileIcon('chevron',18)}</a><a href="/lab/?view=documents">${mobileIcon('upload',22)}<span>组会文档与人工审核</span>${mobileIcon('chevron',18)}</a>${links.map(([page,icon,label])=>`<button data-page="${page}">${mobileIcon(icon,22)}<span>${label}</span>${mobileIcon('chevron',18)}</button>`).join('')}<button data-theme-next>${mobileIcon('health',22)}<span>显示主题 · ${esc(window.FanScopeTheme?.preference||'system')}</span>${mobileIcon('chevron',18)}</button></div><p class="meta">课题组资料需登录；管理操作仍需验证管理员权限。</p>`;
}
const feed=()=>isMobile()?mobileFeed():desktopFeed();
function mobileFeed(){
 const list=S.data.feed?.items||[];
 return `<section class="literature-discovery">${S.status!=='ready'?warning():''}<div class="discovery-search">${mobileIcon('search',20)}<input id="q-search" type="text" value="${esc(S.search)}" placeholder="搜索论文标题、摘要或关键词..." aria-label="搜索论文标题或摘要"><button type="button" id="apply-search" aria-label="执行搜索">${mobileIcon('chevron',20)}</button></div><div class="discovery-chips" role="group" aria-label="期刊体系与研究主题">${[['all','全部'],['chinese','中文 C 刊'],['international','英文期刊']].map(([v,n])=>`<button data-market="${v}" class="${S.market===v?'active':''}">${n}</button>`).join('')}${(S.data.topics?.items||[]).map(t=>`<button data-topic-chip="${esc(t.id)}" class="${S.topic===t.id?'active':''}">${esc(t.short)}</button>`).join('')}</div><div class="discovery-list-head"><span>${nt(S.data.feed?.total)} 篇论文</span><button type="button" data-open-literature-filters aria-label="文献筛选与排序">${S.view==='discovered'?'最近收录':'最新发表'} ${mobileIcon('filter',15)}</button></div><details class="app-filter discovery-filter-panel" ${S.filtersOpen?'open':''}><summary>${mobileIcon('filter',17)}更多筛选</summary><div class="field">${topicFilter()}</div><div class="field"><label for="journal-filter">指定期刊</label><select id="journal-filter"><option value="">所有期刊</option>${opts((S.data.journals?.items||[]).filter(j=>S.market==='all'||j.market===S.market).map(j=>[j.id,j.title]),S.journal)}</select></div>${periodFilter()}${typeFilter()}<button class="btn primary" data-apply-filters>应用筛选</button></details><div class="paper-list">${list.length?list.map(mobilePaper).join(''):'<div class="card empty">当前筛选下暂无论文。尝试更换观察期或清除关键词。</div>'}</div>${(S.data.feed?.total||0)>S.viewLimit&&S.viewLimit<20000?'<button class="btn" id="more-articles" style="width:100%;margin-top:16px">加载更多文献</button>':''}</section>`;
}
function articleDetail(){
 const a=articleCache.get(S.articleId);if(!a)return `${title('ARTICLE','论文详情','')}<div class="card panel">${S.loading?'正在查找论文…':'未找到该论文，请返回文献页重新打开。'}<button class="btn" data-page="feed">返回文献</button></div>`;
 const x=a.analysis_status==='analyzed'?(a.analysis||{}):{};
 return `<article class="article-detail">${title('ARTICLE / EVIDENCE',`<span data-i18n-skip>${esc(a.title)}</span>`,esc(a.journal_title||'')+' · '+esc(marketLabel(a.market)))}<div class="tags">${tag(analysisStatus(a))}${tag(typeLabel(a.article_type))}${tag((a.publication_date_partial||a.publication_date||'').slice(0,4)||'年份未知')}</div><section class="card panel detail-section"><h2>摘要</h2><p class="article-abstract">${esc(a.abstract||'尚未获得摘要，请查看原文。')}</p><p class="meta">${esc(a.authors||'作者未收录')}</p>${a.article_url?`<a class="btn primary" href="${esc(a.article_url)}" target="_blank" rel="noopener noreferrer">查看原文 ↗</a>`:''}</section><section class="card panel detail-section"><h2>研究问题</h2><p>${x.research_question?`<span data-i18n-skip>${esc(x.research_question)}</span>`:'尚无足够证据'}</p><h2>研究设计与数据</h2><div class="detail-facts"><div><small>研究设计</small>${esc(x.study_design&&x.study_design!=='unknown'?designLabel(x.study_design):'尚无足够证据')}</div><div><small>数据来源</small>${esc(x.data_source_type?sourceName(x.data_source_type):'尚无足够证据')}</div><div><small>统计方法</small>${esc((x.statistical_methods||[]).map(methodName).join('、')||'证据不足')}</div><div><small>样本</small>${x.sample_n?nt(x.sample_n)+' '+esc(unitName(x.sample_unit)):'证据不足'}</div></div><p class="meta">${x.summary_zh?`<span data-i18n-skip>${esc(x.summary_zh)}</span>`:'没有可核验的 AI 摘要。'}</p></section><section class="card panel detail-section"><h2>证据与限制</h2><p class="meta">仅依据可获取的题名 / 摘要，不代表阅读了全文。缺少证据时不推断研究设计、数据或样本。</p>${Object.entries(x.evidence||{}).map(([field,e])=>`<blockquote><small>${esc(evidenceField(field))} · 置信度 ${esc(e.confidence)}</small><br>${esc(e.quote)}</blockquote>`).join('')||'<p class="meta">暂无可展示的提取证据。</p>'}<p class="meta">${esc(x.provider||'')} ${esc(x.model||'')} · ${esc(x.extraction_scope||'abstract-only')} · DOI ${esc(a.doi||'未收录')}</p></section></article>`;
}
const trends=()=>`${marketSelect()}${S.market==='chinese'?chinesePanel():''}${isMobile()?mobileTrends():desktopTrends()}`;
const trendTabs=[['topics','主题'],['methods','研究方法'],['samples','样本特征'],['sources','数据来源']];
const chartScope=()=>{
 const scope=[`${S.data.research?.window?.start||'全部收录'} — ${S.data.research?.window?.end||'当前'}`,typeLabel(S.articleType),S.market==='all'?'全部期刊':marketLabel(S.market)];
 if(S.topic)scope.push('主题：'+topicLabel(S.topic));
 if(S.journal)scope.push('期刊：'+((S.data.journals?.items||[]).find(j=>j.id===S.journal)?.title||'未知期刊'));
 if(S.search)scope.push('关键词：'+S.search);
 return scope.join(' · ');
};
function trendCaption(kind,{temporal=false,validN,unitN}={}){const r=S.data.research||{};if(!r.n)return `<p class="trend-caption">${esc(chartScope())}<br>有效样本 n=0 / 0 · 暂无样本，覆盖率与缺失率不适用。</p>`;const n=validN??(temporal?r.dated?.[kind]??r.known?.[kind]:r.known?.[kind])??0;return `<p class="trend-caption">${esc(chartScope())}<br>${unitN!==undefined?`当前单位有效样本 n=${nt(unitN)}；全部单位样本信息：`:""}有效样本 n=${nt(n)} / ${nt(r.n)} · 本维度覆盖 ${r.n?(100*n/r.n).toFixed(1):'0.0'}% · 缺失 ${r.n?(100*(1-n/r.n)).toFixed(1):'100.0'}%${temporal?'（含日期不足）':''}<br>${kind==='topics'?'主题来自题名 / 摘要关键词初筛；':'仅计当前摘要中可核验的证据；'}AI 分析成功 ${nt(r.analyzed)} 篇 · 有效证据 ${nt(r.evidenced)} 篇 · 证据覆盖 ${((r.coverage||0)*100).toFixed(1)}%。收录覆盖尚未审计。</p>`;}

const trendChart=(id,label)=>`<div class="visual-chart" id="${id}" role="img" aria-label="${label}"></div>`;
function distributionLegend(rows,label){const total=rows.reduce((n,x)=>n+x.n,0);return `<div class="distribution-legend">${rows.map((x,i)=>`<div><i style="background:${chartColors[i%chartColors.length]}"></i><span>${esc(label(x.name))}</span><b>${nt(x.n)} <small>${total?'· '+(100*x.n/total).toFixed(1)+'%':''}</small></b></div>`).join('')}</div>`;}
const spark=values=>{const max=Math.max(1,...values),min=Math.min(0,...values);return `<svg class="sparkline" viewBox="0 0 72 26" aria-label="近12个完整月份记录数"><polyline fill="none" stroke="currentColor" stroke-width="1.8" points="${values.map((n,i)=>`${i*72/(values.length-1)},${23-(n-min)/(max-min)*20}`).join(' ')}"/></svg>`;};
function mobileTrends(){
 const r=S.data.research||{},topics=distributionRows(r.totals?.topics,r.topics),methods=distributionRows(r.totals?.methods,r.methods),sources=sourceDistribution(r),growth=topicGrowth(r),unit=S.sampleUnit&&r.samples?.[S.sampleUnit]?S.sampleUnit:Object.keys(r.samples||{})[0]||'',sample=sampleBins(r.samples,unit);
 const top=rows=>rows.slice(0,5).map((x,i)=>`<div class="trend-rank"><span class="rank-number">${i+1}</span><span>${esc(methodName(x.name))}</span><b>${nt(x.n)} 次</b></div>`).join('');
 let panels='';
 if(S.trendTab==='topics')panels=`<section class="trend-panel trend-line-panel"><div class="trend-panel-title"><h2><button class="visual-heading" data-expand-visual="visual-topic-line" aria-label="展开研究主题趋势图">研究主题趋势</button></h2><label>观察期<select id="trend-period-filter">${opts(periodOptions(),S.period)}</select></label></div><p class="visual-subtitle">各主题在收录样本中的逐月变化</p>${trendChart('visual-topic-line','研究主题逐月论文数量')}<div class="topic-chart-legend">${topics.map((t,i)=>`<button data-topic-chip="${esc(t.name)}"><i style="background:${chartColors[i%chartColors.length]}"></i>${esc(topicLabel(t.name))}</button>`).join('')}</div>${trendCaption('topics',{temporal:true})}</section><section class="trend-panel"><div class="trend-panel-title"><h2>研究主题分布</h2><span>按标签命中</span></div><div class="distribution-layout">${trendChart('visual-topic-donut','研究主题标签分布')}${distributionLegend(topics,topicLabel)}</div><p class="visual-note">一个论文可有多个主题；占比以主题标签命中次数为分母，不是互斥论文占比。</p>${trendCaption('topics')}</section><section class="trend-panel"><div class="trend-panel-title"><h2>收录增长较快的主题</h2><span>完整 6 个月对比</span></div>${growth.rows.filter(x=>x.change>0).slice(0,3).map((x,i)=>`<div class="trend-rank"><span class="rank-number">${i+1}</span><span>${esc(topicLabel(x.name))}<small>${nt(x.previous)} → ${nt(x.current)} 条</small></span><b>+${(x.change*100).toFixed(1)}%</b>${spark(x.values)}</div>`).join('')||`<div class="visual-empty">${esc(growth.reason||'当前没有满足门槛的正向变化主题。')}</div>`}<p class="visual-note">${growth.previous.join(' 至 ')} 与 ${growth.current.join(' 至 ')}；(后期−前期) / 前期，每期至少 5 条。仅描述收录变化，不代表领域实际增长。</p>${trendCaption('topics')}</section>`;
 if(S.trendTab==='methods')panels=`<section class="trend-panel"><div class="trend-panel-title"><h2>研究方法分布</h2><span>有摘要证据</span></div><div class="distribution-layout">${trendChart('visual-method-donut','研究方法分布')}${distributionLegend(methods,methodName)}</div><p class="visual-note">仅采用现有证据验证通过的方法；一篇可使用多种方法，占比按方法标签次数计算。访谈等方法无明确分类证据时不推断。</p>${trendCaption('methods')}</section><section class="trend-panel"><h2><button class="visual-heading" data-expand-visual="visual-method-line" aria-label="展开研究方法年度图">研究方法年度变化</button></h2>${trendChart('visual-method-line','研究方法年度变化')}${trendCaption('methods',{temporal:true})}</section><section class="trend-panel"><h2>常见方法排名</h2>${top(methods.map(x=>({...x,label:methodName(x.name)})))||'<div class="visual-empty">尚无可核验的方法记录。</div>'}${trendCaption('methods')}</section>`;
 if(S.trendTab==='samples')panels=`<section class="trend-panel"><div class="trend-panel-title"><h2>样本量分布</h2><select id="sample-unit-filter" aria-label="样本单位">${Object.keys(r.samples||{}).length?opts(Object.keys(r.samples).map(u=>[u,unitName(u)]),unit):'<option value="">暂无已知单位</option>'}</select></div><p class="visual-subtitle">${sample.n} 篇 · 单位 ${esc(unitName(unit)||'未知')} · 分单位统计，不混加人数与家庭数</p>${trendChart('visual-sample-bars','当前单位的样本量区间')}${trendCaption('sample',{unitN:sample.n})}</section><section class="trend-panel"><h2>样本信息覆盖</h2><div class="sample-coverage"><span><b>${nt(r.known?.sample)}</b>已知样本论文</span><span><b>${nt(Math.max(0,(r.n||0)-(r.known?.sample||0)))}</b>未知 / 证据不足</span></div><p class="visual-note">${Object.entries(r.samples||{}).map(([u,v])=>`${unitName(u)} ${v.length} 篇`).join(' · ')||'暂无样本单位证据'}</p>${trendCaption('sample')}</section><section class="trend-panel"><h2>样本规模年度变化</h2><div class="visual-empty">现有接口没有按年份关联的样本量记录，暂不能绘制年度变化。当前单位分布不用于推断年度趋势。</div>${trendCaption('sample')}</section>`;
 if(S.trendTab==='sources')panels=`<section class="trend-panel"><h2>数据来源分布</h2><div class="distribution-layout">${trendChart('visual-source-donut','数据来源分布')}${distributionLegend(sources.filter(s=>s.n),sourceName)}</div><p class="visual-note">保留未知来源。分布包含已知来源但日期不足的记录；时间图仅统计日期可用记录。</p>${trendCaption('data')}</section><section class="trend-panel"><h2>已知数据来源逐月变化</h2>${trendChart('visual-source-line','已知数据来源逐月变化')}${trendCaption('data',{temporal:true})}</section>`;
 return `<section class="research-trends"><div class="research-tabs" role="group" aria-label="趋势分类">${trendTabs.map(([id,label])=>`<button data-trend-tab="${id}" aria-pressed="${S.trendTab===id}">${label}</button>`).join('')}</div><details class="app-filter trend-filter-panel" ${S.trendFiltersOpen?'open':''}><summary>${mobileIcon('filter',17)}统计范围与筛选</summary>${S.page==='trends'?'':marketSelect()}${topicFilter()}${typeFilter()}${S.trendTab!=='topics'?`<label>观察期<select id="trend-period-filter">${opts(periodOptions(),S.period)}</select></label>`:''}</details>${S.status!=='ready'?warning():''}${panels}<details class="trend-evidence"><summary>证据链、覆盖率与研究限制</summary>${researchBrief()}<p class="visual-note">${esc(r.warning||'')} ${esc(r.brief||'')} 收录覆盖未经审计，不推断期刊全量发文或录用概率。</p></details></section>`;
}
function mountTrend(id,option,available=true){
 const el=document.getElementById(id);if(!el)return;el.innerHTML='';el.style.height='';el.closest('.distribution-layout')?.classList.remove('bar-distribution');
 if(!available){el.style.height='auto';el.innerHTML='<div class="visual-empty">暂无足够的可核验记录。</div>';return;}
 const dark=document.documentElement.dataset.theme==='dark',ink=dark?'#9CAABD':'#607681',lineColor=dark?'#283440':'#e2e9e7';
 const localize=value=>typeof value==='string'?t(value):Array.isArray(value)?value.map(localize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,localize(v)])):value;option=localize(option);
 const mode=option.displayMode;delete option.displayMode;el.dataset.chartMode=mode||'bar';
 if(mode==='bar'){el.style.height=Math.max(130,(option.yAxis?.data?.length||1)*48+42)+'px';const note=document.createElement('p');note.className='visual-mode visual-note';note.textContent='条形图 · 观察期合计，仅描述当前样本。';el.before(note);el.closest('.distribution-layout')?.classList.add('bar-distribution');}
 option.backgroundColor='transparent';option.textStyle={color:ink,fontFamily:'system-ui',fontSize:isMobile()?10:12};option.animation=!matchMedia('(prefers-reduced-motion:reduce)').matches;
 option.tooltip={...option.tooltip,confine:true,renderMode:'richText',backgroundColor:dark?'#151C25':'#fff',borderColor:lineColor,textStyle:{color:dark?'#F2F5F8':'#192e39'}};
 for(const axis of [option.xAxis,option.yAxis])if(axis){axis.axisLabel={...axis.axisLabel,color:ink};axis.axisLine={lineStyle:{color:lineColor}};axis.splitLine={lineStyle:{color:lineColor,type:'dashed'}};}
 if(id.startsWith('chart-')&&option.series.length>1){const legend=document.createElement('div');legend.className='chart-legend visual-mode';for(const row of option.series){const item=document.createElement('span'),swatch=document.createElement('i');swatch.style.background=row.itemStyle?.color||chartColors[0];item.append(swatch,document.createTextNode(row.name));legend.append(item);}el.after(legend);}
 for(const series of option.series||[])if(series.label)series.label={...series.label,color:ink,textBorderWidth:0};
 const chart=echarts.init(el,null,{renderer:'canvas'});chart.setOption(option);charts.push(chart);return chart;
}
function drawMobileTrends(){
 const r=S.data.research;if(!r)return;
 const dist=(id,rows,label,n)=>mountTrend(id,distributionOption(rows,label,n),rows.some(x=>x.n>0));
 if(S.trendTab==='topics'){
  const rows=distributionRows(r.totals?.topics,r.topics),dated=r.dated?.topics??r.known?.topics??0;
  const c=mountTrend('visual-topic-line',temporalOption(r.topics,r.monthly,topicLabel,dated),matrixDistribution(r.topics).length>0);
  c?.on('click',p=>{const row=matrixDistribution(r.topics).find(x=>t(topicLabel(x.name))===p.seriesName);if(row){S.topic=row.name;navigate('feed');}});
  dist('visual-topic-donut',rows,topicLabel,r.known?.topics||0);
 }
 if(S.trendTab==='methods'){const rows=distributionRows(r.totals?.methods,r.methods);dist('visual-method-donut',rows,methodName,r.known?.methods||0);mountTrend('visual-method-line',temporalOption(r.methods,r.monthly,methodName,r.dated?.methods??r.known?.methods??0,{annual:true}),matrixDistribution(r.methods).length>0);}
 if(S.trendTab==='sources'){dist('visual-source-donut',sourceDistribution(r),sourceName,r.known?.data||0);mountTrend('visual-source-line',temporalOption(r.sources,r.monthly,sourceName,r.dated?.data??r.known?.data??0),matrixDistribution(r.sources).length>0);}
 if(S.trendTab==='samples'){const unit=r.samples?.[S.sampleUnit]?S.sampleUnit:Object.keys(r.samples||{})[0],sample=sampleBins(r.samples,unit);mountTrend('visual-sample-bars',barOption(sample.bins,x=>x),sample.n>0);}
}

installMobileEnvironment();readRoute();syncUrl();
window.addEventListener('popstate',()=>{readRoute();navigate(S.page,{pop:true});});
window.addEventListener('resize',(()=>{let mobile=isMobile();return ()=>{if(mobile!==isMobile()){mobile=isMobile();render();}}})());
document.addEventListener('toggle',e=>{if(e.target.matches?.('.discovery-filter-panel'))S.filtersOpen=e.target.open;if(e.target.matches?.('.trend-filter-panel'))S.trendFiltersOpen=e.target.open;},true);
document.addEventListener('input',e=>{const mapping={'q-search':'search','year-filter':'year'};if(mapping[e.target.id])S[mapping[e.target.id]]=e.target.value;});
load();

window.addEventListener('fanscope-theme-change',()=>{if(window.FanScopeTheme?.preference==='system'&&S.page==='trends')drawCharts();});
setInterval(async()=>{if(S.page!=='operations'||S.busy||document.hidden)return;try{S.data.autoAI=await get('/api/ai-auto-status');const panel=document.getElementById('automatic-ai-panel');if(panel)panel.outerHTML=automaticPanel();}catch{}},15000);
