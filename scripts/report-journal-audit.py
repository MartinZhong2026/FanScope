"""Render the 42-journal acceptance matrix from observed evidence, never mocks.

Usage: python3 scripts/report-journal-audit.py docs/journal-audit/2026-10-25.json \
  /absolute/artifact-directory docs/journal-audit
The artifact directory is created by scripts/backfill-journals.mjs.
"""
import collections
import csv
import json
import pathlib
import sys

evidence = json.loads(pathlib.Path(sys.argv[1]).read_text())
artifacts = pathlib.Path(sys.argv[2])
output = pathlib.Path(sys.argv[3])
output.mkdir(parents=True, exist_ok=True)
results = {r['journalId']: r for r in json.loads((artifacts / 'results.json').read_text())}
stats = collections.defaultdict(lambda: {'years': collections.Counter(), 'precision': collections.Counter(), 'dates': [], 'n': 0})
for line in (artifacts / 'articles.jsonl').open():
    a = json.loads(line)
    s = stats[a['journal_id']]
    s['n'] += 1
    date = a['publication_date'] or a.get('publication_date_partial', '')
    s['years'][date[:4] or 'unknown'] += 1
    s['precision'][a['date_precision']] += 1
    if date:
        s['dates'].append(date)

official_leads = {'soc-security-cn', 'soc-review-cn', 'public-admin-cn', 'candidate-1', 'candidate-5', 'candidate-6', 'candidate-7', 'candidate-10', 'candidate-14', 'candidate-16', 'candidate-17', 'candidate-20'}
rows = []
for e in evidence:
    r = results.get(e['id'])
    s = stats[e['id']]
    if r and not r.get('error'):
        job = r['job']
        sample = e['samples'][0]
        row = {
            'Journal': e['title'], 'ID': e['id'], 'Data source': 'Crossref API（真实采集；隔离验收库）',
            'Official URL': sample.get('officialURL') or 'https://doi.org/' + sample['doi'],
            'ISSN': ', '.join(e['issns']),
            'Connectivity': '注册 API、文章 API、监测及回填实际成功',
            'Sample DOI/URL': 'https://doi.org/' + sample['doi'],
            'Historical coverage': f"{job['from_date'][:10]} → {job['to_date']}；2025={s['years']['2025']}，2026={s['years']['2026']}；月精度={s['precision']['month']}，年精度={s['precision']['year']}；来源窗口已遍历",
            'New articles': str(s['n']),
            'Monitoring status': '隔离验收同步成功；生产未操作',
            'Blocker': '尚未与出版社独立全目录交叉核齐；' + ('缺少具体发表日，当前月精度记录不能证明具体发表日' if s['precision']['month'] else 'Crossref 注册覆盖范围以外仍可能缺失'),
            'Next action': '管理员核验后启用；持续增量；与刊方目录对账',
        }
    else:
        lead = e.get('leadURL', '')
        code = e.get('httpStatus')
        if e['id'] in {'candidate-1', 'candidate-7'}:
            connectivity = 'HTTP 200，但内容为 HTML 404 错误页；非 RSS XML'
            blocker = '说明页的 XML 地址已失效；尚无有效官方 feed'
        elif e['id'] == 'candidate-10':
            connectivity = 'HTTP 200，只有 JavaScript 跳转；不是目录数据或 RSS'
            blocker = '需人工核对新的官方目录与使用许可'
        elif code == 503:
            connectivity = 'HTTP 503，上游 TLS 连接失败（已重试）'
            blocker = '刊方 TLS/出口不可用；不绕过证书或访问限制'
        else:
            connectivity = f'HTTP {code}，仅公开 HTML 线索；未验证自动元数据源'
            blocker = '没有已验证自动源或批量使用许可'
        status = '只有官方目录线索' if e['id'] in official_leads else '来源仍未确认'
        row = {
            'Journal': e['title'], 'ID': e['id'], 'Data source': status + '；暂用管理员 CSV 后备',
            'Official URL': lead if e['id'] in official_leads or e['id'] in {'candidate-4', 'candidate-19'} else '未确认（公开线索：' + lead + '）',
            'ISSN': e.get('verifiedIssn') or '本次未核实（不把旧配置或 URL 中的号码当验证）',
            'Connectivity': connectivity,
            'Sample DOI/URL': '未取得已验证可入库的文章样本；目录线索：' + lead,
            'Historical coverage': '2025-01-01 至 2026-10-25 未自动回填；缺口覆盖整个请求区间',
            'New articles': '0', 'Monitoring status': '待配置 / CSV 后备',
            'Blocker': blocker, 'Next action': '核对官方身份、有效 RSS/API、2025–2026 档案与使用许可；确认前保持停用',
        }
    rows.append(row)

assert len(rows) == 42
with (output / 'coverage.csv').open('w', encoding='utf-8-sig', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)

def cell(value):
    return str(value).replace('|', '\\|').replace('\n', ' ')

total = sum(s['n'] for s in stats.values())
month = sum(s['precision']['month'] for s in stats.values())
year = sum(s['precision']['year'] for s in stats.values())
text = f"""# FanScope 42 本期刊逐刊验收矩阵

执行日期：2026-10-25（Asia/Taipei）。实际工作树以 PR #3 最新 Head `d0a156e7dde2a59889c317883a8106c070818d75` 为基线。

以下数字来自独立、全新隔离验收库：22 本英文期刊实际采集成功，共 {total:,} 条 Crossref `journal-article` 元数据（包含该类型下的社论、书评和会议摘要，未冒称全部都是原创研究论文）。其中 {month:,} 条只给出年月，{year} 条首次发表时间只有年精度；具体发表日保留为空，`publication_date_partial` 保存原始年月，未伪造某月 1 日。当前月仅有月精度的记录不能证明在当月哪一天发表。

新增数量是本次隔离库真实新增，**不是生产新增**；生产库未访问、生产新增未统计。英文启用仅发生在隔离验收库；仓库中新增 17 本英文期刊仍默认停用，保留管理员实时核验与启用操作。

22 本英文的源内计数与采集唯一记录逐刊对账，分页/窗口已遍历不等于出版社全部历史论文已齐全。Crossref 未注册、缺少日期、尚未公开或尚未存入来源的文章仍可能遗漏；独立出版社目录对账尚未完成。20 本中文逐刊实际请求，自动收录为 0；12 本有官方目录线索，8 本未确认当前可靠自动来源，均暂留 CSV 后备。没有把 HTTP 200、HTML 页面或 Mock 测试当 RSS 成功。

| {' | '.join(rows[0])} |
| {' | '.join(['---'] * len(rows[0]))} |
"""
text += '\n'.join('| ' + ' | '.join(cell(v) for v in r.values()) + ' |' for r in rows) + '\n'
(output / 'COVERAGE-ZH.md').write_text(text)
compact = []
for e in evidence:
    r = results.get(e['id'], {})
    s = stats[e['id']]
    compact.append({'id': e['id'], 'title': e['title'], 'newArticlesIsolated': s['n'], 'years': dict(s['years']), 'precision': dict(s['precision']), 'observedFirst': min(s['dates']) if s['dates'] else None, 'observedLast': max(s['dates']) if s['dates'] else None, 'job': r.get('job'), 'error': r.get('error')})
(output / 'historical-results.json').write_text(json.dumps(compact, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'journals': len(rows), 'automated': len(results), 'records': total, 'monthPrecision': month}))
