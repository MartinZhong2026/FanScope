# FanScope 42 本期刊接入：本阶段交付

执行日：2026-10-25，Asia/Taipei。阶段范围仍是全部 42 本；本次完成英文 22 本的真实接入验收、英文来源内历史回填和中文 20 本逐刊联网调查。中文目录适配器、目录使用许可确认和独立出版社历史覆盖核验仍未完成，不能称为全部任务完成。

## 基线与环境

实际修改的工作树是 `/workspace/work/fanscope-live`，分支 `feat/journal-coverage-audit`。通过真实 `git fetch origin feat/chinese-journal-rss` 和 `git worktree add` 建立；开发前及提交前对照远端 PR #3 Head `d0a156e7dde2a59889c317883a8106c070818d75`。原 `/workspace/FanScope` 工作树未修改，没有把连接器读取的文件当 Git 基线。

默认命令沙箱第一次请求代理失败；为命令显式申请网络权限后，实测 Crossref HTTP 200、GitHub 分支读取成功，npm 安装成功。Node 24 的验收命令使用 `--use-env-proxy` 保留云环境代理与 TLS 验证。来源调查逐项保存时间、HTTP 状态、地址与原始响应；没有仅凭 unrestricted 配置声明连通。

## 实际采集与覆盖范围

- [42 本逐刊矩阵](COVERAGE-ZH.md)、[CSV](coverage.csv) 包含内部 ID、来源、URL、ISSN、联网结果、文章证据、历史范围、数量、状态、阻碍和下一步。
- [首次调查](2026-10-25.json)：22 本英文取得 Crossref 期刊注册资料及 2025–2026 文章样本；[逐 DOI 独立查询](doi-rechecks.json) 22/22 再次核对 DOI、ISSN 和刊名。
- [源内对账](reconciliation.json)：106 次历史分页响应（含重放），22/22 的去重 DOI 数量与单独时间范围查询的源内计数及隔离库收录数相等，共 18,216 条 `journal-article` 元数据。该类型包含社论、书评、会议摘要，不能把它们全部称为原创研究论文。
- [历史任务与日期精度](historical-results.json)：逐刊记录 2025、2026 数量、已枚举窗口、实际首末日期及缺失。2,738 条首次发表时间仅有年月，另 1 条只有年份，其中 Social Science & Medicine 1,904 条、The Lancet Healthy Longevity 238 条、SSM - Population Health 234 条、Health & Place 336 条；其余 26 条月精度记录分布在其他期刊。保存年月与月精度，不补写日期。当前月份的月精度记录不能证明具体哪一天发表。
- 中文 20 本均实际请求；《人口研究》《社会》的候选 XML 地址返回 HTTP 200 + HTML 404 页面，不能启用 RSS。社会学评论、公共管理与政策评论、中国行政管理遇到上游 TLS/503；社会建设主页仅返回 JavaScript 跳转。12 本有官方目录线索，8 本尚未确认当前可靠自动源，全部暂留 CSV 后备；不是认定它们永远只能手工导入。
- 只在全新隔离验收库采集。没有访问生产库，没有向既有生产数据库导入这些记录；没有修改生产环境。仓库新增英文期刊仍停用，候选 ISSN 与明确刊名别名供管理员重新实时核验启用。生产状态不得套用 [隔离库运行状态](runtime-status.json)。
- Crossref 源内枚举完成，不等于出版社独立目录核齐。尚未统计未注册 DOI、来源尚未收录、没有可判断发表时间等记录的全量缺口。中文整个 2025-01-01 至执行日区间尚未自动回填。

另在独立副本完成 22 本真实 index-date 增量扫描，见 [增量请求与游标证据](incremental-live.json)。其中近期重新索引的旧文与 2025–2026 历史快照分开统计；索引时间不代替发表日期。[日期精度重算记录](date-reconciliation.json)保存 17 条修正前后结果，依据原始来源，不影响 AI 字段。

