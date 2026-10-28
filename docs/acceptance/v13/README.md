# FanScope v1.3 PR #2 上线前验收报告

验收日期：2026-10-25（Asia/Taipei）。[PR #2](https://github.com/MartinZhong2003/FanScope/pull/2)，工作分支 `feat/fanscope-v1.3-stage4-journal-discovery`，基线 `main@13e7d6c`，原始 PR 提交 `e0fc706`。

**结论：建议进入隔离 staging，尚不具备直接生产上线的验收证据。** 已发现的 P0/P1 已修复并回归；真实生产库副本迁移、真实凭证/账单、生产规模长时间任务等仍需人工验收。PR 保持 Draft，不合并、不部署。

本次没有登录腾讯云、连接生产 SQLite、调用真实 DeepSeek、删除 Docker volume，或提交真实密钥、用户资料、私有 PDF、`.env`。浏览器及 AI 测试仅使用合成资料和 Mock。Crossref 为只读公开元数据查询。

## 1. 测试与结果

| 验证 | 通过 | 失败 | 范围 / 证据 |
|---|---:|---:|---|
| 原始 PR 完整 npm test | 55 | 0 | 依赖干净安装后建立基线；已有测试通过不代表没有遗漏缺陷 |
| 最终 Node.js 22.23.4 完整 npm test | 70 | 0 | [日志](final-node22-tests.txt)，含迁移、Lab、队列、邮件隔离、CSV、分页、重启 |
| 最终 Node.js 24.19.0 完整 npm test | 70 | 0 | [日志](final-node24-tests.txt)，同一套测试的第二个运行时，不是另外 70 个独立用例 |
| 420MB Docker 定向回归 | 14 | 0 | [日志](docker-420mb-tests.txt)，AI/回填/权限/CSV/Lab 文件导入；容器禁止外网 |
| Playwright 浏览器 | 54 | 0 | [完整结果](browser-results.json)，390×844、768×1000、1440×1000 |
| Crossref 在线来源核验 | 5 | 0 | [来源响应摘要](crossref-live-results.json) |
| Crossref 在线 DOI 独立回查 | 5 | 0 | [DOI 回查](crossref-doi-results.json) |
| 合成库迁移两次及旧代码重开 | 通过 | 0 | [迁移记录](migration-results.json)、[回滚兼容记录](rollback-results.json) |

依赖使用 `npm ci --ignore-scripts` 安装成功；[完整依赖审计](final-audit.json)与[生产依赖审计](final-audit-production.json)均为 **0 个已知漏洞**。敏感文件/密钥模式检查通过，`git diff --check` 通过。ECharts 浏览器文件与锁定的 npm 6.1.0 分发文件逐字节一致。弃用依赖警告仍存在，不等于 npm audit 漏洞。

浏览器没有未捕获 JavaScript 异常；10 条控制台网络诊断均来自故意触发的错误状态：3 次错误登录 401、1 次拒绝启用来源 409、2 次旧 API 404、4 次断网请求失败。正常流程没有额外控制台错误。[截图索引](SCREENSHOTS.md)包含 **44 张 PNG**。

## 2. 修复与提交

| 等级 | 问题与修复 | 提交 |
|---|---|---|
| P0 | AI 断网、失败或无效 JSON 可能已经收费，却没有进入预算账本。现在请求前持久化费用预留；有真实 usage 时更新实际 Token 估算，无响应时保留 `uncertain` 记录和保守预留。 | `43dcb3b20bfea8658f5e7587005f809cffb75f3a` |
| P0 | 已运行任务重启后缺少模型价格，worker 仍可能继续调用。现在每次付费前检查有限、正数的模型价格与批次预算，缺失则暂停；拒绝负数、Infinity、NaN。 | `43dcb3b` |
| P1 | 最终失败项没有明确的重新排队入口。新增失败项 retry API 和按钮，重试先回到暂停状态，需管理员再次启动，保留已有费用记录。 | `43dcb3b` |
| P1 | 回填中途暂停/取消不阻止后续页，完成或异常路径可能覆盖取消；多页 tick 中途崩溃会丢失累计计数。现在在页边界检查状态，逐页事务保存论文及计数，保留取消状态。 | `43dcb3b` |
| P1 | 缺失/不前进的游标在失败前增加 processed，多次重试可能错误完成。现在合法推进后才提交 processed，并补充重复失败回归。 | `43dcb3b` |
| P1 | Health & Place 的 `&amp;` 名称被误判；ISSN 无校验位检查、DOI 只检查前缀、回填可能接收明确属于其他期刊的元数据。增加实体归一化、ISSN 校验位、完整 DOI 语法检查、矛盾来源过滤及出版社证据输出。 | `43dcb3b` |
| P1 | 实际提供给浏览器的 ECharts 6.0.0 存在 GHSA-fgmj-fm8m-jvvx 公告。升级依赖、lockfile 和 vendored 浏览器文件到 6.1.0。未宣称已经证明存在可利用的站内攻击链。 | `43dcb3b` |
| P1 | PR 覆盖掉 v1.2 的 Markdown/TXT 导入及 `?view=` 深链接。恢复前后端格式支持、UTF-8/大小/扩展名校验、文件名错误处理和深链接/浏览器历史。 | `5951cd1f4d77142b3f3d02d9b7e8355f33424a78` |
| P2 | 登录失败清空邮箱、Lab 深色统计卡片/弹窗白底、跟随系统时图表未重新配色、外部字体请求失败、非 ASCII 错误管理员密钥导致 500。均已修复。 | `43dcb3b` |
| 风险缓解 | 迁移及研究统计改为逐行遍历，研究统计不再批量加载全部摘要；批次候选摘要限制为分析所需范围。不能据此宣称任意规模都满足 420MB。 | `43dcb3b` |

旧 PR 的新增故障回归日志见 [original-regression-tests.txt](original-regression-tests.txt)。前序失败可能影响后续状态，因此没有把其中失败数当作独立缺陷数量。最终回归以当前代码的完整测试结果为准。

## 3. 数据库迁移与回滚

夹具由 `main@13e7d6c` 的真实 v1.2 建表代码生成，加入完全合成的代表性记录；不是读取或脱敏生产数据库。

| 表 | v1.2 迁移前 | v1.3 连续迁移两次后 |
|---|---:|---:|
| articles | 120 | 120 |
| journals | 43 | 43 |
| lab_users | 3 | 3 |
| lab_projects | 2 | 2 |
| lab_manuscripts | 2 | 2 |
| analysis_batches | 不存在 | 0 |
| analysis_batch_items | 不存在 | 0 |
| analysis_usage_log | 不存在 | 0 |
| journal_backfill_jobs | 不存在 | 0 |
| journal_discovery_jobs | 不存在 | 0 |

43 本期刊包括配置中的 42 本和 1 本自定义测试期刊。原有表的全部原始字段逐项比较一致，包含 DOI、摘要、AI JSON、摘要结果、用户密码哈希、项目和稿件状态。40 篇已分析论文保持 analyzed 并获得输入指纹；没有把历史结果批量标记为待分析。刻意修改的期刊 enabled、source、ISSN、checkpoint 及自定义期刊在两次重启后均保留。

`PRAGMA integrity_check = ok`，`PRAGMA foreign_key_check` 为 0 条违规。额外在合成迁移库副本上重新启动 v1.2 的 Lab 建表模块，原始记录仍不变、完整性仍为 ok；这只是数据库打开兼容性，不等于生产回滚演练。

**真实生产数据库副本迁移尚待用户在腾讯云执行。** v1.3 不会为已经标记 v1.2 的数据库自动生成 pre-v1.3 备份。上线前应使用 SQLite Backup API 或现有 `api/src/backup.mjs` 的 `VACUUM INTO` 创建一致性快照，不能仅复制正在写入的主 `.sqlite` 文件而忽略 WAL。

生产回滚预案：先暂停/停止 v1.3 写入及工作队列，保存升级后的数据库和账本，再选择经过核验的升级前一致性快照及 v1.2 镜像。恢复前明确处理升级后新增记录的导出/补录，核对主要表数量和完整性。保留 Docker 数据卷，禁止 `down -v`。v1.2 不理解 v1.3 的队列和预算保护；回滚验证时移除付费 Key，并设置 `SCAN_ON_START=false`、`MAX_AI_PER_SCAN=0`，不要依赖旧版本不认识的开关来阻止消费。

## 4. 真实期刊来源

本次共进行 15 次只读 Crossref 请求：5 次初步元数据采样、5 次通过应用来源验证逻辑的在线探测、5 次 DOI 独立回查。没有真实查询 OpenAlex，也没有抓取付费全文。

| 期刊 | 本次核验 ISSN | 示例 DOI | Crossref 出版社 | 结果 |
|---|---|---|---|---|
| The Gerontologist | 1758-5341；另采样 0016-9013 | 10.1093/geront/gns034 | Oxford University Press (OUP) | 在线通过 |
| Innovation in Aging | 2399-5300 | 10.1093/geroni/igad104.3014 | Oxford University Press (OUP) | 在线通过 |
| BMC Geriatrics | 1471-2318 | 10.1186/1471-2318-10-s1-a62 | Springer Science and Business Media LLC | 在线通过 |
| Health & Place | 1353-8292 | 10.1016/j.healthplace.2015.08.003 | Elsevier BV | 在线通过；原始名称为 `Health &amp; Place`，已修复实体匹配 |
| Journal of Social Policy | 0047-2794 | 10.1017/s0047279400021875 | Cambridge University Press (CUP) | 在线通过 |

DOI 回查中的 DOI 和 ISSN 五组全部相符。来源身份已获得真实公开证据，但样本可能包含会议摘要、书评、卷期前后页等 Crossref 标为 journal-article 的内容；不等于完整原始研究覆盖、2025–2026 全量覆盖或学术分区已验证。

The Gerontologist 的 enabled 来自既有基线配置；在线核验没有执行来源激活；Mock 单元测试只在可丢弃夹具内演练了管理员手动激活路径。其余四本候选保持未启用，没有修改配置文件或生产期刊状态。其余 17 本英文及 20 本中文本次未逐本在线核验；它们的队列/错误分支测试为 Mock，不能据此启用来源。

错误 ISSN、空或含空白 DOI、跨期刊、重复 DOI、无效响应、超时、断网、429/5xx 重试均有离线回归。浏览器中的来源测试故意使用不匹配 Mock，验证激活被 409 拒绝。

## 5. 回填、AI、预算和幂等

历史任务创建默认为暂停。自动测试走完 **2025-01-01 至 2026 当前截止时间** 的全部固定窗口，覆盖分页、重复 DOI、窗口连续性、最终完成；另以新进程验证保存游标后继续、AI 中断恢复及来源调查恢复。暂停/取消发生于在途请求时，在当前页提交后停止后续抓取；已发出的只读请求不会被追溯撤回。回填不改日常 checkpoint/scan_windows，不生成今日论文通知，不调用 DeepSeek。

100 篇论文批次创建、启动、暂停、继续、取消、失败重试、缓存复用和摘要变化均通过。重复批次正常完成时不重复付费解析；输入指纹覆盖标题及前 7000 字符摘要，输入有效范围变化时重新分析。

Mock 单价为输入 ¥1/百万 Token、输出 ¥4/百万 Token。100 次成功请求得到输入 90,000、输出 22,000 Token，估算合计 **¥0.178**。每次请求保守预留 20,000 输入和 1,800 输出 Token 对应费用；断网/缺失 usage 保留预留，负 Token 数不形成负费用。未配置有效单价不能启动有费用的批次，也不能声称存在严格人民币保护。预算不足阻止下一次调用，重启后单价缺失使任务暂停。

`AUTO_AI_ANALYSIS=false` 且配置了 Mock Key 的实际监测回归没有调用 AI。已由管理员启动的批次，以及用户明确上传并请求分析的 Lab 文档，属于已经授权的任务，不会因该开关而被取消。

**限制：** 本地金额是配置单价下的估算/保守预留，不能替代 DeepSeek 账单。不确定请求的 Token 数为未知，日志 `status=uncertain`，不能把占位的 0 Token 理解为实际零消耗。服务端已处理但客户端丢失响应时，重试不能保证提供商侧恰好扣费一次；预算预留仍计入限制。当前采用单容器进程 worker，未验证多实例并发。论文批次人民币预算也不是整个 DeepSeek 账户的总预算：Lab 文档和简报仍有各自原有的次数限制。

## 6. 浏览器、安全和兼容性

三种宽度均验证：首页六入口、手机底部导航、深色/浅色/跟随系统、系统切换后 ECharts 配色、论文列表与摘要证据展开、趋势图、期刊画像/健康/来源管理、AI/回填中心、登录错误与成功、项目弹窗及提交、Lab 深链接和 Markdown 上传。没有页面级横向溢出或新增阻断性遮挡。手机 Lab 顶部导航本身可横向滚动；论文的站内详情为证据展开，原文通过 DOI/出版社链接打开，不存在另一个未实现的站内详情页。

14 次管理员请求经过浏览器实际调用 API（包含认证 GET、创建/启动/暂停/取消、来源验证/拒绝激活、调查队列及 CSV）。管理员密钥仅在 prompt/请求内临时使用，没有写入 localStorage/sessionStorage；Lab 登录 token 的 sessionStorage 是另一个既有认证机制。

`/api/admin/*` 在路由分派前统一验证管理员密钥；错误/缺失/非 ASCII 错误密钥回归均拒绝。SQL 输入使用参数绑定；恶意 SQL 字符串不会执行。导入的 HTML 标签在浏览器按文本渲染，未触发脚本。PDF/DOCX/Markdown/TXT 验证扩展名与 MIME，文本使用严格 UTF-8、512KB 限制，PDF/DOCX 保留 10MB 与提取超时限制；错误输入不调用 AI。原始文件下载和审批权限沿用并通过现有测试。

CSV 支持 BOM/CRLF/引号，每批最多 50 篇、请求/文件约 150KB；标题 350、作者 600、摘要 12000 字符上限；检查已登记中文期刊、URL/DOI/日期格式并按 DOI 或稳定 URL ID 去重。不下载任意 CSV 链接、不自动启用期刊，也不自动分析/通知。**文章归属与来源真实性仍需管理员人工核对，URL 格式合格不等于已经在线证明来源。**

新前端连接旧 API 的来源页面显示升级提示，主页面仍可用；新操作 API 在旧后端不存在，不能宣称 v1.2 已实现 v1.3 的操作能力。staging 应成套发布和验收前后端版本。

本地基于仓库 `node:22-bookworm-slim` Dockerfile 构建成功。[420MB 短时记录](docker-soak.json)为 1000 篇 Mock 分析、40 轮缓存批次、约 123 秒，最高进程 RSS 108,277,760 字节（约 103MiB），完整性 ok，无 OOM。SQLite 为 Node 原生模块。**没有验证数小时/数天、真实生产体量、长文档并行解析或磁盘满时的行为。**

## 7. 生产人工验收与 staging 建议

进入隔离 staging：建议。使用测试数据库、Mock AI、独立通知接收器和当前固定提交，不将合成资料混入生产。当前没有基于已执行测试仍未修复的 P0/P1；下列缺失证据仍是生产放行门槛：

- 用户在腾讯云生成真实生产 SQLite 的一致性副本，并在隔离路径执行迁移两次、逐表计数/关键字段比对、完整性/外键校验、真实规模耗时和备份恢复。
- 核对真实模型及单价、每日限额、未知请求对账规则、暂停/取消在途调用语义；任何真实付费调用均需用户另行授权，本次未做。
- 按真实生产体量观察 420MB 内存、CPU、WAL/磁盘增长、并发文档任务和跨天恢复；完成可回滚演练，保留数据卷。
- 管理员逐本确认来源并明确激活；另外 37 本期刊本次没有逐本在线证据。中文 CSV 的期刊/文章归属需人工审查。
- 核验腾讯云反向代理、HTTPS/CORS、实际浏览器、邮件通知隔离与学校文献访问；本次未登录生产、未发真实订阅邮件、未登录出版社或校内系统。

GitHub Actions 将由本分支 Push 触发，远端最终状态以 [PR Checks](https://github.com/MartinZhong2003/FanScope/pull/2/checks) 为准；本地通过不能代替远端 CI。PR 必须继续保持 Draft，不合并、不部署。

## 8. 复现入口

```sh
cd api
npm ci --ignore-scripts
npm test
npm audit
npm audit --omit=dev
cd ..
node scripts/check-sensitive.mjs
git diff --check
```

浏览器需要 Playwright 和 Chromium。先设置一个全新的 `DATABASE_PATH`，启动 `api/test/browser-v13-server.mjs`，再运行 `scripts/browser-v13.mjs`。服务仅监听本机 4173/8787，测试脚本强制使用 Mock 出站 API。可通过 `PLAYWRIGHT_MODULE` 指定已安装 Playwright 模块、`BROWSER_EXECUTABLE` 指定浏览器、`QA_ARTIFACTS` 指定产物目录；脚本遇到失败返回非零。

`scripts/docker-v13-soak.mjs` 用于本地隔离 Docker 检查，数据库固定在容器 `/tmp`，应搭配 `--network=none --memory=420m --memory-swap=420m` 和只读脚本挂载运行，不能挂载生产数据库或数据卷。

完整截图见 [SCREENSHOTS.md](SCREENSHOTS.md)。原始测试结果、Crossref 证据、审计结果及截图 SHA-256 见 [manifest.json](manifest.json) 与本目录文件。
