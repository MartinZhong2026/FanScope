# FanScope V1.3 Phase 1：中文期刊批量回填本地验收

2026-10-26，基于 `f51b087`，分支 `feat/chinese-journal-bulk-backfill`。本次没有访问 GitHub、腾讯云生产数据库或生产 API，没有部署，没有调用真实 DeepSeek。原有 `work/local-preview.mjs` 和 `.vscode/` 已备份并保持原样。

**最终独立数据库有 349 条有效中文期刊论文元数据，来自 3 本期刊。原有 20 本加上原配置缺少的《中国社会科学》《管理世界》，实际核查 22 本；四本重点刊本轮 0/4 接入。** 这不是 22 本期刊的全量覆盖，也不是 349 篇已核实年度 CSSCI 身份或已完成 AI 分析的论文。

原始范围内取得 352 条书目记录；审计剔除 3 条《社会》年度总目录，排除证据仍在 SQLite `meta` 的 `cn-excluded:*` 和 [record-audit.json](record-audit.json)。另有一篇真实工作坊综述未提供作者，保持缺失，不补造作者或研究类型。

| 期刊 | 180 天入库 | 三年范围最终有效数 | 相对180天追加 | 实际发表时间范围 | 来源 |
|---|---:|---:|---:|---|---|
| 人口研究 | 24 | 148 | 124 | 2023-11-29—2026-09-29 | [刊方目录](https://rkyj.ruc.edu.cn/CN/1000-6087/home.shtml) |
| 社会 | 24 | 143 | 119 | 2023-10-28—2026-09-18 | [刊方目录](https://www.society.shu.edu.cn/CN/1004-8804/home.shtml) |
| 公共管理评论 | 12 | 58 | 46 | 2024-12—2026-06，月份精度 | [Crossref精确ISSN接口](https://api.crossref.org/journals/2096-7713/works)、[刊方身份页](https://www.sciopen.com/journal/2096-7713) |
| 合计 | **60** | **349** | **289** | **2023-10-28—2026-09-29** | |

三年请求窗口为 2023-10-27—2026-10-26（1096天）。只读目录估计的同年份文章链接上界为《人口研究》192条、22个卷期目录，《社会》178条、21个卷期目录；Crossref 为58条。前两者的上界含边界年份中早于请求起日的文章，不能当成预计有效入库量。

三年实际枚举428条：76条在日期范围外，范围内352条，另排除3条总目录，最终349条。180天窗口为2026-04-30—2026-10-26：发现83条，23条早于窗口，60条通过验证并入库，首次去重0条。上述“发现”是本次来源枚举量，不是完整刊物出版总数。

| 最终质量项 | 数值 |
|---|---:|
| DOI | 58/349，16.62% |
| 作者 | 348/349，99.71% |
| 已知发表日期 | 349/349，100% |
| 精确到天 / 月 | 291 / 58，精确日占83.38% |
| 已保留真实摘要 | 0/349 |
| 来源身份已核验 | 349/349；不等于CSSCI年度身份已核验 |
| AI分析成功 / AI结果JSON | 0 / 0 |
| 最近30 / 90 / 180天 | 8 / 23 / 60；180天含12条月份精度记录 |
| 最近180天精确日计数 | 48；页面另行说明月份精度，不伪造具体日期 |
| 英文市场记录 / 市场归属冲突 | 0 / 0 |
| 重复组合身份 / 外键问题 | 0 / 0 |
| SQLite完整性 | ok |

《公共管理评论》的58条题名和作者保持 Crossref 提供的英文形式；刊方确认出版语言是中文、ISSN为2096-7713。没有自行生成中文原题。官网只提取citation书目事实；Crossref的摘要可能受版权限制，本批没有将其复制进论文库。摘要为零不是AI失败，也不应把题名关键词分类当作方法分析。来源更新时刻、在线日期、首次入库、元数据获取时间分列保存，源未提供的值保持空。

**复跑证据：** 完整网络第二次遍历419页、424次有预算请求，新增0、原始书目去重352、补充58条提供方更新时间，3本可用来源均完成，来源页失败0。之后按最终“排除总目录”规则重放相同真实元数据导出，349条去重、3条排除、0新增、0更新，数据库保持349条。见 [network-replay.json](network-replay.json) 与 [validated-replay.json](validated-replay.json)。批次状态 `partial` 表示另19本未具备来源条件，不表示这3本仍有未处理页面。首轮曾有两本官网各1次页面级中断，恢复后完成，日志保留。

**四本重点刊的阻碍：**

| 期刊 | 本次核查结论 | 下一步需要 |
|---|---|---|
| 中国社会科学 | 官方刊物介绍可读，但没有已核验的批量元数据接口与使用授权；精确ISSN Crossref/OpenAlex无近期来源覆盖。未抓取网站全文 | 杂志社授权的目录/元数据接口或图书馆许可范围内的CSV |
| 社会学研究 | 官网首页有2026年目录，文章页要求JavaScript验证；OpenAlex来源截止2021年，近三年0条 | 刊方授权目录导出；不绕过网页验证 |
| 管理世界 | ISSN与主办机构可核对；官网连接超时，精确ISSN开放接口未覆盖近期论文 | 刊方接口或有批量导出权限的机构CSV |
| 公共管理学报 | ISSN/CN有机构证据；官网返回无效TOKEN，OpenAlex截止2020年，近三年0条 | 正式元数据授权或刊方CSV；不借用账号、令牌 |

其余各刊的ISSN、CN、主办机构、身份证据、公开接口实际数量、最后覆盖年份、访问错误和未核字段见 [source-quality.csv](source-quality.csv)、[source-probe.json](source-probe.json)、[acceptance.json](acceptance.json) 以及 [身份证据配置](../../api/config/chinese-identity-evidence.json)。无法核实的官网仍标为候选，不作采集入口。特别是《中国软科学》南大历史记录的ISSN为1002-9753，当前候选站页脚却写1005-0566，已作为身份冲突停止，未强行合并。

CSSCI 2025—2026来源版/扩展版与元数据接入分开审核。[南京大学年度入口](https://cssrac.nju.edu.cn/cpzx/zwshkxywsy/gndslqkml/index.html)本次未取得逐刊可审核的年度原文条目，系统未自动升级任何刊物。中国人民大学有《社会建设》2025—2026入选来源期刊的[官方声明](https://news.ruc.edu.cn/1959817134478696450.html)，另行保留，仍等待年度目录原文审核。排名名单不授予数据采集权。

## 本地文件与浏览器

- 主库：[fanscope-chinese.sqlite](../../work/chinese-bulk/fanscope-chinese.sqlite)
- 一致性备份：[fanscope-chinese-backup.sqlite](../../work/chinese-bulk/final/fanscope-chinese-backup.sqlite)
- 完整有效元数据：[records.json](../../work/chinese-bulk/final/records.json)，不含摘要或全文。
- 原始请求日志、检查点、批次报告与历次备份位于 `work/chinese-bulk/`；这些本地数据文件不进入Git。
- 工件路径、SHA-256和版本记录见 [artifacts.json](artifacts.json)。

VS Code → 终端 → 新建终端：

```powershell
cd C:\Users\martin\Documents\FanScope-Dev
node scripts/chinese-local-preview.mjs
```

浏览器打开 **http://127.0.0.1:4174/?page=feed&market=chinese&period=all**。API为127.0.0.1:8788。使用独立端口，保留此前4173/8787的本地服务。预览只允许读取，固定连接本机库，关闭外部API和后台工作任务；`Ctrl+C`停止。页面可搜索、按期刊/时间/主题筛选并点击公开来源链接。

## 可复现命令

Node要求>=22.13；本机Node24.21.0、npm11.19.0。依赖已安装，PowerShell可直接使用`npm.cmd`，不用改执行策略。以下均在仓库根目录执行，只能写入`work/`中的独立数据库，发现`api/.env`会拒绝启动，以免误读服务凭据。

```powershell
# 先只读探测全部22本，估计官方目录候选链接上界，不打开SQLite
node scripts/chinese-bulk-backfill.mjs probe --days 180 --estimate --output work/chinese-bulk/next-180 --requests 180 --system-network

# 在同一范围和当天的完整探测报告基础上回填；每本失败独立记录
node scripts/chinese-bulk-backfill.mjs run --days 180 --output work/chinese-bulk/next-180 --requests 250 --steps 250 --system-network

# 扩展三年时，probe和run同时改用 --days 1096，并使用新output目录
# 365天也可用；三年建议 --requests 900 --steps 850

# 从输出last-batch.json中取batchId，恢复已暂停/失败批次
node scripts/chinese-bulk-backfill.mjs resume --batch <batchId> --days 180 --output work/chinese-bulk/next-180 --requests 250 --steps 1000 --system-network

# 后续批量增量可给run追加 --incremental（从上次成功前7天重叠查询）

# 排除目录/公告并保留隔离审计记录，再生成独立只读最终验收
node scripts/chinese-bulk-backfill.mjs audit --output work/chinese-bulk/final
node scripts/chinese-corpus-report.mjs
```

请求并发上限为每次命令1个，间隔至少1200ms，最多重试2次，指数退避并遵守Retry-After；预算统计包含重试。长退避期限持久化，不能提前继续。分页、队列、固定日期窗与数据提交同事务保存；过期Crossref游标最多重置2次、同窗重放去重。批次Ctrl+C会在本页完成后暂停；强制终止遗留的`.bulk.lock`须先核对PID确已退出，再处理锁文件。

当前网络使用合成DNS代理地址，普通服务端DNS防护会拒绝它。`--system-network`仅是本地操作员对两家固定、已审查官网及固定目录/文章路径的HTTPS通道；保留TLS证书校验、禁止重定向、响应体限制和元数据身份匹配，不对Web API开放，也不放宽原RSS的DNS防护。没有绕过验证码、登录、反爬或付费墙。

## 验证与后续接入

后端全量153项通过，包含新批量、回滚、去重、精度、市场隔离、退避与原业务回归；npm生产依赖审计0漏洞。Windows测试使用电脑现有Git目录内的`unzip`和`pdftotext`，并修复测试中URL/路径兼容问题，没有开发会议或项目管理功能。

```powershell
$env:PATH = 'C:\Program Files\Git\usr\bin;C:\Program Files\Git\mingw64\bin;' + $env:PATH
cd api
npm.cmd test
```

桌面1440px及390px各完成实际数据库浏览器验收：搜索、指定期刊、30天+照护主题组合筛选（各3条）、独立英文市场空集、无整页横向溢出、真实文章链接打开、0页面异常、0写请求。见 [浏览器结果](screenshots/results.json)、[桌面筛选](screenshots/1440-date-topic-filter.png)、[390px筛选](screenshots/390-date-topic-filter.png)、[桌面趋势](screenshots/1440-real-trends.png)、[390px趋势](screenshots/390-real-trends.png)。原站打开验证只放行文章HTML文档，附属资源由测试策略阻止；未将离线快照当作联网打开结果。

保存检查点时的待办：后来增加的“来源管理卡片恰好显示3个真实元数据已收录标签”断言未通过，尚未定位；上述结果JSON是已通过的核心浏览器流程，不包含该新增断言。按用户2026-10-26的最新指示暂停代码完善，本轮不继续修复，不将整个扩展浏览器脚本声称为通过。

本机Playwright仅安装在`work/python-playwright`，复验使用：

```powershell
$env:PYTHONPATH = 'C:\Users\martin\Documents\FanScope-Dev\work\python-playwright'
python scripts/chinese-bulk-browser-acceptance.py
```

扩展优先争取四本重点刊的正式书目接口或CSV，并要求精确刊号、原题、作者、发表日期/精度、卷期、DOI和可核查URL，确认机构许可允许批量导出。使用现有中文来源管理中的获授权CSV入口，网页每次最多50条，后端分页上限300条，继续走`importChinese`；不是另建采集引擎。身份模糊或同题名而作者不足的记录留待人工复核。OpenAlex免费API Key可解锁后续游标，但不能补齐其本来就缺失的近期中文覆盖。每增加一刊，先补身份、权限、CSSCI年度证据，再做只读数量探测、样本核验、隔离回填和官方目录对账，最后才考虑定时增量。本阶段停止在期刊数据接入与本地验收，不开展其他模块。
