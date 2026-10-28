"""Nine requested reference views + geometry, live data and empty-state checks.
Run only against the isolated local fixture server, alongside the full mobile suite.
"""
import argparse,json,os
from pathlib import Path
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser();p.add_argument('--output',default='work/dark-reference');a=p.parse_args()
out=Path(a.output);out.mkdir(parents=True,exist_ok=True);checks=[];errors=[]
def check(name,ok,detail=None):
 checks.append({'name':name,'pass':bool(ok),'detail':detail})
 if not ok:raise AssertionError((name,detail))
with sync_playwright() as p:
 opts={'headless':True}
 if os.environ.get('BROWSER_EXECUTABLE'):opts.update(executable_path=os.environ['BROWSER_EXECUTABLE'],args=['--no-sandbox'])
 b=p.chromium.launch(**opts)
 for width in [390,320,430,1440]:
  ctx=b.new_context(viewport={'width':width,'height':844 if width<1000 else 1000},is_mobile=width<1000,has_touch=width<1000,color_scheme='dark',reduced_motion='reduce')
  ctx.add_init_script("localStorage.setItem('fanscope-theme','dark')")
  page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  def go(url):page.goto('http://127.0.0.1:4173'+url);page.wait_for_load_state('networkidle')
  def shot(name):
   page.evaluate('scrollTo(0,0)');page.screenshot(path=str(out/name),animations='disabled')
   check(name+' no horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
  go('/')
  shot({390:'01-home-390-dark.png',320:'07-home-320-dark.png',430:'08-home-430-dark.png',1440:'09-home-1440-dark.png'}[width])
  if width<1000:
   boxes=[x.bounding_box() for x in page.locator('.dashboard-tiles .feature-tile').all()]
   check(str(width)+' 2x2 tiles',len(boxes)==4 and abs(boxes[0]['y']-boxes[1]['y'])<2 and boxes[2]['y']>boxes[0]['y'] and abs(boxes[2]['y']-boxes[3]['y'])<2,boxes)
   check(str(width)+' generous touchable tiles',all(x['height']>=130 and x['width']>=120 for x in boxes))
   check(str(width)+' reference colors',page.evaluate("getComputedStyle(document.body).backgroundColor")=='rgb(11, 16, 21)')
   check(str(width)+' real project link',page.locator('.mobile-dock a[href="/lab/?view=projects"]').count()==1)
  if width!=390:ctx.close();continue
  go('/?page=trends&period=all');shot('02-trends-topics-390-dark.png')
  page.screenshot(path=str(out/'02-trends-topics-full.png'),full_page=True,animations='disabled')
  check('topic pane has topic charts only',page.locator('#visual-topic-line').count()==1 and page.locator('#visual-method-line').count()==0)
  # Every line uses the same color as the matching legend / donut entry.
  palette=page.evaluate("echarts.getInstanceByDom(document.getElementById('visual-topic-line')).getOption().series.map(x=>({name:x.name,color:x.itemStyle.color}))")
  legend=page.locator('.topic-chart-legend button').all()
  for row in palette:
   el=next(x for x in legend if x.inner_text().strip()==row['name'])
   check('matching legend '+row['name'],el.locator('i').evaluate('(e)=>getComputedStyle(e).backgroundColor')==page.evaluate('(c)=>{let e=document.createElement("i");e.style.color=c;document.body.append(e);let v=getComputedStyle(e).color;e.remove();return v}',row['color']))
  page.locator('[data-trend-tab=methods]').click();page.wait_for_load_state('networkidle');shot('03-trends-methods-390-dark.png')
  page.screenshot(path=str(out/'03-trends-methods-full.png'),full_page=True,animations='disabled')
  check('method pane actually changes content',page.locator('#visual-method-donut').count()==1 and page.locator('#visual-topic-donut').count()==0)
  page.locator('[data-trend-tab=samples]').click();page.wait_for_load_state('networkidle')
  page.locator('#sample-unit-filter').select_option('household')
  check('sample unit really changes',page.locator('#sample-unit-filter').input_value()=='household' and '家庭' in page.locator('.visual-subtitle').inner_text())
  check('yearly sample unavailable, no invented curve','没有按年份关联' in page.locator('body').inner_text())
  page.locator('[data-trend-tab=sources]').click();page.wait_for_load_state('networkidle')
  check('unknown source preserved','未知来源' in page.locator('.distribution-legend').inner_text())
  go('/?page=trends&period=all&topic=nonexistent-acceptance-topic')
  check('zero-data charts stay empty',page.locator('.visual-chart canvas').count()==0 and page.locator('.visual-empty').count()>0)
  go('/?page=feed&period=all');shot('04-literature-390-dark.png')
  check('no fabricated ranks or bookmarks',page.locator('.paper-card').count()>0 and page.locator('[data-favorite]').count()==0 and 'SCI' not in page.locator('.paper-list').inner_text())
  page.locator('.paper-title').first.click();page.wait_for_load_state('networkidle');shot('05-article-390-dark.png')
  check('detail keeps research question and evidence','研究问题' in page.locator('body').inner_text() and '置信度' in page.locator('body').inner_text())
  page.locator('.mobile-dock a[href="/lab/?view=projects"]').click();page.wait_for_load_state('networkidle')
  check('projects use real login flow',page.locator('#login-form').count()==1)
  page.locator('[name=email]').fill('mentor@mobile.test');page.locator('[name=password]').fill('Mobile-acceptance-only');page.locator('#login-form [type=submit]').click();page.locator('#login-form').wait_for(state='hidden');page.locator('.project-card').first.wait_for(state='visible')
  shot('06-projects-390-dark.png')
  check('projects remain real business cards',page.locator('.project-card').count()>=2)
  ctx.close()
 b.close()
(out/'visual-checks.json').write_text(json.dumps({'checks':checks,'passed':sum(x['pass'] for x in checks),'errors':errors},ensure_ascii=False,indent=2))
print(json.dumps({'passed':sum(x['pass'] for x in checks),'errors':errors},ensure_ascii=False))
if errors:raise SystemExit(1)
