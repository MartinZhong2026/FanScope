"""Observe existing production pages only. All writes and non-project hosts blocked."""
import json,os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
out=Path('work/release-readiness/production-browser');out.mkdir(parents=True,exist_ok=True)
errors=[];writes=[];blocked=[];checks=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True)
 for width in [1440,390]:
  context=browser.new_context(viewport={'width':width,'height':960},locale='zh-CN')
  def route(r):
   if r.request.method not in ['GET','OPTIONS']:
    writes.append({'url':r.request.url,'method':r.request.method});r.abort();return
   if urlparse(r.request.url).hostname not in ['fanscope.pages.dev','fanscope-api.adapttochina.com']:
    blocked.append(r.request.url);r.abort();return
   r.continue_()
  context.route('**/*',route)
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  for market in ['international','chinese']:
   response=page.goto('https://fanscope.pages.dev/?page=feed&market='+market+'&period=all&article_type=all',wait_until='networkidle',timeout=60000)
   assert response.status==200
   page.screenshot(path=str(out/f'{width}-{market}.png'))
   overflow=page.evaluate('document.documentElement.scrollWidth>innerWidth+1')
   checks.append({'width':width,'market':market,'status':response.status,'overflow':overflow,'visibleBackendError':'后端暂不可用' in page.locator('body').inner_text(),'existingProductionOnly':True})
  context.close()
 browser.close()
result={'checks':checks,'pageErrors':errors,'blockedWrites':writes,'blockedOtherHosts':blocked,'note':'Existing production UI only; not acceptance of a newly deployed candidate. Check visibleBackendError separately; HTTP 200/zero page errors alone do not prove successful data loading.'}
(out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False))
assert not errors,errors
assert not any(c['overflow'] for c in checks)
assert not any(c['visibleBackendError'] for c in checks),'A visible backend warning requires a focused follow-up; do not claim stable acceptance.'
