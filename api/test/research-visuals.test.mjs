import test from 'node:test';import assert from 'node:assert/strict';
import {annualMatrixSeries,matrixSeries,matrixDistribution,topicGrowth,sampleBins,sourceDistribution} from '../../web/research-visuals.mjs';
test('theme and method matrices aggregate independently; overlapping labels are assignments, not unique papers',()=>{
 const months={'2025-01':2,'2025-02':1};
 assert.deepEqual(matrixSeries({'2025-01|care':2,'2025-01|ai':1,'2025-02|care':1},months),{months:['2025-01','2025-02'],series:[{name:'care',values:[2,1]},{name:'ai',values:[1,0]}]});
 assert.deepEqual(matrixDistribution({'2025-01|care':2,'2025-01|ai':1}),[{name:'care',n:2},{name:'ai',n:1}]);
 assert.deepEqual(matrixDistribution({'2025-01|DID':1}),[{name:'DID',n:1}]);
});
test('growth uses equal complete six-month windows, rejects missing windows and small/zero baselines',()=>{
 const monthly={},topics={};for(let m=1;m<=12;m++){const month='2025-'+String(m).padStart(2,'0');monthly[month]=m<=6?2:3;topics[month+'|care']=monthly[month];topics[month+'|rare']=m===12?1:0;}
 const g=topicGrowth({monthly,topics},new Date('2026-01-20'));assert.equal(g.rows[0].previous,12);assert.equal(g.rows[0].current,18);assert.equal(g.rows[0].change,.5);assert.equal(g.rows.length,1);assert.deepEqual(g.current,['2025-07','2025-12']);
 delete monthly['2025-04'];assert.equal(topicGrowth({monthly,topics},new Date('2026-01-20')).rows.length,0);
});
test('sample bins preserve units and reject missing or invalid sizes',()=>{
 const samples={person:[80,100,500,5000,null,-1],household:[20]};assert.equal(sampleBins(samples,'person').n,4);assert.deepEqual(sampleBins(samples,'person').bins.map(x=>x.n),[1,1,1,0,1]);assert.equal(sampleBins(samples,'household').n,1);assert.equal(sampleBins(samples,'institution').n,0);
});
test('source unknown and known-without-date remain distinct, preserving the denominator',()=>{
 const rows=sourceDistribution({n:10,known:{data:6},sources:{'2025-01|secondary_public':4}});assert.equal(rows.find(x=>x.name==='unknown').n,4);assert.equal(rows.find(x=>x.name==='undated_known').n,2);assert.equal(rows.reduce((n,x)=>n+x.n,0),10);
});

test('method annual series sum observed months without mixing topic data or filling unobserved years',()=>{
 assert.deepEqual(annualMatrixSeries({'2024-01|DID':2,'2024-09|DID':3,'2026-02|SEM':4}),{months:['2024','2026'],series:[{name:'DID',values:[5,0]},{name:'SEM',values:[0,4]}]});
});
