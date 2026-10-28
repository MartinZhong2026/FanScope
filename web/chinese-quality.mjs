// Render the same runtime facts on desktop and mobile. No configured counts.
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rate=(n,d)=>d?`${(100*(n||0)/d).toFixed(1)}%`:'—';
export function chineseSourceStatus(j){
 const collected=Number(j.total)>0;
 const checked=Date.parse(j.connection?.checkedAt||'')||0,failed=Date.parse(j.lastError?.at||'')||0;
 const failedLatest=!!j.lastError&&(!j.connection?.verified||failed>=checked);
 const automaticVerified=j.connection?.verified===true&&!failedLatest;
 return {collected,automaticVerified,metadata:collected?'元数据已收录':'尚未收录元数据',automatic:failedLatest?'自动来源最近核验失败':automaticVerified?'自动来源已核验':'自动来源待核验',monitoring:j.enabled?'自动监测已启用':'自动监测未启用',error:failedLatest?String(j.lastError.error||'最近来源检查失败，请人工核对'):''};
}
export function chineseQualityPanel(d){
 if(!d)return '';
 if(d.available===false)return '<section class="card panel cn-quality" role="status"><h2>中文收录诊断暂不可用</h2><p>无法核对当前来源与覆盖率；请稍后重试。论文列表可继续使用，不将缺失诊断显示为零收录或已接入。</p></section>';
 const items=d.items||[],n=items.reduce((s,j)=>s+j.total,0),collected=items.filter(j=>chineseSourceStatus(j).collected).length,verified=items.filter(j=>chineseSourceStatus(j).automaticVerified).length;
 const sum=key=>items.reduce((s,j)=>s+(j.quality?.[key]||0),0);
 return `<section class="card panel cn-quality"><h2>中文论文收录与数据质量</h2><p>目标 ${items.length} 本 · 已收录元数据 ${collected} 本 · 自动来源已核验 ${verified} 本 · 累计 ${n} 篇。元数据收录、自动监测与CSSCI年度身份分别核验；收录不代表取得公开再分发许可。</p><div class="cn-quality-metrics">${[30,90,180].map(days=>`<div><strong>${items.reduce((s,j)=>s+(j.windows?.[days]||0),0)}</strong><span>最近${days}天精确日期论文</span></div>`).join('')}<div><strong>${rate(sum('doi'),n)}</strong><span>DOI覆盖率</span></div><div><strong>${rate(sum('abstracts'),n)}</strong><span>摘要覆盖率</span></div><div><strong>${rate(sum('authors'),n)}</strong><span>作者完整率</span></div></div><p class="meta">日期精确到天 ${rate(sum('exactDates'),n)} · 记录来源身份已核验 ${rate(sum('verified'),n)}。月份/年份精度记录不计入上面的精确日窗口；仅收录元数据不会产生AI分析结果。摘要可能因来源缺失或使用范围而未保留。</p><details class="cn-quality-details"><summary>逐刊收录与来源状态</summary><div class="table-wrap"><table><thead><tr><th>期刊</th><th>收录 / 180天</th><th>发表时间范围</th><th>最近获取</th><th>来源与限制</th></tr></thead><tbody>${items.map(j=>{const state=chineseSourceStatus(j);return `<tr><td>${escape(j.title)}</td><td>${j.total} / ${j.windows?.[180]||0}</td><td>${escape(j.quality?.earliest||'—')} → ${escape(j.quality?.latest||'—')}</td><td>${escape(j.quality?.fetchedAt?.slice(0,10)||'—')}</td><td>${escape(state.metadata)}<br>${escape(state.automatic)}${state.automaticVerified&&j.connection.provider?' · '+escape(j.connection.provider):''}<br>${escape(state.monitoring)}${state.error?'<br>'+escape(state.error):''}<br>${j.rank_verification_status==='verified'?'CSSCI年度身份已核验':'CSSCI年度身份待核验'}</td></tr>`;}).join('')}</tbody></table></div></details></section>`;
}
