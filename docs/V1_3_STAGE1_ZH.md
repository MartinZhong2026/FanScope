# FanScope v1.3 · 第一阶段 / 数据与 AI 持久化基础

> 基线：2026-10-24 用户提供的 `FanScope-903f37e8a8ab95cebb2825dffede170f45d9deed.zip`。包含完整 `api/`、`web/`、`deploy/` 和已有测试。**本包不是部署后的线上版本；不要将 ZIP 文件直接提交到 GitHub 作为普通附件。**

## 这一阶段真实完成的内容

1. **AI 批量任务持久化**：SQLite `analysis_batches` / `analysis_batch_items`。管理员主动创建、启动、暂停、取消；后台每 10 秒顺序处理少量论文；服务重启自动将中断的 `running` 任务标为待执行。默认不自动开始新的付费 AI 分析。
2. **分析缓存与论文级指纹**：基于题名和前 7,000 字符摘要计算 SHA-256。原有 v1.2 已完成结果在启动迁移时自动补指纹；之后同内容直接跳过，摘要改变才重分析。历史论文原有数据不删除。
3. **Token 与预计人民币成本记录**：新增 `analysis_usage_log`。若未配置经过核验的单价，只记录 Token，不显示虚构人民币费用。配置输入/输出每百万 Token 单价后，可创建带预算上限的批次；预算保护按高估输入/最大输出预留，实际价格与供应商账单仍可能有差异。
4. **期刊 Crossref 安全试接入**：`/api/admin/journal-source/test` 试查 ISSN；校验实际 `journal-article`、DOI、ISSN 和期刊标题；`.../activate` 必须显式 `confirm:true`。验证通过后写入 SQLite source/issn/enabled，重启不清除这些字段。
5. **基础信息面板**：公开只读 `/api/analysis-coverage`、`/api/journal-source-status`；前端「监测健康状态」增加真实 AI 解析覆盖率，原有 API 无此端点时忽略并保留旧界面。
6. **兼容旧 v1.2**：不删除原表，不修改 Lab 权限和会议功能，不替换登录、不变更 Docker 数据卷。不包含生产密钥、不包含真实论文数据库。

## 尚未完成（后续 Continue）

- 17 本英文候选、20 本中文期刊逐本核实与数据源接入；官方中文期刊页面适配；2025–2026 大范围回填任务管理；JCR/CSSCI 证据核对。
- 深色 Night Mode，全站 Design System，首页/论文/项目/登录 UI 重排，ECharts / Observable Plot 丰富的分析图形。
- 成员余额充值、支付/退款；多模型精度实验；管理员 Web 表单和完整的批处理操作面板；PDF 全文证据提取。
- 目前本地实现是**轻量 SQLite 持久化任务队列**，未部署 Trigger.dev。不存在“服务器断电后立即恢复正在执行的 HTTP 请求”的保证，异常重试可能产生个别重复 API 用量。

## 先备份再升级（腾讯云服务器）

```bash
cd ~/fanscope
# 不要上传 .env/SQLite 到 GitHub；不要运行 docker compose down -v
# 必须确认以前的离线备份仍存在，再对当前生产库做最新备份。
find "$HOME/fanscope-private-backups" -type f -name '*.sqlite' -ls | tail
# 在 GitHub 仓库用新文件完成提交，并审查 CI；在服务器上：
git pull --ff-only origin main
sudo docker compose -f deploy/docker-compose.yml build fanscope-api
# 仅在离线副本迁移试验通过后：
sudo docker compose -f deploy/docker-compose.yml up -d --no-deps fanscope-api
sudo docker compose -f deploy/docker-compose.yml ps
curl -fsS https://fanscope-api.adapttochina.com/api/health
curl -fsS https://fanscope-api.adapttochina.com/api/analysis-coverage
```

建议将这次部署的生产 SQLite 再做一次 `VACUUM INTO` 一致性备份，连同 Lab 文档和 `.env` 存在 GitHub 外，**不能仅依赖应用内建的旧备份**。参照 `docs/OPERATIONS_V1_2.md`。迁移后核对 `articles`、`lab_users`、`lab_projects`、`lab_manuscripts` 的数量，检查 `PRAGMA integrity_check`。**在生产环境未确认无误前，不要批量花费 API 额度。**

