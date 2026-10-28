# 发布后后台任务与写入能力恢复方案

2026-10-28。以0d38926为基线；本轮仅本地开发和断网、合成数据测试，没有生产部署、生产库写入或重启。此前A–C验证针对的是0d38926，**不自动覆盖本轮新增试验入口**。新入口需另行审查、提交、构建并在实际生产备份副本重新验证；现有发布包未修改。

## 已核实的实现与风险

| 功能 | 0d38926现状 | 恢复约束 |
|---|---|---|
| 英文定时监测 | 普通入口按SCAN_INTERVAL_MINUTES注册scanAll，默认120分钟、最短30分钟；SCAN_ON_START=false只关闭启动后第一次扫描，不关闭定时器。scanAll默认扫描全部已启用市场，Crossref与RSS使用原有游标、检查点和去重。 | 先只允许英文、已有检查点且没有未完成历史窗口的期刊；核对唯一运行实例、来源和限速。缺检查点或backfill窗口的期刊留待人工审核。 |
| 历史回填 | journal_backfill_jobs持久保存状态、页游标，workBackfillTick会自动处理状态running的任务。source discovery也会恢复历史任务。 | 默认不注册回填和发现worker；逐任务检查日期、来源、游标、许可及运行状态后另行批准，不能一键恢复。 |
| AI论文队列 | recoverBatches将不确定请求标记failed/request_uncertain，但不会将原本running的批次全部暂停；workBatchTick会继续处理该批次的其他queued项。预算接口setBatchBudget是兼容空操作，不提供实际批次支出上限。 | 不自动恢复队列；先核对provider账单和uncertain记录，审查并隔离原running任务。要正式启用还需持久预算、单实例/领取约束和可审计的单批次显式启动。不可自动重试不确定请求。 |
| 邮件与订阅 | urgentDispatch按subscriber/article/kind查已发送记录，发送后才写deliveries；digest发送后才更新last_daily/last_weekly。网络或进程中断可能导致已发送但未记录，重试重复发送；digest部分失败后调度标记也可能抑制同日重试。 | 保持邮件凭据为空，先补持久发件意图、确定性幂等键、发送结果及不确定状态的对账流程；不能只凭本地sent标记保证恰好一次。 |
| Lab登录与文档 | 登录校验现有密码并写lab_sessions；登录限制为进程内计数。普通入口recoverDocumentJobs会恢复pending文档，文档处理可能调用DeepSeek。 | 可单独恢复登录/登出/密码修改；文档上传及其恢复worker保持关闭。生产安全评审应覆盖暴力破解、限流、会话、跨域和权限，不能把现有限流描述成跨实例持久防护。 |
| 中文管理 | production对/api/admin/chinese-*及旧/api/admin/import硬404。 | 继续关闭；不启用授权导入工作台或中文批量回填。 |

