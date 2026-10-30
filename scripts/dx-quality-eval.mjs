// Paper Diagnostic quality evaluation on SYNTHETIC manuscripts with planted flaws.
//
//   Free dry run (rule engine, no network):
//     node --experimental-sqlite scripts/dx-quality-eval.mjs --engine rules
//   Real DeepSeek run (paid; needs explicit approval and a key in the environment):
//     DEEPSEEK_API_KEY=... node --experimental-sqlite scripts/dx-quality-eval.mjs --engine deepseek --confirm-paid
//
// Uses the production prompt, provider and report validator. Writes a scorecard
// and the full reports to work/dx-eval/<timestamp>/ for human review. Only the
// synthetic fixtures in api/test/fixtures/dx-eval are ever sent.
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';

const {values}=parseArgs({options:{engine:{type:'string',default:'rules'},'confirm-paid':{type:'boolean',default:false},only:{type:'string'},model:{type:'string'}}});
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixtures=path.join(root,'api/test/fixtures/dx-eval');
if(values.engine==='deepseek'&&(!values['confirm-paid']||!process.env.DEEPSEEK_API_KEY)){
 console.error('Refusing: a DeepSeek run is a paid call. Pass --confirm-paid after approval and set DEEPSEEK_API_KEY.');process.exit(2);
}
const load=rel=>import(pathToFileURL(path.join(root,rel)).href);
const {providerFor,MAX_INPUT_CHARS,PROMPT_VERSION}=await load('api/src/diagnostic/providers.mjs');
const {memoryLedger}=await load('api/src/platform/llm.mjs');
const {normalizeReport}=await load('api/src/diagnostic/report.mjs');
// No database: calls are recorded in memory and counted in the scorecard.
const ledger=memoryLedger();
const expected=JSON.parse(fs.readFileSync(path.join(fixtures,'expected.json'),'utf8'));
const order={critical:0,major:1,minor:2};
const out=path.join(root,'work/dx-eval',new Date().toISOString().replace(/[:.]/g,'-')+'-'+values.engine);fs.mkdirSync(out,{recursive:true});