## 管理员在服务器执行第一批 100 篇

`api/.env` 配置：

```dotenv
AUTO_AI_ANALYSIS=false
MAX_AI_DAILY=20
# 可按经费批准和服务能力逐步调高，比如 100，但先试运行。
# 以下为人民币 / 100 万 tokens，需根据自己实际模型、时段和账单填写；不得直接照抄一个未核验价格。
AI_INPUT_CNY_PER_M_TOKENS=
AI_OUTPUT_CNY_PER_M_TOKENS=
```

**先不要写预算就可以创建任务（完全不会调用 DeepSeek），但要使用“¥30 硬预算”选项，必须先配置并核实上述两项计费参数。**

```bash
cd ~/fanscope
# 创建任务后默认 PAUSED，零 API 花费；可以根据需要加 --budget=30
a="sudo docker compose -f deploy/docker-compose.yml exec -T fanscope-api node --experimental-sqlite src/analysis-cli.mjs"
$a coverage
$a create --from=2025 --to=2026 --limit=100
$a list
# 从上一步输出复制 UUID：
$a start <BATCH_UUID>
$a status <BATCH_UUID>
$a pause <BATCH_UUID>
$a cancel <BATCH_UUID>
```

`MAX_AI_DAILY` 是**全站每日尝试次数限制**，不是每批次数限制。默认一天最多尝试 20 篇；批次可持续多日。`MAX_AI_PER_SCAN` 仍控制旧的单次手动短任务。**仅在 `AUTO_AI_ANALYSIS=true` 时才恢复 v1.2 那种无任务的定时全库自动分析**；不要与研究经费模式同时启用。

### 供前端或自动化工具使用的管理员 HTTP API

携带 `X-Admin-Key`：

- `POST /api/admin/analysis-batches` JSON `{"yearFrom":2025,"yearTo":2026,"limit":100,"journalId":""}`，如配置了币种价格才可以添加 `"costLimitCny":30`。
- `GET /api/admin/analysis-batches` 列表；`GET /api/admin/analysis-batches/<UUID>` 进度、累计 token、估算费用。
- `POST /api/admin/analysis-batches/<UUID>/start`、`/pause`、`/cancel`。
- `POST /api/admin/journal-source/test` JSON `{"id":"candidate-25","issn":"具体已核验ISSN"}`；
- `POST /api/admin/journal-source/activate` 同上加 `"confirm":true`，仍由系统实际验证论文 DOI + ISSN + 期刊名；失败不会修改期刊配置。

密钥只能保存在后端/临时安全管理员环境，不要把管理员密钥永久放在公开的 JS、浏览器 localStorage 或 GitHub 中。

## 重要注意

- 当前的中文候选期刊依旧是 `manual` 或空 RSS 的 `enabled:false`，**不会因为这次升级而自动接通**；未验证的 Q1/CSSCI 等级也不变。
- AI 抽取仍受摘要不足、证据门槛和模型准确性限制。旧文章显示 `unknown` 不是 UI Bug，不能为了好看生成不存在的数值。
- 计费记录来自 API 返回的 Token usage；实际账单、缓存输入优惠、失败请求收费以供应商为准。
- 新版 API 才有 `/api/analysis-coverage`，请按**前后端兼容**顺序升级，不要只更新 Cloudflare 前端而跳过后端。

## 测试记录

- `node --check`：改动的 Node/浏览器 JavaScript 文件语法检查通过。
- `node --experimental-sqlite --test test/analysis-batches-v13.test.mjs test/journal-onboarding-v13.test.mjs`：4 项新测试通过。
- `node --experimental-sqlite --test test/analysis-batches-v13.test.mjs test/journal-onboarding-v13.test.mjs test/crossref-v12.test.mjs test/monitor-scan.test.mjs test/openalex-v12.test.mjs test/brief-v12.test.mjs`：17 项离线测试通过。
- `npm test` 全套回归**未完成**：当前文件容器没有安装 `exceljs`，`npm ci` 因外部 npm 包不可用无法完成；旧版 ZIP 基线也因此有 7 个测试文件加载失败，与新增逻辑无关。GitHub Actions 在依赖正常安装后必须再跑一遍完整测试，未通过不可生产升级。
