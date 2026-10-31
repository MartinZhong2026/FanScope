import {db} from './db.mjs';
import {analysisIsCurrent,validateResearch} from './ai.mjs';
import {articleLink} from './sources.mjs';
import {trendWindow,articleTypes,typeLabels,currentResearchYear,publicationToday} from './publication-policy.mjs';
export const publicationOrder="COALESCE(NULLIF(a.publication_date_partial,''),NULLIF(a.published_online_date,''),NULLIF(a.publication_date,''))";
export function researchWhere(q={}){
 const conditions=['a.demo=0',"a.market=(SELECT market FROM journals WHERE id=a.journal_id)"],params=[];
 if(q.market&&!['all','chinese','international'].includes(q.market))throw Object.assign(Error('Invalid market'),{status:400});
 for(const [key,col] of [['market','market'],['journal','journal_id']])if(q[key]&&q[key]!=='all'){conditions.push(`a.${col}=?`);params.push(q[key]);}
 if(q.topic){conditions.push('a.topics LIKE ?');params.push(`%"${String(q.topic).slice(0,30)}"%`);}
 if(q.q){conditions.push('(a.title LIKE ? OR a.abstract LIKE ?)');params.push(`%${String(q.q).slice(0,80)}%`,`%${String(q.q).slice(0,80)}%`);}
 if(q.year&&/^\d{4}$/.test(q.year)){conditions.push(`substr(${publicationOrder},1,4)=?`);params.push(q.year);}
 const type=q.article_type||'all';if(type!=='all'){
  if(!articleTypes.includes(type))throw Object.assign(Error('Invalid article type'),{status:400});
  conditions.push('a.article_type=?');params.push(type);
 }
 if(q.precise_date==='1')conditions.push(`a.date_precision='day' AND length(${publicationOrder})=10 AND date(${publicationOrder},'+0 days')=${publicationOrder}`);
 const window=trendWindow(q.period||'90d');
 if(window.start){conditions.push(`(${publicationOrder}>=? OR (length(${publicationOrder})<10 AND substr(?,1,length(${publicationOrder}))=${publicationOrder})) AND ${publicationOrder}<=?`);params.push(window.start,window.start,window.end);}
 if(q.link==='1')conditions.push("(a.doi LIKE '10.%/%' OR a.publisher_landing_url!='')");
 return {where:' WHERE '+conditions.join(' AND '),params,window};
}
const parse=(s,fallback)=>{try{return JSON.parse(s)||fallback}catch{return fallback}};
// Publisher abstracts of Chinese journals are copyrighted and their reuse is not confirmed.
// They are stored with their source, and shown only when the owner sets
// FANSCOPE_CN_ABSTRACTS_PUBLIC=true. Title, authors, date, citation and link stay public.
export const chineseAbstractsPublic=()=>process.env.FANSCOPE_CN_ABSTRACTS_PUBLIC==='true';
export function articleJSON(r){
 if(r.market==='chinese'&&!chineseAbstractsPublic()&&(r.abstract||'').trim()){
  // Only the publisher's text is withheld; structured fields derived from it (method, design, confidence) stay.
  const {abstract,ai_summary,...rest}=r;
  return {...articleJSON({...rest,abstract:'',ai_summary:null,abstract_status:'withheld'}),abstract_status:'withheld'};
 }
 return {...r,topics:parse(r.topics,[]),issns:parse(r.issns_json,[]),source_evidence:parse(r.source_evidence_json,null),article_type:r.article_type||'unknown',article_type_label:typeLabels[r.article_type||'unknown'],article_type_evidence:parse(r.article_type_evidence_json,{}),abstract_status:(r.abstract||'').trim().length>=55?'available':r.abstract_status||'missing',missing_fields:parse(r.missing_fields_json,{}),analysis:parse(r.analysis_json,null),...articleLink(r),matched:!!r.matched,demo:!!r.demo};
}
export function validatedAnalysis(a){
 if(!analysisIsCurrent(a))return null;
 const raw=parse(a.analysis_json,null),validated=validateResearch(raw,a.abstract||'');
 // Validation is a read-only view, not a new extraction. Preserve provenance.
 return {...raw,...validated,provider:raw?.provider??null,model:raw?.model??null,extracted_at:raw?.extracted_at??null};
}
export const hasAnalysisEvidence=x=>!!(x&&(x.study_design!=='unknown'||x.data_source_type!=='unknown'||x.statistical_methods.length||x.sample_n||x.research_question||x.summary_zh||x.topic_tags.length||x.wave_count||x.country||x.study_period));
export function researchReport(q={}){
 const {where,params,window}=researchWhere(q);
 const rows=db.prepare(`SELECT a.*,j.title AS journal_title FROM articles a JOIN journals j ON j.id=a.journal_id ${where}`).iterate(...params);
 const monthly={},topics={},designs={},methods={},sources={},matrix={},samples={},type_counts={};let analyzed=0,evidenced=0,n=0,missingAbstract=0;
 const known={date:0,topics:0,design:0,methods:0,data:0,sample:0,matrix:0},dated={topics:0,methods:0,data:0},totals={topics:{},methods:{},sources:{}},evidence=[];
 if(window.start){const c=new Date(window.start.slice(0,7)+'-01T00:00:00Z');while(c.toISOString().slice(0,10)<=window.end){monthly[c.toISOString().slice(0,7)]=0;c.setUTCMonth(c.getUTCMonth()+1);}}
 const bump=(obj,k)=>obj[k]=(obj[k]||0)+1;
 for(const a of rows){n++;bump(type_counts,a.article_type||'unknown');if((a.abstract||'').trim().length<55)missingAbstract++;
  const date=a.publication_date_partial||a.published_online_date||a.publication_date||'',month=/^\d{4}-(0[1-9]|1[0-2])(?:$|-)/.test(date)&&(date.length===7||(date.length===10&&!Number.isNaN(Date.parse(date))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date))?date.slice(0,7):'';
  if(month){known.date++;bump(monthly,month);}
  const rawTags=parse(a.topics,[]),tags=[...new Set(Array.isArray(rawTags)?rawTags.filter(t=>typeof t==='string'&&t.trim()):[])];if(tags.length){known.topics++;if(month)dated.topics++;}for(const t of tags){bump(totals.topics,t);if(month)bump(topics,`${month}|${t}`);}
  if(a.analysis_status==='analyzed')analyzed++;
  // Revalidate legacy records too: a successful JSON response is not evidence.
  const x=validatedAnalysis(a);
  const design=x?.study_design&&x.study_design!=='unknown';
  const data=x?.data_source_type&&x.data_source_type!=='unknown';
  const validMethods=[...new Set(x?.statistical_methods||[])];
  const sample=Number.isSafeInteger(x?.sample_n)&&x.sample_n>0&&x.sample_unit;
  if(design){known.design++;bump(designs,`${a.journal_title}|${x.study_design}`);}
  if(data){known.data++;bump(totals.sources,x.data_source_type);if(month){dated.data++;bump(sources,`${month}|${x.data_source_type}`);}}
  if(validMethods.length){known.methods++;if(month)dated.methods++;if(tags.length)known.matrix++;for(const m of validMethods){bump(totals.methods,m);if(month)bump(methods,`${month}|${m}`);for(const t of tags)bump(matrix,`${t}|${m}`);}}
  if(sample){known.sample++;(samples[x.sample_unit]??=[]).push(x.sample_n);}
  if(!hasAnalysisEvidence(x))continue;evidenced++;
  if(evidence.length<30)evidence.push({id:a.id,title:a.title,doi:a.doi,...articleLink(a),summary:x.summary_zh,analysis:x});
 }
 const coverage=n?evidenced/n:null,unknown_rates=Object.fromEntries(Object.entries(known).map(([k,v])=>[k,n?1-v/n:null]));
 const insufficient=evidenced<30||coverage<0.5;
 const chartCounts=[known.date,dated.topics,known.design,dated.methods,known.sample,dated.data,known.matrix];
 const chart_quality=chartCounts.map(valid_n=>({valid_n,missing_ratio:n?1-valid_n/n:null,selected_n:n,article_type:q.article_type||'all',article_type_label:typeLabels[q.article_type||'all']}));
 return {market:q.market||'all',n,analyzed,evidenced,coverage,window,article_type:q.article_type||'all',type_counts,missingAbstract,missingAbstractRatio:n?missingAbstract/n:null,unknown_rates,known,dated,totals,chart_quality,insufficient,brief:insufficient?'样本不足，暂不能推断趋势':'仅描述当前有证据的收录样本；候选研究机会仍需人工复核。',warning:'当前年度尚未结束；默认不与上一年全年作同比。日期精度、期刊覆盖和文章类型须一致；类型未确认不能算作原创研究。',monthly,topics,designs,methods,sources,matrix,samples,evidence};
}
export function comparableYearToDate(q={},at=new Date()){
 const type=q.article_type||'original_research';
 if(type==='unknown'||type==='all'||!articleTypes.includes(type))throw Object.assign(Error('同比需要明确且可比较的文章类型'),{status:400});
 const year=currentResearchYear(at),end=publicationToday(at),priorYear=year-1;
 const priorDay=new Date(Date.UTC(priorYear,Number(end.slice(5,7)),0)).getUTCDate();
 const priorEnd=`${priorYear}-${end.slice(5,7)}-${String(Math.min(Number(end.slice(8,10)),priorDay)).padStart(2,'0')}`;
 const where=researchWhere({...q,period:'all',year:'',article_type:type});
 const rows=db.prepare('SELECT a.journal_id,a.publication_date_partial,a.published_online_date,a.publication_date,a.date_precision FROM articles a'+where.where).all(...where.params);
 const groups=[[],[]];let excludedImprecise=0;
 for(const a of rows){const d=a.publication_date_partial||a.published_online_date||a.publication_date||'';if(d.slice(0,4)!==String(year)&&d.slice(0,4)!==String(priorYear))continue;
  if(d.length!==10||a.date_precision!=='day'){excludedImprecise++;continue;}
  const idx=d.slice(0,4)===String(year)?0:1;if(d<=(idx?priorEnd:end))groups[idx].push(a);
 }
 const sets=groups.map(rows=>new Set(rows.map(a=>a.journal_id))),journals=[...sets[0]].filter(id=>sets[1].has(id)).sort();
 const counts=groups.map(g=>g.filter(a=>journals.includes(a.journal_id)).length);
 return {status:journals.length?'descriptive_only':'insufficient',article_type:type,journals,current:{start:year+'-01-01',end,n:counts[0]},baseline:{start:priorYear+'-01-01',end:priorEnd,n:counts[1]},excludedImprecise,annualGrowth:null,warning:'仅对共同观察期刊、相同文章类型及相同月日区间描述样本；来源完整覆盖未经独立核验，不输出年度增长率。'};
}
