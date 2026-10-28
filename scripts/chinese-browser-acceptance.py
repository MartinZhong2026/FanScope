import argparse,json,os,time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser();p.add_argument('--output',default='work/chinese-browser');a=p.parse_args();out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
for i in range(100):
 try:
  urlopen('http://127.0.0.1:4173',timeout=1);break
 except OSError:time.sleep(.1)
errors=[];mutations=[];checks=[]
with sync_playwright() as p:
 opts={'headless':True}
 if os.environ.get('BROWSER_EXECUTABLE'):opts.update(executable_path=os.environ['BROWSER_EXECUTABLE'],args=['--no-sandbox'])
 b=p.chromium.launch(**opts)
 for w in [320,390,768,1440]:
  page=b.new_page(viewport={'width':w,'height':900});page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('request',lambda r:mutations.append(r.url) if r.method not in ['GET','OPTIONS'] else None)
  page.goto('http://127.0.0.1:4173/?page=trends&market=chinese&period=180d');page.wait_for_load_state('networkidle')
  assert page.locator('.cn-diagnostics').count()==1
  assert '2025—2026' in page.locator('.cn-diagnostics').inner_text()
  assert '有效样本 n=1 / 1' in page.locator('body').inner_text()
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  page.screenshot(path=str(out/f'{w}-chinese-trends.png'),animations='disabled')
  page.locator('[data-market=international]:visible').first.click();page.wait_for_load_state('networkidle')
  assert page.locator('.cn-diagnostics').count()==0
  assert 'market=international' in page.url
  page.goto('http://127.0.0.1:4173/?page=sources');page.wait_for_load_state('networkidle');assert page.locator('[data-cn-source]').count()==1
  # V1.4 moved the inline import form into a separately staged local workbench.
  assert page.locator('.cn-diagnostics a[href="chinese-import.html"]').count()==1
  assert page.locator('form[data-cn-import]').count()==0
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  page.screenshot(path=str(out/f'{w}-sources.png'),animations='disabled')
  checks.append({'width':w,'passed':True});page.close()
 b.close()
assert not errors and not mutations
(out/'results.json').write_text(json.dumps({'checks':checks,'errors':errors,'mutations':mutations},ensure_ascii=False,indent=2))
print(json.dumps({'passed':len(checks),'errors':errors,'mutations':mutations}))
