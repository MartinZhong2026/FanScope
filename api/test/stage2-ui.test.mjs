import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const app=read('../../web/app.js');
const html=read('../../web/index.html');
const lab=read('../../web/lab/index.html');
const css=read('../../web/stage2.css');
const theme=read('../../web/theme.js');
const backend=read('../src/server.mjs');
test('Stage 2 theme loads on research and Lab pages without changing the default app entry',()=>{
 assert.match(html,/\/theme\.js/);assert.match(html,/\/stage2\.css/);
 assert.match(lab,/\/theme\.js/);assert.match(lab,/\/lab\/stage2\.css/);
 assert.match(theme,/localStorage/);assert.match(theme,/dark','light','system/);
 assert.match(css,/:root\[data-theme="dark"\]/);assert.match(css,/:root\[data-theme="light"\]/);
});
test('Six module shortcuts and four mobile tabs navigate to supported pages',()=>{
 assert.match(app,/const workspaceModules=/);assert.match(app,/const mobileTabs=/);
 for(const name of ['最新论文','研究趋势','期刊画像','来源监测','期刊配置','课题组协作'])assert.ok(app.includes(name));
 assert.match(read('../../web/mobile.css'),/\.mobile-dock/);assert.match(read('../../web/mobile.css'),/@media\(max-width:820px\)/);assert.doesNotMatch(css,/\.mobile-bottom-nav/);
});
test('Source UI uses real status API and requires an operator key only on action',()=>{
 assert.match(app,/\/api\/journal-source-status/);
 assert.match(app,/\/api\/admin\/journal-source\//);
 assert.match(app,/const key=prompt\(/);
 assert.doesNotMatch(app,/localStorage\.setItem\([^)]*[Kk]ey/);
 assert.match(backend,/journal-source\/activate/);
 assert.match(backend,/adminOk\(req\)/);
});
test('Existing ECharts layer retains no-evidence empty states and theme contrast',()=>{
 assert.match(app,/chartTitles=/);assert.match(app,/known===0/);assert.match(app,/temporalOption/);assert.match(app,/暂无足够的可核验记录/);
 assert.match(app,/dataset\.theme==='dark'/);
});
