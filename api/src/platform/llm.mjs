// K4 (minimal): the one place new code calls a chat model.
//
// Guarantees for every call:
//  - recorded in a ledger before sending (reserved) and after (completed /
//    failed / uncertain) with tokens and duration — never prompt or output text;
//  - an idempotency key: the same key is never sent twice;
//  - bounded attempts (no unbounded retry loops); 429/5xx/network only;
//  - a process-wide concurrency cap and a circuit breaker after repeated
//    upstream failures;
//  - errors carry safe codes (llm_*), logs carry ids/codes/tokens only.
// The ledger is injected so the evaluation script can run without a database;
// application code uses dbLedger() from llm-ledger.mjs.
import crypto from 'node:crypto';
import {log} from './log.mjs';

const DEEPSEEK_URL='https://api.deepseek.com/chat/completions';
const RETRYABLE=new Set([408,409,425,429,500,502,503,504]);

export class LlmError extends Error{
 constructor(code,message,extra={}){super(message);this.name='LlmError';this.code=code;Object.assign(this,extra)}
}

// In-memory ledger for tests and the offline evaluation script.
export function memoryLedger(){
 const rows=new Map();
 return {rows,
  reserve(row){if(rows.has(row.idempotency_key))return false;rows.set(row.idempotency_key,{...row,status:'reserved'});return true},
  finish(key,fields){Object.assign(rows.get(key),fields)}};
}

const state={active:0,queue:[],failures:0,openUntil:0};
export function resetLlmState(){state.active=0;state.queue.length=0;state.failures=0;state.openUntil=0}
const limit=()=>Math.max(1,Number(process.env.FANSCOPE_LLM_CONCURRENCY||2));
async function slot(){if(state.active<limit()){state.active++;return}await new Promise(r=>state.queue.push(r));state.active++}
function release(){state.active--;state.queue.shift()?.()}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export async function chat({purpose,idempotencyKey,refId='',messages,model,maxTokens,temperature=0,json=true,
 apiKey,ledger,maxAttempts=2,timeoutMs=180000,fetchImpl=globalThis.fetch,now=()=>Date.now()}){
 if(!apiKey)throw new LlmError('llm_unconfigured','Model API key is not configured');
 if(!ledger)throw new LlmError('llm_no_ledger','A ledger is required for every model call');
 if(!/^[a-z0-9_.:-]{3,120}$/i.test(idempotencyKey||''))throw new LlmError('llm_bad_key','Idempotency key required');
 if(state.openUntil>now())throw new LlmError('llm_circuit_open','Model calls paused after repeated upstream failures');
 const requestChars=messages.reduce((n,m)=>n+String(m.content).length,0);
 const reserved=ledger.reserve({id:crypto.randomUUID(),idempotency_key:idempotencyKey,purpose,ref_id:refId,provider:'deepseek',model,request_chars:requestChars,created_at:new Date(now()).toISOString()});
 if(!reserved)throw new LlmError('llm_duplicate','This request was already sent; refusing to send it twice');
 const started=now();let attempts=0,lastStatus=null;
 const done=(fields)=>{ledger.finish(idempotencyKey,{attempts,http_status:lastStatus,duration_ms:now()-started,finished_at:new Date(now()).toISOString(),...fields})};
 await slot();
 try{
  for(;;){
   attempts++;
   let response;
   try{
    response=await fetchImpl(DEEPSEEK_URL,{method:'POST',signal:AbortSignal.timeout(timeoutMs),headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
     body:JSON.stringify({model,temperature,max_tokens:maxTokens,...(json?{response_format:{type:'json_object'}}:{}),messages})});
   }catch(e){
    // The request may have reached the provider: record as uncertain, never resend silently beyond maxAttempts.
    const code=e?.name==='TimeoutError'?'llm_timeout':'llm_network';
    if(attempts<maxAttempts){await sleep(1500*attempts);continue}
    trip();done({status:'uncertain',error_code:code});
    throw new LlmError(code,'Model request failed',{upstream:{provider:'deepseek',host:'api.deepseek.com'}});
   }
   lastStatus=response.status;
   if(!response.ok){
    if(RETRYABLE.has(response.status)&&attempts<maxAttempts){
     const retryAfter=Math.min(20,Number(response.headers?.get?.('retry-after'))||0);
     await sleep(retryAfter?retryAfter*1000:1500*attempts);continue;
    }
    if(response.status>=500||response.status===429)trip();
    done({status:'failed',error_code:`llm_http_${response.status}`});
    throw new LlmError(`llm_http_${response.status}`,'Model HTTP error',{upstream:{provider:'deepseek',host:'api.deepseek.com',status:response.status}});
   }
   let body;try{body=await response.json()}catch{done({status:'failed',error_code:'llm_bad_response'});throw new LlmError('llm_bad_response','Model response was not JSON')}
   state.failures=0;
   const usage={input_tokens:Number(body?.usage?.prompt_tokens||0),output_tokens:Number(body?.usage?.completion_tokens||0),cache_hit_tokens:Number(body?.usage?.prompt_cache_hit_tokens||0)};
   const choice=body?.choices?.[0],content=String(choice?.message?.content??'');
   done({status:'completed',...usage,response_chars:content.length,finish_reason:choice?.finish_reason||''});
   log('info','llm.call',{purpose,ref_id:refId,model,attempts,duration_ms:now()-started,...usage,finish_reason:choice?.finish_reason||''});
   if(choice?.finish_reason==='length')throw new LlmError('llm_truncated','Model output was truncated',{usage});
   if(!json)return {content,usage};
   try{const value=JSON.parse(content);if(!value||typeof value!=='object')throw 0;return {value,usage}}
   catch{throw new LlmError('llm_invalid_json','Model output was not a JSON object',{usage})}
  }
 }finally{release()}
}
function trip(){
 state.failures++;
 if(state.failures>=Number(process.env.FANSCOPE_LLM_BREAKER_FAILURES||4)){state.openUntil=Date.now()+5*60000;state.failures=0;log('warn','llm.circuit_open',{cooldown_ms:300000})}
}
