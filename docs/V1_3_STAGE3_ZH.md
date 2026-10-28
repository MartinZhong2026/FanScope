# FanScope v1.3 Stage 3 · 任务中心、历史回填与中文目录导入

## 目标与变更边界

保留 Stage 1 持久化 AI 批次、Stage 2 夜间主题与来源验证页面；本阶段新增人工操作的历史回填、管理员网页控制台与中文目录 CSV 导入。维持原 Node.js 22 + SQLite + Cloudflare Pages + Docker 架构，不引入 Redis、PostgreSQL 或付费第三方任务平台。未改变原有 Lab 用户、稿件和会议数据结构。

### 期刊接入真实状态

包中期刊候选数仍为 42（5 本已启用英文 Crossref、17 本未配置英文候选、20 本中文候选），不能宣称 42 本实时接通。管理员只能在 `期刊来源管理` 页面通过现有 `/api/admin/journal-source/test` 核验少量 Crossref 样本，再手动确认启用。`/api/journal-backfill-status` 只是进度，不是期刊连续监测的健康证明。

## 新 API

- `GET /api/journal-backfill-status`：只读任务进度和元信息，无 ADMIN_KEY。
- `POST /api/admin/journal-backfills`：创建暂停状态的历史回填任务；body `{ "journalId":"ageing-society", "yearFrom":2025, "yearTo":2026 }`；需要 `X-Admin-Key`。
- `GET /api/admin/journal-backfills/:id`：读取特定任务。
- `POST /api/admin/journal-backfills/:id/start|pause|cancel`：启动、暂停或取消。
- 第一阶段原有 `GET/POST /api/admin/analysis-batches` 与 `POST /api/admin/analysis-batches/:id/start|pause|cancel` 继续使用。
- 第一阶段原有 `GET /api/analysis-coverage` 继续使用。
- 原有 `POST /api/admin/import` 支持管理员人工导入中文期刊文章（最多 50 条），本阶段提供浏览器 CSV 预览入口，后端新增原文 URL 和日历日期校验。

所有更改后端数据的接口继续执行管理员密钥校验。前端仅通过 `prompt()` 临时获取密钥，每次请求完成后不保存 localStorage/Cookie。

## 历史回填工作机制

- 任务只允许**已启用、配置 ISSN 且来源为 Crossref 的期刊**；仅创建不执行，管理员必须显式启动。
- 提供按年份创建的日期范围，最多 3 个年度、不得超过本年；终点按当前 UTC 时间截断，避免将未来视为历史。
- `journal_backfill_jobs` 单独记录固定时间范围、七日扫描窗口、Crossref 游标、已处理数、页数、错误、已入库论文数。
- 每轮 Worker 严格处理最多 2 页，使用 Crossref 公开元数据，不调用 DeepSeek，不发送「今天新增」通知；下一轮从上次完成页的检查点续跑。
- 若 HTTP 请求/游标/来源失败，任务暂停并保留错误；管理员核查后继续。已存在 DOI 的论文通过 `INSERT OR IGNORE` 去重。
- 现有日常监测继续使用独立的 `scan_windows`，不会被历史回填覆盖；Stage 3 对其分页行为保持兼容。
- Worker 默认每 15 秒轮询运行中任务。禁止通过多容器共享同一 SQLite volume 的方式水平扩展；当前部署按单 Worker 设计。

## DeepSeek AI 解析与经费

任务创建后默认暂停且无 API 成本。启动 AI 分析必须配置 `DEEPSEEK_API_KEY`、`AI_INPUT_CNY_PER_M_TOKENS`、`AI_OUTPUT_CNY_PER_M_TOKENS`，并在批次中设置人民币费用上限。单价必须取自实际 API 账单/合同；不允许填猜测数值以谎称严格成本限制。

- 前端创建表单支持年份、期刊、最多 1000 篇、成本上限；缓存已解析结果。
- 执行中每次记录输入/输出 Token，费用只是据配置单价估算，账单与缓存优惠可能存在差异。
- 保留原先 `MAX_AI_DAILY` 限制，若限制为 20 则任务一天最多运行 20 次尝试；如需更多须先获得预算批准。
- `AUTO_AI_ANALYSIS=false` 应维持默认，不要让新文章自动产生 DeepSeek 费用。

## 中文 CSV 导入

UTF-8 CSV 表头格式参见 `examples/chinese-journal-import-template.csv`：

`journal_id,title,url,authors,abstract,publication_date,doi`

必填 `journal_id`（已存在中文期刊 ID）、`title`（真实文章标题）、`url`（真实文章级链接）。可选作者、摘要、严格 `YYYY-MM-DD` 日期和 DOI；日期与 DOI 必须来自可靠来源，未知则留空。CSV 引号、逗号和换行可正确解析；单次最多 50 行。文件仅在点击「管理员确认导入」并通过权限检查后发往服务器。

CSV 录入不等于自动监测，期刊仍会显示「待配置」，直到真实自动来源经过验证。不得用未授权付费数据库接口绕过访问限制。

## 本地测试和上线前验收

```sh
cd api
npm ci
npm test
```

本轮在缺少 npm 依赖的隔离环境，运行了 `node --experimental-sqlite --test` 的定向测试：覆盖历史回填暂停/恢复、独立检查点、Crossref 旧版兼容、Stage 1 解析缓存/预算、前端接口静态契约。

**未验收**：所有历史端到端用例、在线 Crossref 真实连续采集、Cloudflare 真实预览及部署、生产环境 AI 预算与人民币价格准确性。浏览器截图测试被当前运行环境网络导航安全策略拦截，没有把既有 Stage 2 截图充当 Stage 3 验收。

### 生产部署前必须检查

1. `git log -1 --oneline` 确认实际要部署的 commit；不要在未验证 CI 的情况下直接 `docker compose up`。
2. 将 `fanscope.sqlite` 使用 `VACUUM INTO` 备份到 Docker volume 之外；备份所有授权文件与 `api/.env`，备份目录权限限制到管理员。
3. 在独立数据库副本和新镜像上运行迁移并检查 `PRAGMA integrity_check`、文章总量、Lab 用户、项目、稿件总数。
4. 新容器健康后分别检查 `/api/health`、`/api/research`、`/api/analysis-coverage`、`/api/journal-backfill-status` 的 HTTP 200 和合理返回结构。
5. 首先创建暂停的回填任务，检查是否无自动采集/AI 花费，再手动对一本文献量小的英文期刊开启回填，验证进度与去重。不得同时启动大量历史回填任务冲击 Crossref。
6. 确保 17 本英文、20 本中文尚未接通的数据源依然标记待配置。
7. 不要使用 `docker compose down -v`，不清空 `fanscope_data`。不把 `.env`、生产 SQLite、授权 PDF 上传 GitHub。

## 下一阶段可继续

- 逐本验证新增 17 本英文候选期刊 ISSN 和官方数据样本，核实后逐步启用。
- 中文 C 刊官方目录、合法 RSS/开放元数据等真实来源适配；CSV 仍可作为回退通道。
- 更复杂的科研可视化（热力矩阵、研究方法与数据来源的统计覆盖率、可下钻图表）；AI 报告结果缓存。
- 多课题组的预算/授权管理、正式支付及更严谨的计费审计。
