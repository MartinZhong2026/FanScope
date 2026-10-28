"""Production-quality regression acceptance: localhost fixtures, no mutations.
Capture baseline/fixed builds with identical fixtures using quality-browser-server.
"""
import argparse,json,os,time
from urllib.request import urlopen
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--baseline',action='store_true');p.add_argument('--language',choices=['zh-CN','en'],default='zh-CN');a=p.parse_args()
out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
checks=[];errors=[];external=[];mutations=[]
for attempt in range(100):
 try:
  with urlopen('http://127.0.0.1:4173',timeout=1) as response:
   if response.status==200:break
 except OSError:time.sleep(.1)
else:raise RuntimeError('Isolated fixture server did not become ready')
with sync_playwright() as p:
 options={'headless':True}
 if os.environ.get('BROWSER_EXECUTABLE'):options.update(executable_path=os.environ['BROWSER_EXECUTABLE'],args=['--no-sandbox','--disable-dev-shm-usage'])
 b=p.chromium.launch(**options)
 for width in [320,390,768,1440]:
  ctx=b.new_context(viewport={'width':width,'height':900 if width>820 else 844},is_mobile=width<=820,has_touch=width<=820,reduced_motion='reduce',color_scheme='dark')
  ctx.add_init_script("localStorage.setItem('fanscope-theme','dark');localStorage.setItem('fanscope-language',"+json.dumps(a.language)+")")
  page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  def requests(r):
   if urlparse(r.url).hostname not in ['127.0.0.1','localhost']:external.append(r.url)
   if r.method not in ['GET','OPTIONS']:mutations.append(r.url)
  page.on('request',requests)
  page.on('dialog',lambda d:d.accept('qa-only-admin-key-12345678901234567890'))
  def go(route):page.goto('http://127.0.0.1:4173'+route);page.wait_for_load_state('networkidle');page.wait_for_timeout(100)
  def shot(name,locator=None):
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   (locator or page).screenshot(path=str(out/f'{width}-{name}.png'),animations='disabled',**({'style':'.app-header,.mobile-dock{visibility:hidden!important}'} if locator else {}))
  go('/');shot('home')
  if width<821:
   rows=page.locator('.app-activity-row[data-paper]')
   if not a.baseline:assert rows.evaluate_all('(els)=>els.map(e=>e.dataset.paper)')==['quality-recent-0','quality-recent-1','quality-recent-2']
  elif not a.baseline:assert page.get_by_role('heading',name='Recently discovered' if a.language=='en' else '最近发现',exact=True).count()==1
  checks.append(f'{width} home / publication dates / no overflow')
  go('/?page=trends&period=90d&q=QUALITY-SMALL');shot('trends')
  if width>820:
   card=page.locator('#chart-2').locator('..');shot('journals',card)
   if not a.baseline:
    assert 'International Journal with a Long Unabridged Journal Name' in card.inner_text()
    assert 'cohort' not in card.inner_text()
    assert page.evaluate("echarts.getInstanceByDom(document.getElementById('chart-3')).getOption().series.every(s=>s.type==='bar')")
  else:
   page.locator('[data-trend-tab=methods]').click();page.wait_for_load_state('networkidle');shot('methods')
   if not a.baseline:
    assert page.evaluate("echarts.getInstanceByDom(document.getElementById('visual-method-donut')).getOption().series[0].type")=='bar'
    assert ('Valid papers n=2 / 3' if a.language=='en' else '有效样本 n=2 / 3') in page.locator('body').inner_text()
    assert '66.7%' in page.locator('body').inner_text()
  checks.append(f'{width} small sample bars / independent coverage / full labels')
  go('/?page=operations');page.locator('[data-ops-load-batches]').click();page.locator('.ops-job').first.wait_for(state='visible');page.wait_for_load_state('networkidle')
  queue=page.locator('.ops-queue').filter(has=page.locator('[data-ops-load-batches]'))
  if not a.baseline:
   for summary in queue.locator('.ops-failures summary').all():summary.click()
   text=queue.inner_text();assert '164 / 200' in text and '164 / 164' in text
   assert ('Unknown usage' if a.language=='en' else '用量未知') in text and ('may have incurred a charge' if a.language=='en' else '可能已产生费用') in text
   progress=queue.locator('[role=progressbar]');assert progress.count()==2
   assert progress.first.get_attribute('aria-valuenow')=='164'
  shot('batches',queue)
  checks.append(f'{width} 200/164 batches / accounting / failure reasons')
  if not a.baseline:
   def empty(route):route.fulfill(json={'total':0,'items':[],'limit':3,'offset':0})
   page.route('**/api/articles?limit=3&view=publication&period=90d&precise_date=1',empty)
   go('/');assert ('No papers with a confirmed publication date' if a.language=='en' else '最近90天暂无发表日期明确的论文') in page.locator('body').inner_text();shot('empty-home')
   page.unroute('**/api/articles?limit=3&view=publication&period=90d&precise_date=1',empty)
   go('/?page=trends&period=all&topic=unmatched-quality-topic');assert page.locator('.echart canvas,.visual-chart canvas').count()==0
   checks.append(f'{width} honest empty states')
  ctx.close()
 b.close()
report={'baseline':a.baseline,'checks':checks,'pageErrors':errors,'externalRequests':external,'mutations':mutations}
(out/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({'checks':len(checks),'errors':errors,'externalRequests':external,'mutations':mutations},ensure_ascii=False))
assert not errors and not external and not mutations
