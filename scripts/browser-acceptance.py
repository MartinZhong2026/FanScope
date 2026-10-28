from pathlib import Path
import subprocess,time,json,os
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
work=root/'work'/'browser-acceptance';work.mkdir(parents=True,exist_ok=True)
out=work/'artifacts';out.mkdir(exist_ok=True)
# Every run uses a new isolated SQLite database, never production data.
import tempfile
tmp=tempfile.TemporaryDirectory(prefix='fanscope-browser-')
env={**os.environ,'DATABASE_PATH':str(Path(tmp.name)/'acceptance.sqlite')}

api=subprocess.Popen(['node','--experimental-sqlite',str(root/'api/test/browser-server.mjs')],env=env,stdout=open(work/'api.log','w'),stderr=subprocess.STDOUT)
server_code='''from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
import sys
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=sys.argv[1],**kw)
 def do_GET(self):
  if self.path=='/config.js':
   b=b"window.FANSCOPE_CONFIG={API_BASE_URL:'http://127.0.0.1:8787'};"
   self.send_response(200);self.send_header('Content-Type','application/javascript');self.end_headers();self.wfile.write(b)
  else:super().do_GET()
ThreadingHTTPServer(('127.0.0.1',4173),Handler).serve_forever()
'''
web=subprocess.Popen(['python3','-c',server_code,str(root/'web')],stdout=open(work/'web.log','w'),stderr=subprocess.STDOUT)
try:
 time.sleep(2)
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=os.environ.get('BROWSER_EXECUTABLE','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1440,'height':1000});errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  for width in [1440,1024,390]:
   page.set_viewport_size({'width':width,'height':1000});page.goto('http://127.0.0.1:4173');page.get_by_text('AI Research Brief · 学术情报').wait_for();page.wait_for_function("document.body.innerText.includes('API 已连接')")
   page.screenshot(path=str(out/f'radar-{width}.png'),full_page=True)
   page.locator('[data-page=trends]').first.click();page.locator('#chart-0 canvas').wait_for();page.locator('#chart-6 canvas').wait_for();page.screenshot(path=str(out/f'trends-{width}.png'),full_page=True)
   assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),f'radar overflow {width}'
  page.set_viewport_size({'width':1440,'height':1000});page.goto('http://127.0.0.1:4173/lab/')
  page.locator('[name=email]').fill('acceptance@example.org');page.locator('[name=password]').fill('Acceptance-only-password');page.get_by_role('button',name='登录',exact=True).click();page.locator('[data-nav=projects]').first.click()
  page.get_by_role('button',name='＋ 新建项目').click();page.locator('[name=title]').fill('本地验收项目 · 合成研究');page.locator('[name=summary]').fill('浏览器验收使用，不代表真实课题组数据');page.get_by_role('button',name='保存',exact=True).click();page.get_by_role('button',name='打开 →').first.click()
  page.get_by_role('button',name='添加里程碑').click();page.locator('[name=title]').fill('本地验收方案');page.locator('[name=weight]').fill('2');page.get_by_role('button',name='保存',exact=True).click();page.get_by_role('button',name='标为完成').click();page.get_by_text('100%',exact=False).wait_for()
  page.get_by_role('button',name='增加成员').click();page.get_by_role('button',name='保存',exact=True).click()
  for width in [1440,1024,390]:
   page.set_viewport_size({'width':width,'height':1000});page.screenshot(path=str(out/f'lab-project-{width}.png'),full_page=True);assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),f'lab overflow {width}'
  page.set_viewport_size({'width':1440,'height':1000});page.locator('[data-nav=manuscripts]').click();page.get_by_role('button',name='＋ 登记论文').click();page.locator('[name=title]').fill('本地验收论文 · 合成成果');page.locator('[name=status]').select_option('accepted');page.get_by_role('button',name='保存',exact=True).click();page.get_by_role('button',name='查看 →').first.click();page.get_by_role('button',name='更新论文进度').click();page.locator('[name=target_journals]').fill('Journal A; Journal B');page.locator('[name=actual_submitted_journal]').fill('Journal A');page.get_by_role('button',name='保存',exact=True).click();page.get_by_text('已录用',exact=True).first.wait_for();assert '私人论文' not in page.inner_text('body')
  # Create a synthetic workbook outside Git, then exercise the actual upload/preview/confirm UI.
  xlsx=work/'synthetic-browser.xlsx'
  excel_code="const ExcelJS=require('exceljs');(async()=>{const w=new ExcelJS.Workbook(),s=w.addWorksheet('论文写作与发表');s.addRow(['','Topic/Title','Stage','Target journal','Lead author','Other author']);s.addRow(['已发表','本地验收Excel合成论文','with editor','Journal A; Journal B','Unmapped Name','Other']);await w.xlsx.writeFile(process.argv[1]);})();"
  subprocess.run(['node','-e',excel_code,str(xlsx)],cwd=root/'api',check=True)
  page.locator('#excel-form [type=file]').set_input_files(str(xlsx));page.get_by_role('button',name='预览（不写入论文表）').click();page.locator('[data-import-row]').wait_for();page.locator('[data-import-row] [name=owner_id]').select_option(label='本地验收成员');page.screenshot(path=str(out/'excel-preview-1440.png'),full_page=True);page.get_by_role('button',name='确认选中行并导入').click();page.get_by_text('导入 1 篇',exact=False).wait_for()
  for width in [1440,1024,390]:
   page.set_viewport_size({'width':width,'height':1000});page.screenshot(path=str(out/f'manuscripts-{width}.png'),full_page=True);assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
  page.set_viewport_size({'width':1440,'height':1000})
  page.locator('[data-nav=documents]').click();page.locator('#paste-form [name=title]').fill('本地验收科研交流');page.locator('#paste-form [name=text]').fill('本地验收项目已经完成本轮方案讨论。下一步准备讨论调查安排，这是一份用于自动化浏览器验收的合成文本，不代表任何真实研究项目。');page.get_by_role('button',name='保存文本并生成待审核建议').click();page.get_by_text('本地验收建议更新，等待人工确认',exact=False).first.wait_for(timeout=15000)
  page.locator('#review-form [data-k=decision]').select_option('approve');page.get_by_role('button',name='提交已确认的审核结果').click();page.get_by_text('已确认 1 条更新',exact=False).wait_for();page.screenshot(path=str(out/'document-review-1440.png'),full_page=True)
  browser.close();assert not errors,errors
  (out/'browser-results.json').write_text(json.dumps({'viewports':[1440,1024,390],'flows':['radar','seven ECharts','lab login','project milestone/member','manuscript edit and Excel preview/confirm','text paste AI proposal and human approval'],'pageErrors':errors,'data':'local synthetic acceptance only'},ensure_ascii=False,indent=2))
finally:
 api.terminate();web.terminate();api.wait();web.wait();tmp.cleanup()
