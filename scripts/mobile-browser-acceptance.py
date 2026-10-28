"""Run against api/test/mobile-browser-server.mjs, never a production API.
Requires Python Playwright and Chromium (optionally WebKit). Screenshots contain
clearly labelled, isolated acceptance fixtures, never invented product data.
"""
import argparse
import json
import os
import time
import traceback
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

parser=argparse.ArgumentParser()
parser.add_argument('--base-url',default='http://127.0.0.1:4173')
parser.add_argument('--output',default='work/mobile-browser-results')
parser.add_argument('--webkit',action='store_true')
parser.add_argument('--before-root')
parser.add_argument('--widths',default='320,375,390,430,768,1440')
parser.add_argument('--themes',default='light,dark')
parser.add_argument('--skip-e2e',action='store_true')
args=parser.parse_args()
if urlparse(args.base_url).hostname not in ['127.0.0.1','localhost']:
    raise SystemExit('Acceptance must use an isolated localhost fixture server')
for attempt in range(100):
    try:
        with urlopen(args.base_url,timeout=1) as response:
            if response.status==200:break
    except OSError:
        time.sleep(.1)
else:
    raise SystemExit('Local acceptance server did not become ready')
out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
results=[];errors=[];paid=[]

def check(name,fn):
    try:
        fn();results.append({'name':name,'status':'pass'})
    except Exception as e:
        results.append({'name':name,'status':'fail','error':traceback.format_exc()});print('FAIL',name,str(e)[:300],flush=True)

def settled(page):
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(80)

def go(page,route):
    page.goto(args.base_url+route);settled(page)

def screenshot(page,name):
    page.screenshot(path=str(out/(name+'.png')),full_page=False,animations='disabled')

def no_overflow(page):
    dims=page.evaluate('''() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return s.display!=='none'&&r.width>0&&r.right>innerWidth+1&&s.position!=='fixed'&&!e.closest('.dimension-tabs,.lab-module-tabs')}).slice(0,8).map(e=>e.className)})''')
    assert dims['scroll']<=dims['width']+1,dims

def nav(page,route,width):
    selector=f'.mobile-dock [data-page="{route}"]' if width<=820 else f'.sidebar [data-page="{route}"]'
    page.locator(selector).click();settled(page)

def login(page,role='mentor'):
    page.locator('#login-form [name=email]').fill(role+'@mobile.test')
    page.locator('#login-form [name=password]').fill('Mobile-acceptance-only')
    page.locator('#login-form [type=submit]').click();page.locator('#login-form').wait_for(state='hidden');page.wait_for_function("!document.querySelector('.loading-note')");settled(page)
    assert page.locator('#login-form').count()==0,page.locator('body').inner_text()

def bind(page):
    page.on('pageerror',lambda e:errors.append(str(e)))
    def request(r):
        if '/api/admin/' in r.url and r.method!='GET':paid.append(r.url)
    page.on('request',request)

