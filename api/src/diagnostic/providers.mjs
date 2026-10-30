// Diagnostic engines. Both return raw {structure} / {diagnosis} objects that
// report.mjs validates against the manuscript text.
//  - deepseek: the real engine. Only used when explicitly configured; sending an
//    unpublished manuscript additionally requires the owner's recorded consent.
//  - rules: deterministic keyword rules for flow testing and demos. Its output
//    is labelled in the report as rule-generated, never as AI judgment.
import {config} from '../config.mjs';
import {DIMENSIONS,FACT_FIELDS,PAPER_TYPES,SEVERITIES,CHECK_STATUSES,dimensionsFor} from './report.mjs';
import {chat,LlmError} from '../platform/llm.mjs';

export const PROMPT_VERSION='dx-prompt-v1';
export const MAX_INPUT_CHARS=60000;

// Identical system prompt + manuscript-first user message keep a stable prefix
// across both steps, which DeepSeek's automatic context cache can reuse.
const SYSTEM=`You are a rigorous peer reviewer for social science manuscripts (sociology, social policy, public health, gerontology, demography, economics-adjacent fields). You help authors improve an unpublished draft before submission.
Hard rules:
- Use ONLY the manuscript supplied by the user. Never invent citations, literature, data, numbers, results or author intentions.
- Every "quote" must be an exact, contiguous excerpt copied from the manuscript (8-300 characters), in its original language. If you cannot quote, leave the item out.
- Clearly separate what the manuscript states (facts with quotes) from your own assessment (judgments).
- If the manuscript lacks information needed for a judgment, say so ("missing") instead of guessing.
- Write all explanations, judgments and suggestions in Simplified Chinese. Return a single JSON object only.`;

const manuscriptBlock=text=>`<manuscript>\n${text}\n</manuscript>`;

const STRUCTURE_TASK=`Task 1 — identify the manuscript structure.
Return JSON: {"paper_type": one of ${JSON.stringify(PAPER_TYPES)}, "language":"zh|en|other", "title":"", "summary":"3-5 sentence neutral summary in Chinese",
"facts": {${FACT_FIELDS.map(f=>`"${f}":[{"text":"concise Chinese paraphrase","quote":"exact excerpt"}]`).join(',')}}}
Include at most 6 items per field. Use an empty list when the manuscript has none (e.g. no explicit hypotheses).`;

function diagnosisTask(structure){
 const type=PAPER_TYPES.includes(structure?.paper_type)?structure.paper_type:'unknown';
 return `Task 2 — diagnose the manuscript as a demanding but constructive reviewer.
Identified structure (from Task 1, may be incomplete): ${JSON.stringify({paper_type:type,facts:structure?.facts||{}}).slice(0,12000)}
Assess these dimensions: ${JSON.stringify(dimensionsFor(type))}.
Quantitative papers: check variable definition/measurement, sample and data source, model specification, statistical inference (uncertainty, multiple testing, effect sizes) and whether causal wording exceeds the identification strategy.
Qualitative papers: check participants and sampling logic, data collection, analysis procedure (coding, saturation, rigor), reflexivity/ethics, and whether interpretations are grounded in the data.
All papers: theory–design fit, argument gaps, unsupported claims, contribution, structure.
Return JSON: {"checks":[{"dimension":one of ${JSON.stringify(DIMENSIONS)},"status":one of ${JSON.stringify(CHECK_STATUSES)},"judgment":"","evidence":[{"quote":""}]}],
"issues":[{"severity":one of ${JSON.stringify(SEVERITIES)},"dimension":"","title":"","problem":"what is wrong and why it matters","evidence":[{"quote":""}],"reviewer_question":"how a journal reviewer would phrase the objection","suggestion":"specific, actionable revision"}],
"strengths":[{"text":"","evidence":[{"quote":""}]}]}
critical = threatens the main conclusion; major = reviewers will likely require revision; minor = clarity/presentation. At most 15 issues, most important first.`;
}

class ProviderError extends Error{constructor(code,message,extra={}){super(message);this.name='ProviderError';this.code=code;Object.assign(this,extra)}}

// All model traffic goes through platform/llm.mjs (ledger, idempotency,
// bounded attempts, concurrency cap, circuit breaker). Error codes are mapped
// from llm_* to dx_provider_* for the diagnostic run record.
export function deepseekProvider({apiKey=config.dxKey,model=config.dsModel,fetchImpl,timeoutMs=180000,ledger,refId,maxAttempts=2}={}){
 if(!apiKey)throw new ProviderError('dx_provider_unconfigured','DeepSeek is not configured');
 if(!ledger||!refId)throw new ProviderError('dx_provider_unconfigured','Model calls require a ledger and a run id');
 const usage={input_tokens:0,output_tokens:0,cache_hit_tokens:0};
 async function call(step,text,task,maxTokens){
  try{
   const r=await chat({purpose:`diagnostic.${step}`,idempotencyKey:`dx:${refId}:${step}`,refId,model,maxTokens,temperature:0.2,apiKey,ledger,maxAttempts,timeoutMs,fetchImpl,
    messages:[{role:'system',content:SYSTEM},{role:'user',content:`${manuscriptBlock(text)}

${task}`}]});
   for(const k of Object.keys(usage))usage[k]+=r.usage[k]||0;
   return r.value;
  }catch(e){
   if(e instanceof LlmError){for(const k of Object.keys(usage))usage[k]+=e.usage?.[k]||0;throw new ProviderError(e.code.replace(/^llm_/,'dx_provider_'),e.message,{upstream:e.upstream})}
   throw e;
  }
 }
 return {name:'deepseek',model,usage,
  structure:text=>call('structure',text,STRUCTURE_TASK,4000),
  diagnose:(text,structure)=>call('diagnose',text,diagnosisTask(structure),7000)};
}

