import test from 'node:test';import assert from 'node:assert/strict';
import {distributionOption,temporalOption,wrapLabel,methodName,designName,unitName} from '../../web/trend-charts.mjs';
test('small samples and sparse time points use bars without manufacturing observations',()=>{
 const matrix={'2026-01|survival':2,'2026-03|survival':1};
 const option=temporalOption(matrix,{'2026-01':2,'2026-02':0,'2026-03':1},methodName,3);
 assert.equal(option.displayMode,'bar');assert.equal(option.series[0].name,'生存分析');assert.deepEqual(option.series[0].data,[3]);
 const dist=distributionOption([{name:'survival',n:3}],methodName,3);assert.equal(dist.series[0].type,'bar');assert.equal(dist.series[0].data[0].value,3);
 assert.equal(distributionOption([{name:'a',n:10},{name:'b',n:12},{name:'c',n:13}],x=>x,35).displayMode,'donut');
});
test('dense time series keep observed zeros, full labels and translated schema categories',()=>{
 const matrix={'2026-01|survival':10,'2026-02|survival':20,'2026-03|survival':12};
 assert.equal(temporalOption(matrix,{'2026-01':10,'2026-02':20,'2026-03':12},methodName,42).displayMode,'line');
 const journal='International Journal of Very Long Research Names';assert.equal(wrapLabel(journal).replaceAll('\n',' '),journal);
 assert.equal(designName('panel_longitudinal'),'纵向 / 面板研究');assert.equal(designName('quasi_experimental'),'准实验研究');assert.equal(unitName('household'),'家庭');
});
