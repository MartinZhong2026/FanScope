// Paper Diagnostic report schema (v1) and validation.
//
// Two kinds of content are kept strictly apart:
//  - facts: what the manuscript itself says. Each fact must carry a verbatim
//    quote that is found in the extracted text; unverifiable facts are dropped.
//  - judgments: checks, issues and suggestions. These are AI (or rule) opinions;
//    their evidence quotes are verified and unverifiable quotes are removed, so
//    an issue may remain with no manuscript evidence and is labelled as such.
export const REPORT_SCHEMA_VERSION=1;
export const PAPER_TYPES=['quantitative','qualitative','mixed','theoretical','review','unknown'];
export const FACT_FIELDS=['research_questions','theory','hypotheses','data','methods','results','conclusions'];
export const SEVERITIES=['critical','major','minor'];
export const CHECK_STATUSES=['adequate','concern','missing','not_applicable'];
const COMMON=['research_question','theory_design_fit','argument_logic','evidence_support','contribution','writing_structure'];
const QUANT=['variables_measurement','sample_data','model_specification','statistical_inference','causal_claims','robustness'];
const QUAL=['participants_sampling','data_collection','analysis_procedure','reflexivity_ethics','interpretation_claims'];
export const DIMENSIONS=[...COMMON,...QUANT,...QUAL,'mixed_integration'];
export function dimensionsFor(type){
 if(type==='quantitative')return [...COMMON,...QUANT];
 if(type==='qualitative')return [...COMMON,...QUAL];
 if(type==='mixed')return [...COMMON,...QUANT,...QUAL,'mixed_integration'];
 return COMMON;
}

// Whitespace-insensitive matching: PDF/DOCX extraction breaks lines and inserts
// spaces between CJK characters, so compare with all whitespace removed.
const squash=s=>String(s??'').replace(/\s+/g,'').toLowerCase();
export function makeQuoteChecker(text){
 const haystack=squash(text);
 return quote=>{const q=squash(quote);return q.length>=8&&q.length<=1200&&haystack.includes(q)};
}

const str=(v,max)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,max);
const list=v=>Array.isArray(v)?v:[];

function evidence(items,verify,stats){
 const out=[];
 for(const e of list(items).slice(0,4)){
  const quote=str(typeof e==='string'?e:e?.quote,600);
  if(!quote)continue;
  if(verify(quote))out.push({quote});else stats.quotes_rejected++;
 }
 return out;
}

// structure: {paper_type,language,title,summary,facts:{field:[{text,quote}]}}
// diagnosis: {checks:[{dimension,status,judgment,evidence}],issues:[...],strengths:[...]}
export function normalizeReport({structure,diagnosis,text,coverage,provenance}){
 const verify=makeQuoteChecker(text);
 const stats={facts_total:0,facts_verified:0,quotes_rejected:0,issues_dropped:0};
 const paper_type=PAPER_TYPES.includes(structure?.paper_type)?structure.paper_type:'unknown';
 const facts={};
 for(const field of FACT_FIELDS){
  facts[field]=[];
  for(const f of list(structure?.facts?.[field]).slice(0,8)){
   stats.facts_total++;
   const quote=str(f?.quote,600),textValue=str(f?.text,500);
   if(!textValue||!quote||!verify(quote)){stats.quotes_rejected+=quote?1:0;continue}
   facts[field].push({text:textValue,quote});stats.facts_verified++;
  }
 }
 const allowed=new Set(dimensionsFor(paper_type));
 const checks=[];
 for(const c of list(diagnosis?.checks)){
  if(!allowed.has(c?.dimension)||checks.some(x=>x.dimension===c.dimension))continue;
  checks.push({dimension:c.dimension,status:CHECK_STATUSES.includes(c.status)?c.status:'concern',judgment:str(c.judgment,800),evidence:evidence(c.evidence,verify,stats)});
 }
 const issues=[];
 for(const i of list(diagnosis?.issues).slice(0,30)){
  const title=str(i?.title,160),problem=str(i?.problem,1200),suggestion=str(i?.suggestion,1200);
  if(!SEVERITIES.includes(i?.severity)||!title||!problem||!suggestion){stats.issues_dropped++;continue}
  const ev=evidence(i.evidence,verify,stats);
  issues.push({severity:i.severity,dimension:DIMENSIONS.includes(i.dimension)?i.dimension:'argument_logic',title,problem,
   evidence:ev,evidence_status:ev.length?'quoted':'none',reviewer_question:str(i.reviewer_question,500),suggestion});
 }
 const order=Object.fromEntries(SEVERITIES.map((s,n)=>[s,n]));
 issues.sort((a,b)=>order[a.severity]-order[b.severity]||DIMENSIONS.indexOf(a.dimension)-DIMENSIONS.indexOf(b.dimension));
 issues.forEach((i,n)=>i.id=`I${n+1}`);
 const strengths=list(diagnosis?.strengths).slice(0,6).map(s=>({text:str(s?.text,500),evidence:evidence(s?.evidence,verify,stats)})).filter(s=>s.text);
 return {schema_version:REPORT_SCHEMA_VERSION,paper_type,language:str(structure?.language,20)||'unknown',title:str(structure?.title,300),
  summary:str(structure?.summary,1500),facts,checks,issues,strengths,coverage,provenance,validation:stats};
}
