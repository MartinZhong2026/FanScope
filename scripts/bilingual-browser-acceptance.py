"""Bilingual UI acceptance against localhost's isolated mobile fixtures only."""
import argparse,json,os,re
from pathlib import Path
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser();p.add_argument('--output',default='work/bilingual-browser');p.add_argument('--webkit',action='store_true');a=p.parse_args()
out=Path(a.output);out.mkdir(parents=True,exist_ok=True);results=[];errors=[];mutations=[];external=[]
with sync_playwright() as p:
 for engine in ([p.chromium,p.webkit] if a.webkit else [p.chromium]):
  options={'headless':True}
  if engine.name=='chromium' and os.environ.get('BROWSER_EXECUTABLE'):options.update(executable_path=os.environ['BROWSER_EXECUTABLE'],args=['--no-sandbox','--disable-dev-shm-usage'])
  b=engine.launch(**options)
  for width in ([320,375,390,430,768,1440] if engine.name=='chromium' else [390]):
   for theme in (['dark','light'] if engine.name=='chromium' else ['dark']):
    ctx=b.new_context(viewport={'width':width,'height':844 if width<=820 else 1000},has_touch=width<=820,is_mobile=width<=820,color_scheme=theme,reduced_motion='reduce')
    ctx.add_init_script("localStorage.setItem('fanscope-theme',"+json.dumps(theme)+");if(!localStorage.getItem('fanscope-language'))localStorage.setItem('fanscope-language','zh-CN')")
    page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)));requests=[]
    def request(r):
     requests.append(r.url)
     if '/api/admin/' in r.url and r.method not in ['GET','OPTIONS']:mutations.append(r.url)
     if not re.match(r'^http://(?:127\.0\.0\.1|localhost):',r.url):external.append(r.url)
    page.on('request',request)
    def settled():page.wait_for_load_state('networkidle');page.wait_for_timeout(50)
    def go(route):page.goto('http://127.0.0.1:4173'+route);settled()
    def overflow():assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    def switch(language):
     buttons=page.locator('[data-language-toggle]:visible');assert buttons.count()==1
     buttons.click();page.wait_for_function('(lang)=>document.documentElement.lang===lang',arg=language);settled();overflow()
    def shot(name):
     if width in [390,1440] and theme=='dark':page.screenshot(path=str(out/f'{engine.name}-{width}-{name}.png'),animations='disabled')
    go('/');overflow();before=page.locator('.app-activity-row[data-paper] strong,.article-title').all_text_contents();count=len(requests)
    switch('en');assert len(requests)==count,'Language switching must not send API requests'
    assert page.locator('h1').first.inner_text() in ['From research frontiers to progress.','See research trends. Find your next direction.']
    assert page.locator('.app-activity-row[data-paper] strong,.article-title').all_text_contents()==before
    shot('home-en');page.reload();settled();assert page.locator('html').get_attribute('lang')=='en'
    go('/?page=feed&period=all');overflow()
    if width<=820:page.locator('[data-open-literature-filters]').click()
    page.locator('#q-search').fill('Caregiving draft');page.locator('#period-filter').select_option('180d')
    switch('zh-CN');assert page.locator('#q-search').input_value()=='Caregiving draft';assert page.locator('#period-filter').input_value()=='180d'
    go('/?page=trends&period=all');switch('en');overflow()
    if width<=820:page.locator('[data-trend-tab=methods]').click();settled();chart='visual-method-line'
    else:chart='chart-3'
    names=page.evaluate('(id)=>echarts.getInstanceByDom(document.getElementById(id)).getOption().series.map(x=>x.name)',chart)
    assert not any(re.search('[\u3400-\u9fff]',x or '') for x in names),names
    assert 'Usable evidence' in page.locator('body').inner_text();shot('methods-en')
    switch('zh-CN');names=page.evaluate('(id)=>echarts.getInstanceByDom(document.getElementById(id)).getOption().series.map(x=>x.name)',chart);assert any('生存分析' in (x or '') for x in names),names
    switch('en');go('/lab/?view=projects');assert page.locator('html').get_attribute('lang')=='en'
    assert page.get_by_role('heading',name='Member sign in',exact=True).count()==1
    page.locator('[name=email]').fill('mentor@mobile.test');page.locator('[name=password]').fill('Mobile-acceptance-only')
    switch('zh-CN');assert page.locator('[name=email]').input_value()=='mentor@mobile.test';assert page.locator('[name=password]').input_value()=='Mobile-acceptance-only'
    switch('en');shot('login-en');page.locator('#login-form [type=submit]').click();page.locator('#login-form').wait_for(state='hidden');settled();overflow()
    assert page.locator('[data-logout]').count()>0;shot('projects-en')
    page.locator('[data-open="project:mobile-project"]').first.click();settled();page.locator('[data-modal=edit-project]').click();settled()
    page.locator('dialog textarea[name=summary]').fill('保持原文 / retain this unsaved draft')
    switch('zh-CN');assert page.locator('dialog textarea[name=summary]').input_value()=='保持原文 / retain this unsaved draft'
    assert page.locator('[data-logout]').count()>0
    page.locator('dialog [data-close]').click();switch('en')
    go('/lab/?view=documents');overflow();quotes=page.locator('blockquote').all_text_contents()
    page.locator('#paste-form textarea[name=text]').fill('原文 evidence should remain unchanged')
    switch('zh-CN');assert page.locator('#paste-form textarea[name=text]').input_value()=='原文 evidence should remain unchanged';assert page.locator('blockquote').all_text_contents()==quotes
    switch('en');assert page.locator('blockquote').all_text_contents()==quotes
    go('/');assert page.locator('html').get_attribute('lang')=='en';overflow()
    results.append({'browser':engine.name,'width':width,'theme':theme,'passed':True});ctx.close()
  b.close()
report={'results':results,'pageErrors':errors,'unexpectedAdminMutations':mutations,'externalRequests':external}
(out/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({'passed':len(results),'pageErrors':errors,'unexpectedAdminMutations':mutations,'externalRequests':external}))
assert not errors and not mutations and not external
