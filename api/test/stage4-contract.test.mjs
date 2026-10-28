import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
test('Stage 4 exposes explicit operator actions, research UI and safe pending state',()=>{
 const api=src('../src/server.mjs'),app=src('../../web/app.js'),queue=src('../src/journal-discovery.mjs');
 assert.match(api,/\/api\/admin\/journal-discoveries/);
 assert.match(api,/\/api\/journal-discoveries/);
 assert.match(app,/data-discovery-create/);
 assert.match(app,/data-discovery-start-all/);
 assert.match(app,/data-use-discovery/);
 assert.match(queue,/status='paused'/);
 assert.doesNotMatch(queue,/DEEPSEEK|analyzePending|UPDATE journals SET enabled/);
});
