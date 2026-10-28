"""Candidate artifact + candidate read-only API, local cloned corpus only."""
import json,os
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
base='http://127.0.0.1:4177';out=Path('work/release-readiness/blocker-browser');out.mkdir(parents=True,exist_ok=True)
def api(route):
 with urlopen(base+route) as r:return json.load(r)
diag=api('/api/chinese-diagnostics');collected=sum(j['total']>0 for j in diag['items']);total=sum(j['total'] for j in diag['items'])
assert total>0 and collected>0
assert not any(j['connection'] for j in diag['items'])
errors=[];writes=[];external=[];checks=[]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True)
 for width in [1440,390]:
  c=b.new_context(viewport={'width':width,'height':960},locale='zh-CN')
  def route(r):
   if r.request.method not in ['GET','OPTIONS']:writes.append(r.request.url);r.abort()
   elif urlparse(r.request.url).hostname!='127.0.0.1':external.append(r.request.url);r.abort()
   else:r.continue_()
  c.route('**/*',route);page=c.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(base+'/?page=feed&market=chinese&period=all',wait_until='networkidle');expect(page.locator('.cn-quality')).to_contain_text(f'已收录元数据 {collected} 本');expect(page.locator('.cn-quality')).to_contain_text(f'累计 {total} 篇')
  expect(page.locator('.cn-quality')).to_contain_text('自动来源已核验 0 本')
  page.locator('.cn-quality').scroll_into_view_if_needed();page.screenshot(path=str(out/f'{width}-metadata-without-auto.png'))
  page.goto(base+'/?page=sources&market=chinese',wait_until='networkidle');assert page.locator('.source-journal-grid .statuspill').filter(has_text='真实元数据已收录').count()==collected
  assert page.locator('.source-journal-grid .statuspill').filter(has_text='尚未收录元数据').count()>=len(diag['items'])-collected
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  page.screenshot(path=str(out/f'{width}-sources.png'))
  for asset in ['/chinese-import.html','/chinese-import.js','/import-templates/candidate-6.csv']:
   assert page.request.get(base+asset).status==404
  # Simulate an old backend lacking only the new diagnostic endpoint.
  c.route('**/api/chinese-diagnostics',lambda r:r.fulfill(status=404,content_type='application/json',body='{"error":"not found"}'))
  page.goto(base+'/?page=feed&market=international&period=all',wait_until='networkidle');assert '后端暂不可用' not in page.locator('body').inner_text()
  assert page.locator('#q-search').count()>0
  page.goto(base+'/?page=feed&market=chinese&period=all',wait_until='networkidle');expect(page.locator('.cn-quality')).to_contain_text('诊断暂不可用');assert '后端暂不可用' not in page.locator('body').inner_text()
  page.locator('.cn-quality').scroll_into_view_if_needed();page.screenshot(path=str(out/f'{width}-legacy-api-fallback.png'))
  checks.append({'width':width,'localRealMetadata':total,'collectedJournals':collected,'automaticConnections':0,'noDataJournalsNotCollected':True,'legacyDiagnostic404KeepsFeed':True,'workbench404':True,'overflow':False})
  c.close()
 b.close()
assert not errors and not writes and not external
result={'localOnly':True,'checks':checks,'pageErrors':errors,'writeRequests':writes,'externalRequests':external}
(out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False))
