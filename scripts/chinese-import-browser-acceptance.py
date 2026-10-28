"""Synthetic-only UI -> HTTP -> SQLite acceptance. Never a real-paper count."""
import argparse,hashlib,json,os,uuid
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect

p=argparse.ArgumentParser();p.add_argument('--base',default='http://127.0.0.1:4176');p.add_argument('--output',default='work/chinese-authorized-import/browser');a=p.parse_args()
key=os.environ['FANSCOPE_IMPORT_TEST_KEY'];out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
fixtures=Path('work/chinese-authorized-import/fixtures');license_file=fixtures/'SYNTHETIC-LICENSE.txt'
license_file.write_text('合成测试许可文档；仅供自动验收，不授予真实期刊数据权限。',encoding='utf-8')
document_hash=hashlib.sha256(license_file.read_bytes()).hexdigest()
errors=[];external=[];checks=[];run_id=uuid.uuid4().hex[:12]

with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path=os.environ.get('BROWSER_EXECUTABLE',r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'),headless=True)
 for width,count in [(1440,100),(390,1000)]:
  browser_fixture=fixtures/f'SYNTHETIC-browser-{run_id}-{count}.csv'
  browser_fixture.write_text((fixtures/f'SYNTHETIC-{count}.csv').read_text(encoding='utf-8').replace(f'scale-{count}',f'browser-{run_id}-{count}'),encoding='utf-8')
  context=browser.new_context(viewport={'width':width,'height':960},locale='zh-CN')
  def route(r):
   if urlparse(r.request.url).hostname=='127.0.0.1':r.continue_()
   else:external.append(r.request.url);r.abort()
  context.route('**/*',route);page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  def api(route):
   response=page.request.get(a.base+'/api/admin/chinese-imports'+route,headers={'X-Admin-Key':key});assert response.ok,response.text();return response.json()
  def connect():
   page.locator('#key').fill(key);page.locator('#connect button').click();expect(page.locator('#workspace')).to_be_visible();expect(page.locator('#mode')).to_contain_text('合成验收')
  def license():
   f=page.locator('#license-form');f.locator('[name=issuer]').fill('合成测试机构');f.locator('[name=licensee]').fill('合成测试组')
   f.locator('[name=documentRef]').fill(str(license_file));f.locator('[name=expiresOn]').fill('2099-12-31')
   page.locator('#license-document').set_input_files(str(license_file));expect(f.locator('[name=documentHash]')).to_have_value(document_hash)
   f.locator('[name=grantExcerpt]').fill('合成数据本地测试，不是真实论文授权；不允许公开再分发。')
   for box in f.locator('[name=journalId]').all():box.check()
   f.locator('button').click();expect(page.locator('#message')).to_contain_text('pending')
   review=page.locator('#license-review');review.locator('[name=reviewer]').fill('合成许可审核人');review.locator('[name=notes]').fill('已核对合成文档和指纹；本次只验证软件流程。')
   review.locator('[value=approve_local]').click();expect(page.locator('#message')).to_contain_text('已记录许可审查')
  def stage():
   page.locator('#csv-file').set_input_files(str(browser_fixture));expect(page.locator('#stage-button')).to_be_enabled()
   f=page.locator('#file-form');f.locator('[name=operator]').fill('合成上传人');f.locator('[name=permissionRef]').fill('本机合成文件生成器，测试交付单')
   page.locator('#stage-button').click();expect(page.locator('#message')).to_contain_text(f'已暂存{count}条')
   return page.locator('#batch-select').input_value()
  def approve():
   f=page.locator('#row-review');f.locator('[name=reviewer]').fill('合成论文证据审核人');f.locator('[name=notes]').fill('已检查生成文件、行号、合成题名和.invalid保留域名，非真实出版物。');f.locator('[name=allReady]').check();f.locator('[value=approve]').click();expect(page.locator('#message')).to_contain_text('审核已保存')
  page.goto(a.base+'/chinese-import.html');connect();license();batch_id=stage()
  staged=api('/batches/'+batch_id);assert staged['counts']['ready']==count and staged['processed']==0
  assert staged['fileHash']==hashlib.sha256(browser_fixture.read_bytes()).hexdigest(),'CSV fingerprint must match original bytes including BOM'
  page.locator('#batch-summary').scroll_into_view_if_needed();page.screenshot(path=str(out/f'{width}-staging.png'))
  approve();page.locator('#step').click();expect(page.locator('#progress-text')).to_contain_text('已处理 100/')
  if count>100:
   page.reload();connect();page.locator('#batch-select').select_option(batch_id);expect(page.locator('#progress-text')).to_contain_text('已处理 100/')
   page.locator('#run').click();expect(page.locator('#progress-text')).to_contain_text(f'已处理 {count}/{count}',timeout=60000)
  done=api('/batches/'+batch_id);assert done['counts']['imported']==count
  # A new delivery/license must create an independent audit while reusing papers.
  license();second_id=stage();assert second_id!=batch_id;approve();page.locator('#run').click();expect(page.locator('#progress-text')).to_contain_text(f'重复 {count}',timeout=60000)
  replay=api('/batches/'+second_id);assert replay['counts']['duplicate']==count and replay['counts'].get('imported',0)==0
  audit=api('/batches/'+second_id+'/audit');assert len([x for x in audit['items'] if x['event']=='engine_duplicate'])==count
  with page.expect_download() as download:page.locator('#download-errors').click()
  downloaded=out/f'{width}-errors.json';download.value.save_as(str(downloaded));assert json.loads(downloaded.read_text(encoding='utf8'))['rows']==[]
  page.locator('#progress-text').scroll_into_view_if_needed();page.screenshot(path=str(out/f'{width}-completed.png'))
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
  stats=page.request.get(a.base+'/api/articles?market=chinese&period=all').json();assert stats['total']==0
  checks.append({'width':width,'syntheticRows':count,'newSyntheticRecords':done['counts']['imported'],'replayNew':replay['counts'].get('imported',0),'replayDuplicates':replay['counts']['duplicate'],'resumeAfterReload':count>100,'duplicateAuditRows':count,'realPaperCount':stats['total'],'overflow':False,'batchId':batch_id,'replayBatchId':second_id})
  context.close()
 browser.close()
assert not errors,errors
assert not external,external
result={'syntheticOnly':True,'checks':checks,'pageErrors':errors,'externalRequests':external}
(out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False))