const rows=[];
for(const [file,spec] of Object.entries(expected)){
 if(file==='note'||(values.only&&!file.includes(values.only)))continue;
 const text=fs.readFileSync(path.join(fixtures,file),'utf8'),input=text.slice(0,MAX_INPUT_CHARS);
 // One attempt per step: the paid run is exactly 2 requests per manuscript.
 const provider=providerFor(values.engine,{ledger,refId:'eval-'+file.replace(/\W+/g,'-'),maxAttempts:1,...(values.model?{model:values.model}:{})});
 const started=Date.now();let report,error=null;
 try{
  const structure=await provider.structure(input);
  const diagnosis=await provider.diagnose(input,structure);
  report=normalizeReport({structure,diagnosis,text:input,coverage:{input_chars:text.length,analyzed_chars:input.length,truncated:false},provenance:{engine:provider.name,model:provider.model,prompt_version:PROMPT_VERSION,ai:provider.name!=='rules'}});
 }catch(e){error=e.code||e.name}
 const ms=Date.now()-started;
 if(!report){rows.push({file,error,ms});continue}
 const haystack=i=>`${i.title} ${i.problem} ${i.suggestion} ${i.reviewer_question}`;
 const flaws=spec.flaws.map(f=>{
  const hit=report.issues.find(i=>f.dimensions.includes(i.dimension)&&f.keywords.some(k=>haystack(i).toLowerCase().includes(k.toLowerCase())))
   ||report.issues.find(i=>f.keywords.filter(k=>haystack(i).toLowerCase().includes(k.toLowerCase())).length>=2);
  const severityOk=!f.severity_at_least||(hit&&order[hit.severity]<=order[f.severity_at_least]);
  return {id:f.id,found:!!hit,severity:hit?.severity||null,severityOk:!!hit&&severityOk,issue:hit?.title||null};
 });
 const factsTotal=report.validation.facts_total;
 rows.push({file,ms,paper_type:report.paper_type,paper_type_ok:report.paper_type===spec.paper_type,
  recall:flaws.filter(f=>f.found).length/flaws.length,severity_ok:flaws.filter(f=>f.severityOk).length/flaws.length,flaws,
  issues:report.issues.length,facts_verified:report.validation.facts_verified,facts_total:factsTotal,
  fact_verification_rate:factsTotal?report.validation.facts_verified/factsTotal:null,quotes_rejected:report.validation.quotes_rejected,
  issues_dropped:report.validation.issues_dropped,issues_without_evidence:report.issues.filter(i=>i.evidence_status==='none').length,usage:provider.usage,
  // Issues matching no planted flaw may be real extra findings or wrong criticism: a human decides.
  review:report.issues.map(i=>({severity:i.severity,dimension:i.dimension,title:i.title,problem:i.problem,suggestion:i.suggestion,evidence_status:i.evidence_status,quotes:(i.evidence||[]).map(e=>e.quote),planted:flaws.some(f=>f.issue===i.title)}))});
 fs.writeFileSync(path.join(out,file.replace(/\.md$/,'.report.json')),JSON.stringify(report,null,2));
}
const ok=rows.filter(r=>!r.error),mean=k=>ok.length?ok.reduce((s,r)=>s+(r[k]??0),0)/ok.length:0;
const summary={engine:values.engine,prompt_version:PROMPT_VERSION,manuscripts:rows.length,failed:rows.filter(r=>r.error).length,
 mean_recall:+mean('recall').toFixed(3),mean_severity_ok:+mean('severity_ok').toFixed(3),mean_fact_verification:+mean('fact_verification_rate').toFixed(3),
 paper_type_accuracy:ok.length?ok.filter(r=>r.paper_type_ok).length/ok.length:0,
 tokens:{input:ok.reduce((s,r)=>s+(r.usage?.input_tokens||0),0),output:ok.reduce((s,r)=>s+(r.usage?.output_tokens||0),0)},max_ms:Math.max(0,...rows.map(r=>r.ms))};
summary.requests=ledger.rows.size;
fs.writeFileSync(path.join(out,'scorecard.json'),JSON.stringify({summary,rows},null,2));
const md=[`# Paper Diagnostic 质量评测（${values.engine}，${PROMPT_VERSION}）`,'',`- 稿件 ${summary.manuscripts}，失败 ${summary.failed}`,`- 预埋缺陷召回率 ${summary.mean_recall}，严重度达标 ${summary.mean_severity_ok}`,`- 事实引文核对通过率 ${summary.mean_fact_verification}，论文类型准确率 ${summary.paper_type_accuracy}`,`- tokens 输入 ${summary.tokens.input} / 输出 ${summary.tokens.output}；最长耗时 ${summary.max_ms} ms`,'',
 ...rows.flatMap(r=>[`## ${r.file}`,r.error?`失败：${r.error}`:`类型 ${r.paper_type}（${r.paper_type_ok?'正确':'错误'}）· 问题 ${r.issues} · 剔除引文 ${r.quotes_rejected} · 无证据问题 ${r.issues_without_evidence}`,...(r.flaws||[]).map(f=>`- ${f.found?'✔':'✘'} ${f.id}${f.found?`（${f.severity}${f.severityOk?'':'，严重度偏低'}）：${f.issue}`:''}`),'',
  ...(r.review?.length?['### 全部问题（人工逐条判定：是否错误批评、严重度、引文、建议是否可执行）',...r.review.map(i=>`- [${i.severity}${i.planted?'·预埋':'·待判定'}] ${i.title}（${i.dimension}，证据 ${i.evidence_status}）\n  - 问题：${i.problem}\n  - 建议：${i.suggestion}${i.quotes.length?`\n  - 引文：${i.quotes.join(' / ')}`:''}`),'']:[])])].join('\n');
fs.writeFileSync(path.join(out,'scorecard.md'),md+'\n');
console.log(JSON.stringify({out,summary},null,2));
