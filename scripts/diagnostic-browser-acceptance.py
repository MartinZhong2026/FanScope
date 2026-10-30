"""Paper Diagnostic end-to-end browser acceptance on isolated localhost fixtures.

Drives the real pages: Lab login -> diagnostic page -> upload a DOCX -> consent ->
diagnose (rule engine, no AI) -> read report -> share -> delete. Also checks that
another member cannot see the manuscript, that no external request is made and
that the page runs under the Pages CSP without violations.
"""
import argparse, io, json, os, time, zipfile
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

p = argparse.ArgumentParser(); p.add_argument('--output', required=True); a = p.parse_args()
out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
WEB = 'http://127.0.0.1:' + os.environ.get('DX_WEB_PORT', '4173')
PASSWORD = 'Diagnostic-acceptance-only'
for _ in range(100):
    try:
        with urlopen(WEB, timeout=1) as r:
            if r.status == 200: break
    except OSError: time.sleep(.1)
else: raise RuntimeError('Diagnostic fixture server did not become ready')

PARAGRAPHS = ['农村养老金与老年人心理健康（隔离验收合成稿件）',
    '摘要：本文旨在考察新型农村社会养老保险对农村老年人心理健康的影响。',
    '理论框架：本文基于生命历程理论与社会支持理论构建分析框架。',
    '数据来源：本文使用CHARLS 2018年调查数据，样本量为6532名60岁及以上农村老年人。',
    '研究方法：采用OLS回归模型，并控制年龄、性别、教育和健康状况。',
    '结果显示，领取养老金的老年人抑郁得分显著更低，回归系数为-0.42。',
    '这一结果说明养老金导致了老年人抑郁水平下降。',
    '结论：本文认为应进一步提高基础养老金水平。']
