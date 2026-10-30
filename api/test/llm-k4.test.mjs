// K4 minimal LLM client: ledger, idempotency, bounded attempts, breaker,
// concurrency cap and log privacy. All HTTP is mocked; no real model call.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fanscope-llm-test-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_PATH:path.join(dir,'test.sqlite'),FANSCOPE_LOG_LEVEL:'info',FANSCOPE_LOG_DIR:path.join(dir,'logs'),SCAN_ON_START:'false',DEEPSEEK_API_KEY:''});
const logging=await import('../src/platform/log.mjs');
const {db}=await import('../src/db.mjs');
const {chat,memoryLedger,resetLlmState,LlmError}=await import('../src/platform/llm.mjs');
const {dbLedger}=await import('../src/platform/llm-ledger.mjs');
const lines=[];const restore=logging.setLogSink(l=>lines.push(l));
after(()=>{logging.setLogSink(restore);db.close();fs.rmSync(dir,{recursive:true,force:true})});

const SECRET='未发表稿件中的私密结论：农村养老金显著改善心理健康';
const ok=(content='{"a":1}',usage={prompt_tokens:10,completion_tokens:5})=>async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}],usage}));
const base=over=>({purpose:'test.call',idempotencyKey:'k-'+Math.random().toString(36).slice(2),refId:'r1',model:'m',maxTokens:10,apiKey:'test-only',ledger:memoryLedger(),
 messages:[{role:'user',content:SECRET}],...over});

test('successful call is recorded with metadata only and returns parsed JSON',async()=>{
 resetLlmState();const ledger=dbLedger(),key='dx:run-1:structure';
 const r=await chat(base({ledger,idempotencyKey:key,fetchImpl:ok()}));
 assert.deepEqual(r.value,{a:1});assert.equal(r.usage.input_tokens,10);
 const row=db.prepare('SELECT * FROM llm_calls WHERE idempotency_key=?').get(key);
 assert.equal(row.status,'completed');assert.equal(row.attempts,1);assert.equal(row.input_tokens,10);assert.equal(row.output_tokens,5);assert.equal(row.request_chars,SECRET.length);
 assert.ok(!JSON.stringify(row).includes('私密'),'ledger stores no text');
});

test('the same idempotency key is never sent twice',async()=>{
 resetLlmState();const ledger=memoryLedger();let sent=0;const f=async()=>{sent++;return ok()()};
 await chat(base({ledger,idempotencyKey:'dup-key',fetchImpl:f}));
 await assert.rejects(chat(base({ledger,idempotencyKey:'dup-key',fetchImpl:f})),{code:'llm_duplicate'});
 assert.equal(sent,1);
});

test('attempts are bounded: retryable errors retry up to maxAttempts, client errors never retry',async()=>{
 resetLlmState();let n=0;const f503=async()=>{n++;return new Response('{}',{status:503,headers:{'retry-after':'0'}})};
 await assert.rejects(chat(base({fetchImpl:f503,maxAttempts:1})),{code:'llm_http_503'});assert.equal(n,1,'maxAttempts 1 = exactly one request');
 n=0;await assert.rejects(chat(base({fetchImpl:f503,maxAttempts:2})),{code:'llm_http_503'});assert.equal(n,2);
 n=0;const f400=async()=>{n++;return new Response('{}',{status:400})};
 await assert.rejects(chat(base({fetchImpl:f400,maxAttempts:3})),{code:'llm_http_400'});assert.equal(n,1);
 resetLlmState();n=0;let first=true;const flaky=async()=>{n++;if(first){first=false;return new Response('{}',{status:429,headers:{'retry-after':'0'}})}return ok()()};
 const ledger=memoryLedger(),key='retry-then-ok';
 assert.deepEqual((await chat(base({ledger,idempotencyKey:key,fetchImpl:flaky,maxAttempts:2}))).value,{a:1});
 assert.equal(n,2);assert.equal(ledger.rows.get(key).attempts,2);assert.equal(ledger.rows.get(key).status,'completed');
});

test('network failure after sending is recorded as uncertain; malformed or truncated output fails with safe codes',async()=>{
 resetLlmState();const ledger=memoryLedger();
 await assert.rejects(chat(base({ledger,idempotencyKey:'net',fetchImpl:async()=>{throw new TypeError('fetch failed')},maxAttempts:1})),{code:'llm_network'});
 assert.equal(ledger.rows.get('net').status,'uncertain');
 await assert.rejects(chat(base({fetchImpl:ok('not json')})),{code:'llm_invalid_json'});
 await assert.rejects(chat(base({fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]}))})),{code:'llm_truncated'});
 await assert.rejects(chat(base({apiKey:''})),{code:'llm_unconfigured'});
 await assert.rejects(chat(base({ledger:undefined})),{code:'llm_no_ledger'});
});

test('circuit breaker opens after repeated upstream failures and blocks further sends',async()=>{
 resetLlmState();process.env.FANSCOPE_LLM_BREAKER_FAILURES='3';let n=0;
 try{
  const f500=async()=>{n++;return new Response('{}',{status:500})};
  for(let i=0;i<3;i++)await assert.rejects(chat(base({fetchImpl:f500,maxAttempts:1})),{code:'llm_http_500'});
  await assert.rejects(chat(base({fetchImpl:f500,maxAttempts:1})),{code:'llm_circuit_open'});
  assert.equal(n,3,'no request sent while open');
 }finally{delete process.env.FANSCOPE_LLM_BREAKER_FAILURES;resetLlmState()}
});

test('concurrency cap limits simultaneous requests',async()=>{
 resetLlmState();process.env.FANSCOPE_LLM_CONCURRENCY='2';let active=0,peak=0;
 try{
  const slow=async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,30));active--;return ok()()};
  await Promise.all(Array.from({length:6},()=>chat(base({fetchImpl:slow}))));
  assert.equal(peak,2);
 }finally{delete process.env.FANSCOPE_LLM_CONCURRENCY}
});

test('logs carry codes and token counts, never prompt or output text',()=>{
 const text=lines.join('\n');
 assert.ok(text.includes('llm.call'));assert.ok(!text.includes('私密'));assert.ok(!text.includes('test-only'));
 assert.ok(new LlmError('llm_x','m') instanceof Error);
});
