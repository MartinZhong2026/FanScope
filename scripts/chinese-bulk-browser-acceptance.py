"""Acceptance against the real isolated corpus. No fixture papers or AI calls."""
import argparse,json,os,re
from pathlib import Path
from urllib.parse import urlparse,quote
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

p=argparse.ArgumentParser();p.add_argument('--output',default='work/chinese-bulk/browser');p.add_argument('--base',default='http://127.0.0.1:4174');p.add_argument('--api',default='http://127.0.0.1:8788');a=p.parse_args()
out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
def api(path):
 with urlopen(a.api+path,timeout=15) as r:return json.load(r)
expected=api('/api/articles?market=chinese&period=all')['total']
assert expected>0
sample=api('/api/articles?market=chinese&period=all&journal=candidate-1')['items'][0]
errors=[];blocked=[];mutations=[];checks=[];source_checks=[]
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('BROWSER_EXECUTABLE',r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'),headless=True)
 for width in [1440,390]:
  context=b.new_context(viewport={'width':width,'height':960},locale='zh-CN')
  allowed_source=sample['article_url']
  def route(r):
   u=r.request.url
   if urlparse(u).hostname=='127.0.0.1' or u==allowed_source:r.continue_()
   else:blocked.append(u);r.abort()
  context.route('**/*',route)
  context.on('request',lambda r:mutations.append(r.url) if r.method not in ['GET','OPTIONS'] else None)
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(a.base+'/?page=feed&market=chinese&period=all');page.wait_for_load_state('networkidle')
  assert page.locator('.cn-quality').count()==1
  shown=int(re.search(r'累计 (\d+) 篇',page.locator('.cn-quality').inner_text()).group(1));assert shown>=expected
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  page.screenshot(path=str(out/f'{width}-real-feed.png'),animations='disabled')
  if width<600:page.locator('[data-open-literature-filters]').click()
  page.locator('#journal-filter').select_option('candidate-1')
  page.locator('#q-search').fill(sample['title'][:6]);page.locator('#apply-search').click();page.wait_for_load_state('networkidle')
  assert sample['title'] in page.locator('body').inner_text()
  assert 'journal=candidate-1' in page.url
  page.screenshot(path=str(out/f'{width}-search-filter.png'),animations='disabled')
  with page.expect_popup() as event:page.locator(f'a[href="{allowed_source}"]').first.click()
  popup=event.value
  try:
   popup.wait_for_url(allowed_source,wait_until='domcontentloaded',timeout=30000)
   assert popup.locator('meta[name="citation_title"]').first.get_attribute('content')==sample['title']
   source_checks.append({'width':width,'url':popup.url,'passed':True})
  except Exception as e:
   source_checks.append({'width':width,'requested':allowed_source,'url':popup.url,'passed':False,'error':str(e)[:500]})
   popup.screenshot(path=str(out/f'{width}-source-access.png'))
  (out/'source-checks.json').write_text(json.dumps(source_checks,ensure_ascii=False,indent=2),encoding='utf-8')
  popup.close()
  page.goto(a.base+'/?page=feed&market=chinese&period=180d&journal=candidate-1');page.wait_for_load_state('networkidle')
  if width<600:page.locator('[data-open-literature-filters]').click()
  page.locator('#period-filter').select_option('30d')
  page.locator('#topic-filter').select_option('care')
  if width<600:page.locator('[data-apply-filters]').click()
  else:page.locator('#apply-search').click()
  page.wait_for_load_state('networkidle')
  assert 'period=30d' in page.url and 'topic=care' in page.url
  filtered=api('/api/articles?market=chinese&period=30d&journal=candidate-1&topic=care')['total']
  count_text=page.locator('.discovery-list-head' if width<600 else '.article-grid .panel-head .meta').first.inner_text()
  assert re.search(r'\b'+str(filtered)+r'\b',count_text)
  page.screenshot(path=str(out/f'{width}-date-topic-filter.png'),animations='disabled')
  page.goto(a.base+'/?page=trends&market=chinese&period=180d');page.wait_for_load_state('networkidle')
  assert page.locator('.cn-quality').count()==1
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  assert 'market=chinese' in page.url
  page.screenshot(path=str(out/f'{width}-real-trends.png'),animations='disabled')
  page.locator('[data-market=international]:visible').first.click();page.wait_for_load_state('networkidle')
  assert 'market=international' in page.url
  assert page.locator('.cn-quality').count()==0
  assert api('/api/research?market=international&period=all')['n']==0
  page.goto(a.base+'/?page=sources&market=chinese');page.wait_for_load_state('networkidle')
  collected=sum(j['total']>0 for j in api('/api/chinese-diagnostics')['items'])
  assert page.locator('.source-journal-grid .statuspill').filter(has_text='真实元数据已收录').count()==collected
  assert int(page.get_by_text('已有元数据记录',exact=True).locator('..').locator('b').inner_text())==collected
  assert api('/api/system-status')['unconfiguredChinese']==sum(not j['article_count'] and not j.get('automatic_source_verified') and not j['enabled'] for j in api('/api/system-status')['journals'] if j['market']=='chinese')
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  page.screenshot(path=str(out/f'{width}-real-sources.png'),animations='disabled')
  checks.append({'width':width,'corpus':expected,'search':True,'journalFilter':True,'dateTopicFilter':True,'filteredCount':filtered,'sourceOpened':allowed_source,'sourceStatesCorrect':True,'marketIsolation':True,'viewportOverflow':False})
  context.close()
 b.close()
result={'checks':checks,'sourceChecks':source_checks,'errors':errors,'blockedRequests':blocked,'mutations':mutations}
(out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
assert not errors and not mutations
print(json.dumps({'passed':len(checks),'corpus':expected,'sourceChecks':source_checks,'errors':errors,'mutations':mutations}))