Resend支持发送请求的Idempotency-Key，供应商保存24小时，并要求同一键配合同一请求内容；超出窗口或状态不明须先对账，不能当成永久恰好一次保证。[Resend官方说明](https://www.resend.com/changelog/idempotency-keys)

## 本轮本地候选与验证

新增`api/src/staged-recovery-server.mjs`作为独立试验入口，复用现有API、监测函数和数据库结构；没有修改原0d38926发布入口或接入引擎。它要求显式FANSCOPE_STAGED_RECOVERY=true、已有非空数据库、有效管理员配置、空DeepSeek/Resend/OpenAlex Key和有效监测间隔，否则在导入应用前失败。没有默认启动扫描，也不恢复文档、发现、历史回填或AI worker。

试验入口的HTTP能力：GET读取、已有订阅确认链接及退订、Lab登录/登出/密码修改；其他写操作503。中文管理仍由生产硬404处理。新订阅请求、邮件发送、论文分析、手动扫描/回填、Lab文档上传和其他Lab写入**尚不可用**。仅当FANSCOPE_ENGLISH_MONITOR=true时，每个监测周期顺序扫描符合条件的英文期刊；缺检查点或存在未完成backfill窗口的期刊跳过，默认不在启动时扫描。不能仅凭enabled计数声称全部已监测。

断网Docker、合成SQLite及模拟Crossref/DeepSeek/Resend验证：

1. 现有定向测试30项通过：监测去重、回填断点、AI不确定请求、普通邮件去重、Lab身份和任务恢复。
2. 新入口测试覆盖Lab登录、中文写入404、危险写入503及可信来源CORS；仅扫描符合条件的英文期刊、跳过中文和历史窗口；模拟Crossref重复扫描不重复入库；启动不恢复历史AI任务；付费Key或缺数据库时失败。
3. 故障注入显示：不确定AI条目未自动重试，但原running批次继续执行其他一条模拟请求；模拟邮件已被服务商接受而本地记录失败时，两次调用产生两次模拟发送。正常写入sent记录后重复调用被去重。均为合成数据，无真实外部调用。

可复测命令（本机Docker Desktop，确认不是远程Docker）：

```powershell
Set-Location C:\Users\martin\Documents\FanScope-Dev
$WorkspaceRoot=(Get-Location).Path
docker run --rm --network none --memory 1g --user 0:0 --env NODE_ENV=test `
  --mount "type=bind,source=$WorkspaceRoot/api/src/staged-recovery-server.mjs,target=/app/src/staged-recovery-server.mjs,readonly" `
  --mount "type=bind,source=$WorkspaceRoot/api/test/staged-recovery.test.mjs,target=/app/test/staged-recovery.test.mjs,readonly" `
  --entrypoint sh fanscope-api:release-0d3892608c3d07b9c9cbcb03eb07896418cbbd66 `
  -c 'node --experimental-sqlite --test test/staged-recovery.test.mjs'
docker run --rm --network none --memory 420m --cpus 1 --user 0:0 --env FANSCOPE_ISOLATED_SIMULATION=yes `
  --mount "type=bind,source=$WorkspaceRoot/scripts/recovery-simulation.mjs,target=/case/recovery-simulation.mjs,readonly" `
  --entrypoint sh fanscope-api:release-0d3892608c3d07b9c9cbcb03eb07896418cbbd66 `
  -c 'ln -s /app /api && node --experimental-sqlite /case/recovery-simulation.mjs'
```

测试仅连接容器内模拟服务，备份及349条真实中文记录不参与。试验入口不属于本地提交0d38926，不应部署现有镜像并期待它存在。

## 生产恢复顺序（方案，当前未执行）

### 0. 冻结证据、盘点与准入

在维护窗口前记录版本/旧镜像、Pages回滚点、最新已验证恢复点及数据增量风险；确认只有一个FanScope进程可以写该SQLite，不影响其他服务。先只读获取监测检查点、任务状态与不确定用量的聚合数；核对已有订阅者数量及发送账本。不要输出.env、用户邮箱、原文、AI内容或密钥。以下是以后经现有授权连接运行的只读盘点命令，不创建备份、不导入应用：

```bash
sudo -n docker exec -i fanscope-api node --experimental-sqlite --input-type=module <<'NODE'
import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
const f=process.env.DATABASE_PATH;if(!f||!fs.existsSync(f)||!fs.existsSync(f+'-wal')||!fs.existsSync(f+'-shm'))throw Error('数据库或既有WAL/SHM不可核实，停止');
const d=new DatabaseSync(f,{readOnly:true});d.exec('BEGIN');
try{
 const names=new Set(d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
 for(const [table,col] of [['analysis_batches','status'],['analysis_batch_items','status'],['analysis_usage_log','status'],['journal_backfill_jobs','status'],['journal_discovery_jobs','status'],['lab_documents','extract_status'],['deliveries','status']]){
  if(!names.has(table)){console.log(JSON.stringify({table,missing:true}));continue;}
  const cols=new Set(d.prepare(`PRAGMA table_info("${table}")`).all().map(x=>x.name));
  if(!cols.has(col))throw Error('实际库结构与计划不同，停止');
  console.log(JSON.stringify({table,counts:d.prepare(`SELECT "${col}" status,COUNT(*) n FROM "${table}" GROUP BY "${col}"`).all()}));
 }
 if(names.has('scan_windows'))console.log(JSON.stringify({table:'scan_windows',counts:d.prepare('SELECT mode,status,COUNT(*) n FROM scan_windows GROUP BY mode,status').all()}));
 if(names.has('journals'))console.log(JSON.stringify({table:'journals',counts:d.prepare("SELECT market,enabled,CASE WHEN coalesce(checkpoint,'')='' THEN 'missing' ELSE 'present' END checkpoint,COUNT(*) n FROM journals GROUP BY market,enabled,CASE WHEN coalesce(checkpoint,'')='' THEN 'missing' ELSE 'present' END").all()}));
 if(names.has('subscribers'))console.log(JSON.stringify({table:'subscribers',counts:d.prepare('SELECT confirmed,COUNT(*) n FROM subscribers GROUP BY confirmed').all()}));
}finally{d.exec('ROLLBACK');d.close();}
NODE
```

缺表/列、WAL条件不满足、运行实例不唯一或盘点结果与预期不符时停下，先审查，不修改旧状态。已知备份快照是2026-10-28 02:43:46 UTC；如果实际恢复至该点，随后数据必须另行处理。

### 1. 先恢复交互与身份

审查并固定新候选提交/镜像，对真实备份的**新隔离副本**重复结构升级、保护摘要、旧镜像恢复和桌面/手机验收。明确批准后才可发布：使用staged-recovery-server.mjs，NODE_ENV=production、FANSCOPE_STAGED_RECOVERY=true、FANSCOPE_ENGLISH_MONITOR=false，DEEPSEEK_API_KEY、RESEND_API_KEY、OPENALEX_API_KEY均为空；保留原有DATABASE_PATH、ADMIN_KEY及允许的前端Origin配置，不打印值。禁止改回原server.mjs主入口。

确认健康、只读英文/中文统计、Lab现有用户登录/登出、原账户权限，以及订阅确认/退订；中文管理404，其他写入口503。此阶段无法新订阅发验证邮件，不能宣称订阅发送已恢复。会话创建/密码修改是有意允许的写入，必须在本人授权的维护窗口进行。

### 2. 恢复英文增量监测

逐刊核对enabled、市场、ISSN/RSS、checkpoint及scan_windows，特别是缺检查点和未完成backfill窗口。确认允许公开接口访问、单实例及监测/日志告警后，单独批准将FANSCOPE_ENGLISH_MONITOR设为true并按审核过的Compose重启新候选。仍须空AI/邮件Key；首次监测在配置周期之后，未主动执行启动扫描。监测只会对符合条件的英文期刊执行scanAll({journalId})，不读取中文任务队列，也不会发送邮件。核查成功/partial次数、数据来源、重复率及监测负载。

停邮期间产生的紧急通知不会自动补发；某些增量论文可能仍满足未来日报窗口，开启邮件前必须审查通知资格和时间范围，避免遗漏或补发洪峰。若某刊无检查点，不能手工伪造检查点来强行恢复。

### 3. 按需恢复历史回填与AI

现有试验入口不开放相关写接口，也不注册这些worker。开发前先审计所有running/queued/paused任务、checkpoints、analyzing条目和usage_log uncertain条目；基于冻结时间和provider账单核对，不自动将状态重置为queued，不盲目运行recoverBatches，也不调用现有retry批量重试。对未知计费逐项人工决定；数据库状态更改需单独授权、事务及审计。

最小后续改动应提供分开的回填/AI开关：默认全关；启动时对历史running任务拒绝自动运行，按明确批准的任务ID恢复；只接受已核验英文来源及明确日期区间；AI由持久的单批次请求数/金额上限、单实例领取、异常暂停、供应商账单核对与可审计操作控制。现有预算列没有执行限制，不能把它当成保护。单批次用模拟供应商覆盖超时、进程在请求前/后中断、重启和两个worker竞争；超额/不确定状态必须停止而非重放。完成代码与独立验收后，才以最小权限在服务器由本人配置真实Key；不要在命令行、聊天、Git或日志中暴露Key。

### 4. 按需恢复邮件和新订阅

先补持久发件意图和唯一业务键，发送前提交受保护的待发送记录与不可变内容/哈希，传Resend确定性Idempotency-Key；记录provider响应ID、发送结果和unknown状态。urgent聚合邮件、日报/周报和订阅验证各自要有稳定事件身份，重试必须保持同一请求体；超出24小时或请求结果不确定，先在供应商侧核对，再人工决定。处理部分失败、崩溃点、并发、重复请求和跨进程重启；不可自动全量补发。

由本人在供应商侧验证发件域、额度与可用权限，确认发件地址、HTTPS回调、受控测试收件人和最小权限Key；生产健康接口之前显示emailConfigured=false，不代表权限已就绪。代码在本地模拟测试通过、隔离副本回放和用户批准后，先对受控收件人发一封并核对ledger/provider ID，再逐步开放新订阅、urgent及digest。不要通过聊天传真实邮箱或Key。

### 5. 监测与回滚条件

任一阶段出现旧队列意外开始、未知AI请求/费用、邮件重复或unknown积压、数据库保护摘要不符、中文采集意外执行、异常高负载或接口不健康，暂停该阶段并阻止继续发送。对于试验入口，先停止调度和外发，等待当前监测请求完成并记录检查点，再按另次明确批准切回已审核的0d38926 HTTP-only镜像与原Compose持久卷；不要直接恢复普通入口及其worker。完成迁移兼容演练并获得批准后，必要时可按[发布执行单回滚](release-0d38926.md)使用旧镜像；保留现库和历史记录。不得覆盖生产SQLite、删除卷或静默丢弃快照后产生的记录。

任何试验入口的更新和生产恢复均需独立的候选版本、真实副本验收与本人正式批准；本报告不授权这些动作。
