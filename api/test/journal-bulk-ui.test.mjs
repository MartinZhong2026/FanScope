import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pendingEnglishSources, activatePendingEnglishSources} from '../../web/source-batch.mjs';

const sources=[
 {id:'a',title:'Already enabled',market:'international',enabled:1,issn:'1234-567X'},
 {id:'b',title:'New journal B',market:'international',enabled:0,candidate_issn:'1360-7863'},
 {id:'c',title:'New journal C',market:'international',enabled:0,candidate_issn:'1471-2318'},
 {id:'d',title:'Chinese source',market:'chinese',enabled:0,candidate_issn:'1360-7863'},
 {id:'e',title:'Missing ISSN',market:'international',enabled:0}
];

test('only unenabled English journals are offered; checked candidates retain ISSN',()=>{
 const result=pendingEnglishSources(sources);
 assert.deepEqual(result.map(x=>x.id),['b','c','e']);
 assert.equal(result[0].issn,'1360-7863');
 assert.deepEqual(pendingEnglishSources(null),[]);
});

test('sequential activation reports only verified successes, explicit failures and missing ISSNs',async()=>{
 const called=[],snapshots=[];
 const result=await activatePendingEnglishSources({
  items:sources,delayMs:0,
  submit:async x=>{called.push(x.id);return x.id==='b'?{verified:true,enabled:true}:{verified:false,enabled:false};},
  onProgress:s=>snapshots.push(s)
 });
 assert.deepEqual(called,['b','c']);
 assert.equal(result.total,3);assert.equal(result.processed,3);
 assert.equal(result.activated,1);assert.equal(result.failed,1);assert.equal(result.skipped,1);
 assert.equal(snapshots.at(-1).processed,3);
});

test('401 authentication failures stop the batch without changing later journals',async()=>{
 const called=[];
 const result=await activatePendingEnglishSources({items:sources,delayMs:0,submit:async x=>{
  called.push(x.id);throw Object.assign(new Error('Invalid admin credential'),{status:401});
 }});
 assert.deepEqual(called,['b']);assert.equal(result.unauthorized,true);
 assert.equal(result.processed,1);assert.equal(result.activated,0);
});

test('cancel stops requests after current verified journal',async()=>{
 const called=[];let cancel=false;
 const result=await activatePendingEnglishSources({items:sources,delayMs:0,
  submit:async x=>{called.push(x.id);cancel=true;return {verified:true,enabled:true};},
  isCancelled:()=>cancel
 });
 assert.deepEqual(called,['b']);assert.equal(result.cancelled,true);
 assert.equal(result.activated,1);
});

test('UI uses protected endpoint, asks for ephemeral key and provides accessible progress',()=>{
 const app=fs.readFileSync(new URL('../../web/app.js',import.meta.url),'utf8');
 assert.match(app,/data-bulk-source-activate/);
 assert.match(app,/data-bulk-source-cancel/);
 assert.match(app,/activatePendingEnglishSources/);
 assert.match(app,/journal-source\/activate/);
 assert.match(app,/X-Admin-Key/);
 assert.match(app,/aria-live="polite"/);
 assert.doesNotMatch(app,/localStorage\.setItem\([^)]*[Kk]ey/);
 assert.doesNotMatch(app,/sessionStorage\.setItem\([^)]*[Kk]ey/);
});