with sync_playwright() as p:
    launch={'headless':True}
    if os.environ.get('BROWSER_EXECUTABLE'):
        launch.update(executable_path=os.environ['BROWSER_EXECUTABLE'],args=['--no-sandbox','--disable-dev-shm-usage'])
    browser=p.chromium.launch(**launch)
    # Capture the actual pre-change assets against the SAME test API / fixtures.
    if args.before_root:
        root=Path(args.before_root).resolve()
        baseline_browser=p.chromium.launch(**{**launch,'args':launch.get('args',[])+['--disable-features=LocalNetworkAccessChecks']})
        ctx=baseline_browser.new_context(viewport={'width':390,'height':844})
        page=ctx.new_page()
        def baseline(route):
            u=urlparse(route.request.url)
            if u.port!=4173 or u.path=='/config.js':return route.continue_()
            rel=u.path.lstrip('/') or 'index.html'
            if rel.endswith('/'):rel+='index.html'
            f=(root/rel).resolve()
            if not f.is_relative_to(root) or not f.is_file():return route.continue_()
            mime={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'}.get(f.suffix,'application/octet-stream')
            route.fulfill(body=f.read_bytes(),content_type=mime)
        page.route('**/*',baseline)
        go(page,'/');screenshot(page,'before-home-390')
        for name in ['feed','trends']:
            page.locator(f'.mobile-bottom-nav [data-page={name}]').click();settled(page);screenshot(page,'before-'+name+'-390')
        go(page,'/lab/?view=projects');screenshot(page,'before-lab-login-390')
        login(page);screenshot(page,'before-projects-390')
        go(page,'/lab/?view=documents');screenshot(page,'before-documents-390')
        ctx.close();baseline_browser.close()
    for width in [int(w) for w in args.widths.split(',') if w]:
        for theme in args.themes.split(','):
            mobile=width<=820
            ctx=browser.new_context(viewport={'width':width,'height':844 if mobile else 1000},has_touch=mobile,is_mobile=mobile,color_scheme=theme,reduced_motion='reduce')
            ctx.add_init_script("localStorage.setItem('fanscope-theme',"+json.dumps(theme)+")")
            page=ctx.new_page();page.set_default_timeout(7000);bind(page)
            prefix=f'{width}-{theme}'
            def home():
                go(page,'/');no_overflow(page)
                assert page.locator('.mobile-dock:visible').count()==(1 if mobile else 0)
                if mobile:
                    assert page.locator('.app-dashboard').count()==1
                    assert page.locator('.app-greeting h1').inner_text()=='从学术前沿，到研究进展。'
                    assert page.locator('.app-activity-row[data-paper]').count()==3
                    targets=page.locator('.app-quick-grid a,.app-quick-grid button')
                    for target in targets.all():
                        box=target.bounding_box();assert box['height']>=44 and box['width']>=44
                else:assert page.locator('.module-card').count()==6
                if width in [320,390,430,1440]:screenshot(page,prefix+'-home')
            check(prefix+' dashboard / single dock / touch targets / overflow',home)
            def literature():
                nav(page,'feed',width);no_overflow(page)
                if mobile:
                    assert page.locator('.mobile-dock [aria-current=page]').get_attribute('data-page')=='feed'
                    page.locator('.discovery-chips [data-market=chinese]').click();settled(page)
                    # Wait for the requested market render, then capture all tags
                    # atomically: a refresh can replace indexed locators mid-loop.
                    page.wait_for_function("document.querySelector('.discovery-chips [data-market=chinese].active') && !document.querySelector('.loading-note')")
                    tags=page.locator('.paper-card .tags').all_inner_texts()
                    assert tags and all('国内 C 刊' in text for text in tags),tags
                    page.locator('.discovery-chips [data-market=international]').click();settled(page)
                    page.locator('[data-open-literature-filters]').click()
                page.locator('#q-search').fill('Caregiving')
                page.locator('#period-filter').select_option('all')
                page.locator('#apply-search').click();settled(page)
                assert page.locator('#q-search').input_value()=='Caregiving'
                assert page.locator('#period-filter').input_value()=='all'
                if mobile:
                    assert page.locator('.app-filter').get_attribute('open') is not None
                    page.locator('.app-filter summary').click()
                    if width==390:screenshot(page,prefix+'-literature')
                    card=page.locator('.paper-title').nth(3);card.scroll_into_view_if_needed();scroll=page.evaluate('scrollY')
                    card.click();settled(page)
                    assert parse_qs(urlparse(page.url).query)['page']==['article']
                    assert page.locator('.article-abstract').count()==1
                    assert '置信度' in page.locator('.article-detail').inner_text()
                    no_overflow(page)
                    if width==390:screenshot(page,prefix+'-article')
                    page.locator('[data-app-back]').click();settled(page)
                    assert parse_qs(urlparse(page.url).query)['page']==['feed']
                    assert abs(page.evaluate('scrollY')-scroll)<4,(page.evaluate('scrollY'),scroll)
                    assert page.locator('#q-search').input_value()=='Caregiving'
                    page.go_forward();settled(page);page.reload();settled(page)
                    assert page.locator('.article-detail').count()==1
                    page.go_back();settled(page)
                    for batch in range(5):
                        page.locator('#more-articles').click();settled(page)
                    assert page.locator('.paper-card').count()>100
                    assert page.locator('#more-articles').count()==0
                no_overflow(page)
            check(prefix+' literature / systems / filters / detail / history / scroll / pagination',literature)
            def trends():
                go(page,'/?page=trends&period=all')
                if mobile:
                    assert page.locator('.research-tabs button').count()==4
                    for tab,ids in [('topics',['visual-topic-line','visual-topic-donut']),('methods',['visual-method-donut','visual-method-line']),('samples',['visual-sample-bars']),('sources',['visual-source-donut','visual-source-line'])]:
                        page.locator(f'[data-trend-tab="{tab}"]').click();settled(page)
                        assert parse_qs(urlparse(page.url).query)['trend_tab']==[tab]
                        for id in ids:assert page.locator('#'+id).count()==1
                        assert page.locator('.visual-chart canvas').count()>=1
                        no_overflow(page)
                        assert page.locator('.trend-caption').count()>=2
                    page.locator('[data-trend-tab="topics"]').click();settled(page)
                    assert page.evaluate("echarts.getInstanceByDom(document.getElementById('visual-topic-line')).getOption().tooltip[0].confine")
                    assert page.locator('#visual-method-line').count()==0
                    page.locator('[data-expand-visual=visual-topic-line]').click()
                    assert page.locator('dialog[open] #visual-topic-line').is_visible()
                    page.keyboard.press('Escape');assert page.locator('dialog[open]').count()==0
                    assert '不是互斥论文占比' in page.locator('body').inner_text()
                    totals=page.evaluate("async()=>{const r=await (await fetch('http://127.0.0.1:8787/api/research?period=all&market=international')).json();return {topics:Object.values(r.topics).reduce((a,b)=>a+b,0),methods:Object.values(r.methods).reduce((a,b)=>a+b,0),units:Object.keys(r.samples)}}")
                    assert page.evaluate("echarts.getInstanceByDom(document.getElementById('visual-topic-donut')).getOption().series[0].data.reduce((a,b)=>a+b.value,0)")==totals['topics']

                    if width==390:screenshot(page,prefix+'-trends-topics')
                    page.locator('[data-trend-tab="methods"]').click();settled(page)
                    assert page.locator('#visual-topic-line').count()==0
                    assert page.evaluate("echarts.getInstanceByDom(document.getElementById('visual-method-donut')).getOption().series[0].data.reduce((a,b)=>a+b.value,0)")==totals['methods']
                    if width==390:screenshot(page,prefix+'-trends-methods')
                    page.locator('[data-open-trend-filters]').click()
                    assert page.locator('.trend-filter-panel').get_attribute('open') is not None
                    page.locator('.trend-filter-panel summary').click()
                    page.locator('.trend-evidence>summary').click()
                    assert '仅基于题名/摘要' in page.locator('.trend-evidence').inner_text()
                    page.locator('.trend-evidence>summary').click()
                no_overflow(page)
                if width==1440:screenshot(page,prefix+'-trends')
            check(prefix+' trend categories / real distinct charts / coverage / evidence',trends)
            def journals():
                go(page,'/?page=journals');page.locator('.content [data-market=chinese]').click();settled(page)
                assert all('国内 C 刊' in x.inner_text() for x in page.locator('.journal-card').all())
                page.locator('.content [data-market=international]').click();settled(page)
                assert all('国外英文期刊' in x.inner_text() for x in page.locator('.journal-card').all())
                no_overflow(page)
                if width==390:screenshot(page,prefix+'-journals')
            check(prefix+' journal evaluation systems remain separate',journals)
            def account():
                go(page,'/?page=me')
                assert page.locator('[data-page=operations]').count()>0
                assert page.locator('a[href="/lab/?view=documents"]').count()>0
                if mobile:
                    page.locator('.mobile-dock [data-page=home]').click();settled(page)
                    page.go_back();settled(page)
                    assert page.locator('h1').inner_text()=='我的工作台'
                go(page,'/lab/?view=projects')
                assert page.locator('#login-form').count()==1
                no_overflow(page)
                if width==390:screenshot(page,prefix+'-login')
                page.locator('[name=email]').fill('mentor@mobile.test')
                page.locator('[name=password]').fill('wrong-password')
                page.locator('#login-form [type=submit]').click();page.get_by_text('邮箱或密码不正确',exact=False).wait_for(state='visible');settled(page)
                assert '密码不正确' in page.locator('body').inner_text()
                login(page)
                assert page.locator('.mobile-dock:visible').count()==(1 if mobile else 0)
                no_overflow(page)
            check(prefix+' account / admin access / failed and valid login',account)
            def projects():
                if mobile:
                    assert page.locator('.project-card').count()>=2
                    assert '研究设计' in page.locator('.project-card').first.inner_text()
                    assert '验收成员' in page.locator('.project-card').first.inner_text()
                    if width==390:screenshot(page,prefix+'-projects')
                page.locator('[data-open="project:mobile-project"]').first.click();settled(page)
                assert parse_qs(urlparse(page.url).query)['record']==['project:mobile-project']
                assert page.locator('.record-detail').is_visible()
                if mobile:assert not page.locator('.record-list').is_visible()
                no_overflow(page)
                if width==390:screenshot(page,prefix+'-project-detail')
                page.locator('[data-modal=edit-project]').click()
                assert page.locator('dialog[open]').count()==1
                page.locator('dialog [name=summary]').fill('本地验收编辑：保留表单输入与权限校验。')
                no_overflow(page)
                if width==390:screenshot(page,prefix+'-project-edit')
                page.keyboard.press('Escape')
                assert page.locator('dialog[open]').count()==0
                page.go_back();settled(page)
                assert 'record' not in parse_qs(urlparse(page.url).query)
                page.go_forward();settled(page)
                assert page.locator('.record-detail').is_visible()
                go(page,'/lab/?view=manuscripts')
                if mobile:
                    assert not page.locator('.shared-table').is_visible()
                    assert page.locator('.manuscript-cards .project-card').count()>=3
                no_overflow(page)
            check(prefix+' project facts / details / history / native dialog / manuscript cards',projects)
            def documents():
                go(page,'/lab/?view=documents');no_overflow(page)
                page.locator('#paste-form [name=title]').fill('保留草稿')
                # A redraw must preserve both text and selected file input nodes.
                page.locator('#upload-form input[type=file]').set_input_files({'name':'draft.md','mimeType':'text/markdown','buffer':b'acceptance-only draft file, not uploaded or analyzed'})
                page.locator('[data-nav=members]:visible').first.click();settled(page)
                page.locator('[data-nav=documents]:visible').first.click();settled(page)
                assert page.locator('#paste-form [name=title]').input_value()=='保留草稿'
                assert page.locator('#upload-form input[type=file]').evaluate('(e)=>e.files[0].name')=='draft.md'
                if width==390:screenshot(page,prefix+'-documents')
                page.locator('[data-open="document:mobile-doc"]').first.click();settled(page)
                page.locator('#review-form').wait_for(state='visible')
                assert page.locator('.review-decisions').count()==2
                page.locator('[data-sid=mobile-approve][data-k=summary]').fill('人工修改后的研究方案建议')
                page.locator('[data-sid=mobile-approve][value=approve]').check()
                page.locator('[data-sid=mobile-reject][value=reject]').check()
                no_overflow(page)
                if width==390:screenshot(page,prefix+'-review')
                page.go_back();settled(page)
                assert page.locator('#upload-form').is_visible()
            check(prefix+' documents / file and form drafts / AI suggestions / clear review decisions',documents)
            if width==390 and theme=='light':
                def environment():
                    go(page,'/?page=feed&period=all')
                    page.add_style_tag(content=':root {--app-safe-bottom:34px}')
                    height=page.locator('.mobile-dock').bounding_box()['height'];assert height>=100,height
                    page.evaluate("document.documentElement.style.fontSize='125%'")
                    no_overflow(page);screenshot(page,'390-light-safe-area')
                    page.set_viewport_size({'width':844,'height':390});settled(page);no_overflow(page)
                    page.set_viewport_size({'width':390,'height':844});settled(page)
                    page.locator('[data-open-literature-filters]').click();page.locator('#q-search').focus()
                    page.evaluate("Object.defineProperty(visualViewport,'height',{configurable:true,value:450});visualViewport.dispatchEvent(new Event('resize'))")
                    assert page.locator('html').get_attribute('class')=='keyboard-open'
                    assert not page.locator('.mobile-dock').is_visible()
                    page.evaluate("delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'))")
                check(prefix+' safe area / text scaling / rotation / virtual keyboard',environment)
            ctx.close()
    if not args.skip_e2e:
        # End-to-end failure/retry and server authorization in separate authenticated contexts.
        ctx=browser.new_context(viewport={'width':390,'height':844});page=ctx.new_page();bind(page)
        def review_flow():
            go(page,'/lab/?view=documents&record=document:mobile-doc');login(page)
            page.locator('[data-sid=mobile-approve][data-k=summary]').fill('人工修改后的研究方案建议')
            page.locator('[data-sid=mobile-approve][value=approve]').check()
            page.locator('[data-sid=mobile-reject][value=reject]').check()
            page.route('**/api/lab/documents/mobile-doc/review',lambda r:r.fulfill(status=503,content_type='application/json',body='{"error":"验收模拟：暂时不可用"}'))
            page.locator('#review-form [type=submit]').click();settled(page)
            assert page.locator('[data-sid=mobile-approve][data-k=summary]').input_value()=='人工修改后的研究方案建议'
            assert page.locator('[data-sid=mobile-reject][value=reject]').is_checked()
            page.unroute('**/api/lab/documents/mobile-doc/review')
            page.locator('#review-form [type=submit]').click();settled(page)
            assert '已确认 1 条更新，驳回 1 条' in page.locator('body').inner_text()
            assert '已批准' in page.locator('.record-detail').inner_text()
            assert '已驳回' in page.locator('.record-detail').inner_text()
            go(page,'/lab/?view=documents')
            page.locator('#upload-form input[type=file]').set_input_files({'name':'[隔离验收数据] upload.md','mimeType':'text/markdown','buffer':b'# acceptance only\nThis is an isolated upload test. No production data or real model calls are used.'})
            page.locator('#upload-form [type=submit]').click();settled(page)
            assert 'record=document' in page.url
            assert 'upload.md' in page.locator('.record-detail').inner_text()
            assert page.locator('button[data-download]').is_visible()
        check('390 actual API: review edits survive 503, retry approves/rejects, document upload works',review_flow)
        ctx.close()
        for role in ['member','admin','other','mentor']:
            ctx=browser.new_context(viewport={'width':390,'height':844});page=ctx.new_page();bind(page)
            def permissions(role=role):
                go(page,'/lab/?view=projects');login(page,role)
                staff=role in ['admin','mentor']
                assert page.locator('[data-modal=new-project]').count()==(1 if staff else 0)
                go(page,'/lab/?view=documents&record=document:mobile-doc')
                body=page.locator('body').inner_text()
                if role in ['mentor','other']:
                    assert '[隔离验收数据] 组会记录.txt' in body
                else:
                    assert '仅上传者和导师可查看' in body
                    assert page.locator('.review').count()==0
                # Verify private member notes and raw document access via the real API too.
                result=page.evaluate('''async()=>{const t=sessionStorage.getItem('fanscope_lab_token'),h={Authorization:'Bearer '+t};const users=await (await fetch('http://127.0.0.1:8787/api/lab/users',{headers:h})).json();const other=users.items.find(x=>x.email==='other@mobile.test');const update=await (await fetch('http://127.0.0.1:8787/api/lab/members/'+other.id,{headers:h})).json();const doc=await fetch('http://127.0.0.1:8787/api/lab/documents/mobile-doc/file',{headers:h});return {update,docStatus:doc.status}}''')
                text=json.dumps(result['update'])
                assert ('PRIVATE_FIXTURE_ONLY_OTHER_AND_MENTOR' in text)==(role in ['other','mentor'])
                assert result['docStatus']==(200 if role in ['other','mentor'] else 403)
                no_overflow(page)
                if role=='member':screenshot(page,'390-permission-denied')
            check(role+' data / controls / private notes / source-file permissions',permissions)
            ctx.close()
        ctx=browser.new_context(viewport={'width':390,'height':844});page=ctx.new_page();bind(page)
        def switch_account():
            go(page,'/lab/?view=members');login(page,'mentor')
            other=page.evaluate("async()=>{const h={Authorization:'Bearer '+sessionStorage.getItem('fanscope_lab_token')};return (await (await fetch('http://127.0.0.1:8787/api/lab/users',{headers:h})).json()).items.find(u=>u.email==='other@mobile.test').id}")
            page.locator('[data-open="member:'+other+'"]').click();settled(page)
            assert 'PRIVATE_FIXTURE_ONLY_OTHER_AND_MENTOR' in page.locator('body').inner_text()
            page.locator('[data-logout]:visible').first.click();settled(page)
            assert 'PRIVATE_FIXTURE_ONLY_OTHER_AND_MENTOR' not in page.locator('body').inner_text()
            login(page,'member')
            assert 'PRIVATE_FIXTURE_ONLY_OTHER_AND_MENTOR' not in page.locator('body').inner_text()
            assert '个人近况仅本人和导师' in page.locator('body').inner_text()
        check('same browser: logout and role switch clear private record caches',switch_account);ctx.close()
        # Real request failure and retry, with no fabricated fallback data.
        ctx=browser.new_context(viewport={'width':390,'height':844});page=ctx.new_page();bind(page)
        def offline():
            page.route('**/api/**',lambda r:r.abort())
            go(page,'/');assert '后端暂不可用' in page.locator('body').inner_text()
            page.unroute('**/api/**');page.locator('[data-reload]').click();settled(page)
            assert '数据服务已连接' in page.locator('body').inner_text()
        check('network error exposes working retry',offline);ctx.close()
    ctx=browser.new_context(viewport={'width':390,'height':844},has_touch=True,is_mobile=True,color_scheme='dark')
    page=ctx.new_page();bind(page)
    def direct_links_and_theme():
        go(page,'/?page=feed&period=all')
        article=page.locator('.paper-title').first.get_attribute('href')
        go(page,'/'+article)
        page.locator('[data-app-back]').click();settled(page)
        assert parse_qs(urlparse(page.url).query)['page']==['feed']
        page.locator('[data-app-back]').click();settled(page)
        assert parse_qs(urlparse(page.url).query)['page']==['home']
        go(page,'/?page=me')
        page.evaluate("FanScopeTheme.set('dark')")
        page.locator('.app-header [data-theme-next]').click();settled(page)
        go(page,'/?page=trends&period=all')
        assert page.locator('html').get_attribute('data-theme')=='light'
        assert page.evaluate("echarts.getInstanceByDom(document.querySelector('.visual-chart')).getOption().textStyle.color")=='#607681'
        page.evaluate("FanScopeTheme.set('system')")
        page.emulate_media(color_scheme='dark');page.wait_for_function("document.documentElement.dataset.theme==='dark'")
        assert page.evaluate("echarts.getInstanceByDom(document.querySelector('.visual-chart')).getOption().textStyle.color")=='#9CAABD'
        go(page,'/lab/?view=projects&record=project:mobile-project')
        login(page)
        page.locator('[data-app-back]').click();settled(page)
        assert 'record' not in parse_qs(urlparse(page.url).query)
        assert page.locator('.record-list').is_visible()
        page.locator('[data-app-back]').click();settled(page)
        assert parse_qs(urlparse(page.url).query)['page']==['me']
    check('direct detail URLs: root back has no loop; theme controls and system ECharts contrast update',direct_links_and_theme)
    ctx.close()
    browser.close()
    if args.webkit:
        browser=p.webkit.launch(headless=True)
        for width in [int(w) for w in args.widths.split(',') if w]:
            ctx=browser.new_context(viewport={'width':width,'height':844},has_touch=width<=820,is_mobile=width<=820,color_scheme='dark')
            page=ctx.new_page();bind(page)
            def safari(width=width):
                for url in ['/?page=home','/?page=feed&period=all','/?page=trends&period=all','/?page=journals','/lab/?view=projects']:
                    go(page,url);no_overflow(page)
                login(page)
                page.locator('[data-open="project:mobile-project"]').first.click();settled(page)
                page.locator('[data-modal=edit-project]').click();assert page.locator('dialog[open]').count()==1
                no_overflow(page);page.keyboard.press('Escape')
                if width==390:screenshot(page,'390-webkit-project')
            check(str(width)+' WebKit Safari: key routes / layouts / login / native dialog',safari)
            ctx.close()
        browser.close()
report={'passed':sum(x['status']=='pass' for x in results),'failed':sum(x['status']=='fail' for x in results),'results':results,'pageErrors':errors,'unexpectedAdminMutations':paid,'notes':['Screenshots use labelled isolated test fixtures, never production data.','Safe area and virtual keyboard tested with emulated insets / visualViewport; physical iOS/Android devices remain outside headless coverage.']}
(out/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:report[k] for k in ['passed','failed','pageErrors','unexpectedAdminMutations']},ensure_ascii=False,indent=2))
raise SystemExit(1 if report['failed'] or errors or paid else 0)