// --- Rule engine --------------------------------------------------------------
const sentences=text=>String(text).split(/(?<=[。！？!?；;])|\n+|(?<=\.)\s+(?=[A-Z])/).map(s=>s.trim()).filter(s=>s.replace(/\s/g,'').length>=12&&s.length<=400);
const RULES={
 research_questions:/研究问题|本文(旨在|探讨|考察|研究|分析)|本研究(旨在|探讨|考察)|research question|we (examine|investigate|ask)|this (study|paper|article) (examines|investigates|asks)/i,
 theory:/理论|框架|视角|theory|theoretical|framework|perspective/i,
 hypotheses:/假设|假说|hypothes[ie]s|\bH\d\b|we expect|we hypothesi[sz]e/i,
 data:/数据(来源|来自|库)|调查数据|样本|问卷|访谈|CHARLS|CFPS|CGSS|CLHLS|data (from|source)|survey|sample of|respondents|interview/i,
 methods:/回归|模型|双重差分|倾向得分|工具变量|固定效应|编码|扎根理论|主题分析|regression|model|difference-in-differences|propensity|instrumental|fixed effects|coding|thematic analysis|grounded theory/i,
 results:/结果(显示|表明)|发现|显著|results? (show|indicate|suggest)|we find|significant/i,
 conclusions:/结论|综上|本文认为|政策(启示|建议)|in conclusion|we conclude|implications/i,
};
export function rulesProvider(){
 return {name:'rules',model:'keyword-rules-v1',usage:{input_tokens:0,output_tokens:0},
  async structure(text){
   const all=sentences(text),facts={};
   for(const field of FACT_FIELDS)facts[field]=all.filter(s=>RULES[field].test(s)).slice(0,3).map(s=>({text:`原文相关表述（规则匹配，未经 AI 理解）`,quote:s.slice(0,280)}));
   const quant=/回归|显著|系数|标准误|样本量|regression|coefficient|p\s*[<=]|odds ratio|N\s*=/i.test(text),qual=/访谈|受访者|编码|田野|扎根|interview|participants|coding|ethnograph/i.test(text);
   return {paper_type:quant&&qual?'mixed':quant?'quantitative':qual?'qualitative':'unknown',language:/[一-鿿]/.test(text)?'zh':'en',title:'',
    summary:'演示模式：规则引擎只按关键词定位原文，不理解论证内容，不能替代 AI 或人工审读。',facts};
  },
  async diagnose(text,structure){
   const f=structure.facts,type=structure.paper_type,checks=[],issues=[];
   const quote=field=>f[field]?.[0]?[{quote:f[field][0].quote}]:[];
   for(const [dimension,field] of [['research_question','research_questions'],['theory_design_fit','theory'],['evidence_support','results']])
    checks.push({dimension,status:f[field]?.length?'adequate':'missing',judgment:f[field]?.length?'规则检查：找到相关表述，内容是否充分需人工或 AI 判断。':'规则检查：未找到明确表述。',evidence:quote(field)});
   if(!f.research_questions.length)issues.push({severity:'major',dimension:'research_question',title:'未定位到明确的研究问题',problem:'规则检查未在文中找到“本文旨在/研究问题”等明确表述，审稿人可能难以判断论文要回答什么问题。',evidence:[],reviewer_question:'本文的核心研究问题是什么？',suggestion:'在引言末段用一两句话明确提出研究问题及其边界。'});
   if(type==='quantitative'&&!f.hypotheses.length)issues.push({severity:'minor',dimension:'theory_design_fit',title:'定量研究未见明确假设',problem:'未找到“假设/H1”等表述，理论与实证检验之间的连接可能不够清楚。',evidence:quote('theory'),reviewer_question:'理论推导出哪些可检验的预期？',suggestion:'从理论框架推导出编号假设，并在结果部分逐一回应。'});
   if((type==='quantitative'||type==='mixed')&&!f.data.length)issues.push({severity:'major',dimension:'sample_data',title:'数据来源与样本说明不足',problem:'未找到数据来源、样本量或抽样方式的明确描述。',evidence:[],reviewer_question:'数据从何而来，样本如何构成？',suggestion:'补充数据来源、调查年份、抽样方法、样本量及缺失处理。'});
   const causal=sentences(text).find(s=>/导致|造成|促进了|因果|causes?|caused|leads? to|effect of/i.test(s));
   if(type!=='qualitative'&&causal&&!/工具变量|双重差分|断点|随机|实验|instrument|difference-in-differences|regression discontinuity|randomi[sz]ed|experiment/i.test(text))
    issues.push({severity:'major',dimension:'causal_claims',title:'因果表述可能超出识别策略',problem:'文中使用了因果性措辞，但未找到工具变量、双重差分、断点或实验等识别策略的表述。',evidence:[{quote:causal.slice(0,280)}],reviewer_question:'作者如何排除遗漏变量和反向因果？',suggestion:'改用相关性措辞，或补充识别策略与稳健性检验。'});
   if(type==='qualitative'&&!/抽样|招募|饱和|sampling|recruit|saturation/i.test(text))issues.push({severity:'major',dimension:'participants_sampling',title:'受访者选择逻辑不清',problem:'未找到抽样、招募或饱和的说明。',evidence:quote('data'),reviewer_question:'为什么选择这些受访者，样本是否足以支撑结论？',suggestion:'说明抽样策略、招募过程、样本特征与饱和判断。'});
   return {checks,issues,strengths:[]};
  }};
}

export function providerFor(name,options){
 if(name==='deepseek')return deepseekProvider(options);
 if(name==='rules')return rulesProvider();
 throw new ProviderError('dx_provider_unconfigured','No diagnostic engine is configured');
}
