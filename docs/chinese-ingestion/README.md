# 中文期刊接入与独立市场分析验收

基于 main `956320e`。未访问生产数据库、Docker Volume、运行中的 DeepSeek 批次；所有数据导入和浏览器操作使用新建的 `work/*.sqlite`。未调用 DeepSeek。

## 真实原因与来源核查

[配置审计](config-audit.json)逐刊列出20本中文候选刊的 market、source、enabled、ISSN、CSSCI 标记与允许访问的官网主机。仓库默认中文刊没有已启用的自动接入；已有 `docs/journal-audit/COVERAGE-ZH.md` 记录了失效 RSS 返回 HTML、来源未核实、部分官网不可达。旧历史回填限定 Crossref，不能直接回填公开中文官网目录。这些是代码和已留存隔离审计的观察，不是对当前生产数据库的判断。

新 `/api/chinese-diagnostics` 只读检查实际运行库中的中文记录、已有 scan_windows、旧 journal_backfill_jobs、新中文任务、来源验证状态、摘要缺失及分析成功；研究报告另外按最近180天统计有效证据。累计收录数不冒充期刊全量覆盖率。

## CSSCI

已访问南京大学评价中心的[来源版官方入口](https://cssrac.nju.edu.cn/cpzx/zwshkxywsy/gndslqkml/index.html)与[扩展版官方入口](https://cssrac.nju.edu.cn/cpzx/zwshkxywsykzb/index.html)。现有公开页面没有提供可确认匹配本刊的2025—2026目录条目，不能凭候选名单、官网宣传或旧年目录声称 CSSCI 资格。入口读取记录见本目录 `cssci-official-*.txt`。

所有未取得官方年度条目的刊物保持 pending。管理审核要求2025—2026、来源版/扩展版独立选择、南京大学官方证据URL、包含刊名的原文及目录页码；审核留存原文、时间和 operator-reviewed 标记，不自动开启来源。当前没有把任何候选刊升级为已核实。

## 数据接入与边界

- 来源管理页新增中文刊名/ISSN核验、来源配置、获授权CSV、180天回填、增量任务、逐页继续及取消。验证成功与旧 enabled 开关独立展示，不悄悄启用生产扫描。
- 官网适配公开 Highwire citation 元数据文章及 `/CN/Y年份/` 目录链接、显式 rel=next 分页。不是任意网页爬虫；不执行JavaScript，不获取PDF全文，不突破登录、验证码或付费墙。仅允许配置中经审核的 HTTPS 主机，沿用DNS公网检查、地址固定、禁止重定向和请求大小限制。
- RSS沿用刊名、链接、日期核查。Crossref及OpenAlex逐页校验刊名和ISSN；OpenAlex需要服务端条款/计划授权及API配置。不下载全文。当前OpenAlex入口只接入元数据，无摘要如实缺失。
- 新任务创建即暂停。每次“继续”最多一页；页面记录与检查点在同一事务提交，失败不推进游标。重放按 DOI、链接及期刊内规范化标题去重。增量窗口从最近成功前7天重叠读取；时间窗固定并限制到今日。
- 无摘要也可收录，标记 insufficient_abstract，分析JSON为空，不伪造方法或样本。未来和不合法日期拒绝；不以发现日代替发表日。
- 趋势页始终显示两个市场切换，默认国际英文；切换清除旧市场的刊物、主题和样本单位筛选。研究查询、分母、方法、设计、来源、样本、证据和缺失率都随 market 请求独立；错误的文章/期刊 market 归属不计入。旧聚合API保留兼容，响应声明 market。

## 真实样本和测试

真实中文元数据取自[《人口研究》50卷5期第3页](https://rkyj.ruc.edu.cn/CN/Y2026/V50/I5/3)，题名《中国失能老年人口规模及老年照护劳动力需求量测算》，发表日2026-09-29、ISSN 1000-6087。只保存公开citation元数据快照，原网页哈希与读取日期见 [source-evidence.json](source-evidence.json)。无DOI或摘要的字段保持缺失。

网络抓取证据与模拟分页测试明确区分：真实网页通过curl取得元数据快照，隔离测试运行解析、导入、去重和统计；分页/错误恢复使用可控模拟传输，没有把模拟DOI当成真实论文展示。未证明全部20刊官网均可自动接入，也未声称180天全量覆盖。

- `api/test/chinese-ingestion.test.mjs`：真实元数据、授权要求、标题去重、日期/身份拒绝、失败续跑、增量重放、Crossref分页、市场分母隔离。
- [手机趋势](screenshots/390-chinese-trends.png) / [桌面趋势](screenshots/1440-chinese-trends.png) / [手机接入](screenshots/390-sources.png)：真实中文元数据，与明确标注的国际合成对照分开；4种宽度，0页面异常，0管理写请求。
- 完整CI继续执行现有API、深浅主题、Chromium/WebKit、Lab权限、中英切换和批次回归，再用独立中文数据库执行新增浏览器验收。

复现：`cd api && npm ci --ignore-scripts && npm test`。`DATABASE_PATH="$PWD/work/new-chinese.sqlite" node --experimental-sqlite api/test/chinese-browser-server.mjs`，另一个终端运行 `python scripts/chinese-browser-acceptance.py`。每轮用新数据库。浏览器CI会上传截图与JSON。

## 不部署

所有提交使用 Cloudflare 官方文档确认的 `[CF-Pages-Skip]` 前缀，跳过 Pages 部署，仍运行 GitHub CI。依据见 [官方说明](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/#skipping-a-specific-build-via-a-commit-message)及本目录 cloudflare-skip-evidence.txt。PR仅为Draft，不合并、不部署。

本地完整API回归：144项通过（[日志](api-tests.txt)）；真实中文浏览器4组通过（[结果](screenshots/results.json)）。现有移动端/WebKit布局回归92项通过；完整业务审批回归继续由GitHub CI验证。
