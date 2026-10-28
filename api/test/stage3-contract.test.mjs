import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
const web=read('../../web/app.js'),server=read('../src/server.mjs'),model=read('../src/journal-backfill.mjs');

test('stage 3 exposes an administrator-gated operations center and mobile access',()=>{
 assert.match(web,/const opsPage=/);
 assert.match(web,/data-page="operations"/);
 assert.match(web,/data-ai-batch-form/);
 assert.match(web,/data-backfill-form/);
 assert.match(web,/data-ops-load-batches/);
 assert.match(web,/data-open-authorized-import/);
 assert.match(web,/href="chinese-import.html"/);
 assert.match(web,/本次请求使用，不保存/);
 assert.match(server,/\/api\/admin\/journal-backfills/);
 assert.match(server,/\/api\/journal-backfill-status/);
 assert.match(server,/workBackfillTick\(\)/);
 assert.match(read('../src/analysis-batches.mjs'),/action==='start'&&!config.dsKey/);
 assert.doesNotMatch(read('../src/analysis-batches.mjs'),/Configured budget guard reached|Pricing or budget missing after restart/);
});
test('historical backfill does not overwrite monitor checkpoints or invoke AI',()=>{
 assert.doesNotMatch(model,/INSERT INTO scan_windows|UPDATE scan_windows/);
 assert.doesNotMatch(model,/analyzePending|analyzeAbstract|DEEPSEEK_API_KEY/);
});
