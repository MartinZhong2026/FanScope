"""Read-only browser acceptance against NEW local Chinese fixtures, never production.

V1.4 replaced the inline CSV form with a separately staged local workbench.
Production closure is tested independently by chinese-release-blockers.test.mjs.
"""
import argparse
import json
import os
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

WEB = 'http://127.0.0.1:4173'
API = 'http://127.0.0.1:8787'
TITLE = '中国失能老年人口规模及老年照护劳动力需求量测算'
SOURCE = 'https://rkyj.ruc.edu.cn/CN/Y2026/V50/I5/3'
parser = argparse.ArgumentParser()
parser.add_argument('--output', default='work/chinese-browser')
args = parser.parse_args()
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
for _ in range(100):
    try:
        with urlopen(WEB, timeout=1), urlopen(API + '/api/health', timeout=1):
            break
    except OSError:
        time.sleep(.1)
else:
    raise RuntimeError('Local Chinese fixture servers did not become ready')

errors, mutations, external, checks, permissions = [], [], [], [], []
with sync_playwright() as playwright:
    options = {'headless': True}
    if os.environ.get('BROWSER_EXECUTABLE'):
        options.update(executable_path=os.environ['BROWSER_EXECUTABLE'], args=['--no-sandbox'])
    browser = playwright.chromium.launch(**options)
    api = playwright.request.new_context(base_url=API)
    def articles(market):
        response = api.get('/api/articles', params={'market': market, 'period': 'all', 'article_type': 'all', 'limit': 100})
        assert response.status == 200
        return response.json()

    before = {market: articles(market) for market in ['chinese', 'international']}
    assert before['chinese']['total'] == 1
    assert before['chinese']['items'][0]['title'] == TITLE
    assert before['chinese']['items'][0]['article_url'] == SOURCE
    assert before['international']['total'] > 0
    assert all(a['market'] == 'international' for a in before['international']['items'])

    # Deliberately DENIED requests to the isolated fixture, outside page actions.
    # Missing/wrong credentials must never mutate either corpus.
    for route in ['chinese-source', 'chinese-jobs', 'chinese-batches', 'import']:
        for headers in [{}, {'X-Admin-Key': 'synthetic-invalid-admin-key'}]:
            response = api.post('/api/admin/' + route, data={}, headers=headers)
            assert response.status == 401, (route, response.status)
            permissions.append({'route': route, 'credentials': 'wrong' if headers else 'missing', 'status': 401})
    assert {market: articles(market) for market in before} == before
    workbench = api.get(WEB + '/chinese-import.html')
    assert workbench.status == 200  # A local file is not a production permission.

    for width in [320, 390, 768, 1440]:
        context = browser.new_context(viewport={'width': width, 'height': 900}, locale='zh-CN')
        def guard(route):
            request = route.request
            url = urlparse(request.url)
            if request.method not in ['GET', 'OPTIONS']:
                mutations.append(request.url)
                route.abort()
            elif url.scheme != 'http' or url.hostname != '127.0.0.1' or url.port not in [4173, 8787]:
                external.append(request.url)
                route.abort()
            else:
                route.continue_()
        context.route('**/*', guard)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        def go(route):
            page.goto(WEB + route, wait_until='networkidle')
        def article_response(response, market, query):
            url = urlparse(response.url)
            params = parse_qs(url.query)
            return (url.path == '/api/articles' and response.status == 200
                    and params.get('market', [''])[0] == market
                    and params.get('q', [''])[0] == query)
        def search(query):
            market = parse_qs(urlparse(page.url).query)['market'][0]
            with page.expect_response(lambda response: article_response(response, market, query)):
                page.locator('#q-search').fill(query)
                page.locator('#apply-search').click()
            page.wait_for_load_state('networkidle')
        def switch_market(market, query=''):
            with page.expect_response(lambda response: article_response(response, market, query)):
                page.locator(f'[data-market={market}]:visible').first.click()
            page.wait_for_load_state('networkidle')
        def titles():
            return page.locator('a.article-title, a.paper-title')
        def overflow():
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')

        go('/?page=trends&market=chinese&period=180d')
        expect(page.locator('.cn-diagnostics')).to_have_count(1)
        expect(page.locator('.cn-diagnostics')).to_contain_text('2025—2026')
        expect(page.locator('body')).to_contain_text('有效样本 n=1 / 1')
        overflow()
        page.screenshot(path=str(out / f'{width}-chinese-trends.png'), animations='disabled')
        page.locator('[data-market=international]:visible').first.click()
        page.wait_for_load_state('networkidle')
        expect(page.locator('.cn-diagnostics')).to_have_count(0)
        assert 'market=international' in page.url

        go('/?page=feed&market=chinese&period=all')
        expect(titles()).to_have_count(1)
        expect(titles().first).to_have_text(TITLE)
        expect(page.locator('body')).to_contain_text('人口研究')
        source = page.locator(f'a[href="{SOURCE}"]').first
        expect(source).to_have_attribute('target', '_blank')
        assert 'noopener' in source.get_attribute('rel')
        overflow()
        page.screenshot(path=str(out / f'{width}-chinese-list.png'), animations='disabled')
        search('失能老年人口')
        expect(titles()).to_have_count(1)
        expect(titles().first).to_have_text(TITLE)
        search('no-match-chinese-ci-acceptance')
        expect(titles()).to_have_count(0)
        search('')
        expect(titles()).to_have_count(1)
        switch_market('international')
        expect(titles().first).to_be_visible()
        expect(titles().filter(has_text=TITLE)).to_have_count(0)
        search('失能老年人口')
        expect(titles()).to_have_count(0)
        search('Caregiving')
        expect(titles().first).to_be_visible()
        switch_market('chinese', 'Caregiving')
        expect(titles()).to_have_count(0)
        search('')
        expect(titles()).to_have_count(1)

        go('/?page=sources')
        expect(page.locator('[data-cn-source]')).to_have_count(1)
        # LOCAL workbench link, rather than the retired inline import form.
        expect(page.locator('.cn-diagnostics a[href="chinese-import.html"]')).to_have_count(1)
        expect(page.locator('form[data-cn-import]')).to_have_count(0)
        overflow()
        page.screenshot(path=str(out / f'{width}-sources.png'), animations='disabled')
        checks.append({'width': width, 'listing': True, 'source': True, 'search': True,
                       'marketIsolation': True, 'localWorkbench': True, 'passed': True})
        context.close()
    assert {market: articles(market) for market in before} == before
    api.dispose()
    browser.close()

assert not errors and not mutations and not external, (errors, mutations, external)
result = {'checks': checks, 'permissionChecks': permissions, 'errors': errors,
          'mutations': mutations, 'externalRequests': external, 'corporaUnchanged': True}
(out / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'passed': len(checks), 'deniedPermissions': len(permissions),
                  'errors': errors, 'mutations': mutations, 'externalRequests': external}))
