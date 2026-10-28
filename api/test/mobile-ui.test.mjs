import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {launcherHtml,mobileDock,mobilePageAllowed,mobileIcon,appTabs} from '../../web/mobile-ui.js';
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
test('mobile shell is actually loaded in both apps and exposes one shared navigation',()=>{
 for(const file of ['../../web/index.html','../../web/lab/index.html'])assert.match(read(file),/href="\/mobile\.css"/);
 assert.match(read('../../web/lab/index.html'),/viewport-fit=cover/);
 for(const file of ['../../web/app.js','../../web/lab/app.js'])assert.match(read(file),/from ['"].*mobile-ui\.js['"]/);
 assert.deepEqual(appTabs.map(t=>t.page),['home','feed','trends','projects']);
 assert.equal((mobileDock('feed').match(/aria-current="page"/g)||[]).length,1);
 assert.match(mobileDock('article'),/data-page="feed" aria-current="page"/);
 assert.match(mobileDock('projects',{lab:true}),/href="\/lab\/\?view=projects" aria-current="page"/);
 assert.doesNotMatch(read('../../web/stage2.css'),/\.mobile-bottom-nav/);
 assert.doesNotMatch(read('../../web/lab/lab-mobile.css'),/\.lab-mobile-dock/);
});
test('dashboard actions point to actual modules, never create fake research data',()=>{
 const page=launcherHtml('<span>已连接</span>','<p>真实动态</p>');
 for(const route of ['feed','trends','journals'])assert.match(page,new RegExp('data-page="'+route+'"'));
 assert.match(page,/href="\/lab\/\?view=projects"/);assert.match(page,/href="\/lab\/\?view=documents"/);
 assert.match(page,/真实动态/);assert.doesNotMatch(page,/onclick=/i);
 assert.equal(mobilePageAllowed('operations'),true);assert.equal(mobilePageAllowed('article'),true);assert.equal(mobilePageAllowed('secret'),false);
 assert.match(mobileIcon('trend'),/<svg/);assert.match(mobileIcon('trend'),/aria-hidden="true"/);
});