def docx(paragraphs):
    body = ''.join(f'<w:p><w:r><w:t>{t}</w:t></w:r></w:p>' for t in paragraphs)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr('word/document.xml', f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>')
    return buf.getvalue()
manuscript = out / 'synthetic-manuscript.docx'; manuscript.write_bytes(docx(PARAGRAPHS))

errors, external, csp = [], [], []
checks = []
def check(name, ok):
    checks.append({'check': name, 'ok': bool(ok)})
    if not ok: raise AssertionError(name)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    def session(email, width=1440):
        ctx = browser.new_context(viewport={'width': width, 'height': 1000 if width > 820 else 844}, is_mobile=width <= 820, has_touch=width <= 820)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: csp.append(m.text) if 'Content Security Policy' in m.text else None)
        page.on('request', lambda r: external.append(r.url) if urlparse(r.url).hostname not in ('127.0.0.1', 'localhost') else None)
        page.goto(WEB + '/lab/')
        page.fill('#login-form input[name=email]', email); page.fill('#login-form input[name=password]', PASSWORD)
        page.click('#login-form [type=submit]')
        page.wait_for_selector('a[href="/lab/diagnostic.html"]')
        page.click('a[href="/lab/diagnostic.html"]')
        page.wait_for_selector('h1:has-text("论文诊断")')
        return ctx, page

    # The lab_admin designates the group's single trusted mentor in the UI.
    actx, admin = session('admin@dx.test')
    admin.click('details.dx-share summary'); admin.select_option('#dx-mentor', label='验收导师'); admin.click('[data-mentor]')
    expect(admin.locator('details.dx-share')).to_contain_text('当前：验收导师')
    actx.close()

    ctx, page = session('student@dx.test')
    check('mentor visibility disclosed before upload', '验收导师' in page.locator('.dx-visibility').inner_text())
    page.set_input_files('#dx-file', str(manuscript))
    page.click('#dx-upload [type=submit]')
    expect(page.locator('.dx-consent')).to_be_visible(timeout=30000)
    check('consent required before any diagnosis', page.locator('[data-run]').count() == 0)
    check('consent names the engine and retention', '14' in page.locator('.dx-consent').inner_text() and '90' in page.locator('.dx-consent').inner_text())
    check('consent text states the mentor can read it', '验收导师' in page.locator('.dx-consent').inner_text())
    page.click('[data-consent]')
    expect(page.locator('.notice.error')).to_contain_text('勾选')
    page.check('#dx-consent-check'); page.click('[data-consent]')
    page.click('[data-run]')
    expect(page.locator('.dx-report')).to_be_visible(timeout=60000)
    report = page.locator('.dx-report').inner_text()
    check('report separates manuscript facts from judgments', '稿件事实' in report and '判断' in report)
    check('rule engine is labelled as demo, not AI', page.locator('.dx-banner.demo').count() == 1)
    check('facts carry verbatim manuscript quotes', page.locator('.dx-facts .dx-quote').count() >= 4)
    check('causal over-claim flagged with evidence', '因果表述' in report and '养老金导致了老年人抑郁水平下降' in report)
    check('issues ordered by severity', page.locator('.dx-issue').count() >= 1)
    page.screenshot(path=str(out / 'report-desktop.png'), full_page=True)

    # Designated mentor reads it; another mentor account does not.
    mctx0, mentor = session('mentor@dx.test')
    mentor.wait_for_selector('.dx-row'); mentor.click('.dx-row')
    expect(mentor.locator('.dx-report')).to_be_visible(timeout=15000)
    check('designated mentor cannot delete or re-run', mentor.locator('[data-delete]').count() == 0 and mentor.locator('[data-run]').count() == 0)
    m2ctx, mentor2 = session('mentor2@dx.test')
    check('non-designated mentor account sees nothing', mentor2.locator('.dx-row').count() == 0)
    m2ctx.close(); mctx0.close()

    # Peer cannot see it before sharing.
    pctx, peer = session('peer@dx.test')
    check('other member sees no foreign manuscript', peer.locator('.dx-row').count() == 0)
    # Share with the peer.
    page.click('.dx-share summary'); page.select_option('#dx-share-user', label='验收同学'); page.click('[data-share]')
    expect(page.locator('.dx-shared')).to_contain_text('验收同学')
    peer.reload(); peer.wait_for_selector('.dx-row'); peer.click('.dx-row')
    expect(peer.locator('.dx-report')).to_be_visible(timeout=15000)
    check('shared member reads report but cannot delete or run', peer.locator('[data-delete]').count() == 0 and peer.locator('[data-run]').count() == 0)

    # Mobile layout of the same report.
    mctx = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, storage_state=ctx.storage_state())
    mobile = mctx.new_page(); mobile.on('pageerror', lambda e: errors.append(str(e)))
    mobile.goto(WEB + '/lab/'); token = page.evaluate("sessionStorage.getItem('fanscope_lab_token')")
    mobile.evaluate(f"sessionStorage.setItem('fanscope_lab_token', {json.dumps(token)})")
    mobile.goto(WEB + '/lab/diagnostic.html'); mobile.wait_for_selector('.dx-row'); mobile.click('.dx-row')
    expect(mobile.locator('.dx-report')).to_be_visible(timeout=15000)
    check('no horizontal overflow at 390px', mobile.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
    mobile.screenshot(path=str(out / 'report-mobile.png'), full_page=True)

    # Owner deletes; the peer loses access immediately.
    page.once('dialog', lambda d: d.accept())
    page.click('[data-delete]')
    expect(page.locator('.notice')).to_contain_text('已删除')
    check('deleted manuscript leaves history', page.locator('.dx-row').count() == 0)
    peer.reload(); peer.wait_for_selector('h2:has-text("我的诊断记录")')
    check('shared member loses access after deletion', peer.locator('.dx-row').count() == 0)
    browser.close()

check('no page errors', not errors)
check('no CSP violations', not csp)
check('no external requests', not external)
(out / 'result.json').write_text(json.dumps({'checks': checks, 'errors': errors, 'csp': csp, 'external': external}, ensure_ascii=False, indent=2))
print(json.dumps({'diagnosticBrowser': 'PASS', 'checks': len(checks)}))