[真实文献元数据快照](articles.jsonl.gz)为 18,216 条 JSON Lines 的 gzip 压缩文件，仅包含公开题录、来源提供的摘要及证据，不含生产数据库或私人全文。

## 代码变化

1. 明确刊名别名修复 Gerontology Series B 漏收，继续要求 ISSN 和刊名归属一致，避免 Series A 等外刊混入。
2. 保存在线/正式发表日期原始证据、年月精度、年份、卷期、ISSN、抓取时间、来源身份验证状态和缺失原因。排除明确未来发表记录，数据库收录时间不充当发表日期，Atom updated 不充当 published。
3. 历史任务支持受限页大小、窗口、重试和检查点；限制反复过期游标的重放次数。历史工作线程保留独立游标，不发送通知、不创建 AI 任务。
4. 历史任务冻结来源 ISSN；更换来源后暂停旧回填。旧版未保存来源快照的历史任务恢复时也会暂停，请管理员取消旧任务并新建，已收录记录保留。管理员更换 Crossref 来源会清除该来源旧增量游标和旧成功时间，重新完成首次扫描后才可显示健康。
5. DOI/同刊 URL 去重；重复入库不覆盖已存在的 AI 分析、缓存或旧论文。增量迁移只追加字段和证据表，不删除论文或 Lab 数据。
6. 来源管理保存实际核验尝试，显示最后检查/成功、新增数、逐刊历史任务、证据和统计。健康要求匹配当前来源的身份验证、无扫描错误及最近 24 小时的成功扫描；enabled 不等于健康。暂停操作也能使在途 Crossref 启用失效。
7. RSS 原有 HTTPS、逐刊主机白名单、DNS 公网校验及固定连接、禁止重定向、超时和体积限制继续保留。没有为了云代理修改这些安全边界。没有自动抓取尚未确认许可的 HTML 目录，没有登录、验证码、付费墙或私人全文下载。

## 可复现验收

在仓库根目录运行（云环境 Node 24、显式网络权限；输出目录必须是独立验收目录）：

```bash
node --use-env-proxy scripts/audit-journals.mjs /absolute/work/source-audit
node --use-env-proxy scripts/backfill-journals.mjs /absolute/work/acceptance-output
python3 scripts/report-journal-audit.py docs/journal-audit/2026-10-25.json /absolute/work/acceptance-output /absolute/work/report
```

回填命令拒绝已有 DATABASE_PATH 和没有专用标记的既存数据库，绝不默认打开应用数据库。重跑同一路径恢复检查点；`--replay` 显式新建已完成范围的重放任务，仅用于去重验收。生产管理员仍走现有受认证 API；此脚本不启动服务器、不启动 AI 或邮件定时器，也不加载付费 AI 队列。

Node 22/24 全套回归结果、依赖审计与浏览器记录同目录保存。93 项测试覆盖原有 Lab、AI 缓存/预算、重复迁移、2,549 条合成数据保留、监测、回填及新增加的日期/别名/来源切换/竞态测试；Mock 测试不充当联网采集证据。390px/1440px 使用隔离真实元数据库完成来源/健康/回填/列表 8 个页面检查，无页面错误或横向溢出。

[数据库检查](database-checks.json)：integrity_check=ok，AI 用量=0、AI 任务=0、邮件投递=0、通知候选=0。没有调用 DeepSeek。OpenAlex 本阶段未另行启用；有可用 Crossref 的期刊先使用已验证的开放元数据。

## 下一阶段

保持 42 本最终范围。优先重新核对中文有效 RSS XML 和官方当前目录，确认元数据使用许可，再为适合的刊方实现明确范围的目录适配器；继续保留 CSV。将英文元数据与出版社独立目录分年分期核对，特别补查月精度、摘要、文章类型及 Crossref 缺失记录；再提供经过人工核验的生产导入/回填操作。继续回归测试，Draft PR 不合并、不部署。
