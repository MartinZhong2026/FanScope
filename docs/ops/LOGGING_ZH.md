# 后端日志与排障（结构化日志）

适用于 `api/src/platform/log.mjs` 引入之后的版本。目标是：拿到一个 `request_id` 或任务 ID，就能在日志中定位是哪一步、哪个上游、什么错误码。

## 日志在哪里

| 位置 | 内容 | 保留 |
| --- | --- | --- |
| 容器 stdout（`docker logs fanscope-api`） | 全部 info 及以上的 JSON 行 | 容器被重建（发布、回滚）后**会丢失** |
| 数据卷 `logs/fanscope-YYYY-MM-DD.jsonl`（容器内为 `/app/data/logs/`） | notice/warn/error（含服务启停），**跨容器重建保留** | 按天切分，默认保留 14 天（`FANSCOPE_LOG_RETENTION_DAYS`）；单日文件上限 50 MB，超过后只写一条 `log.file_capped` |

- 生产环境（`NODE_ENV=production`）默认把文件写在数据库所在目录的 `logs/` 下；可用 `FANSCOPE_LOG_DIR` 覆盖。
- 日志**从不写入 SQLite**。发布控制器会比对启动后的数据库指纹，任何启动期写库都会触发回滚。

## 每行的固定字段

`ts, level, event, service, commit, request_id`（如有）。在此基础上，不同事件附带各自的字段，例如：

- `method, route, status, duration_ms`
- `journal_id, source, job_id, new_count`
- `error_class, error_code, status, message_redacted, upstream{provider,host,status,code,retry_after,request_id,attempts}, stack`

级别：`debug < info < notice < warn < error`。`notice` 用于服务启停。可用 `FANSCOPE_LOG_LEVEL` 调整阈值；在 `node --test` 中默认只输出 notice 及以上。

## 主要事件

| 事件 | 级别 | 含义 |
| --- | --- | --- |
| `service.start` / `service.stopping` | notice | 入口、版本、开关状态 / 收到信号及进行中的任务 |
| `http.request` | info；5xx 为 error | 每个请求一行；健康检查成功时不记录 |
| `http.client_error` / `http.error` | info / error | 4xx 预期错误 / 5xx 服务端错误（含堆栈） |
| `ingest.source_checked` / `ingest.source_failed` | info / warn | 单刊检查成功 / 失败（失败时游标已保存，下一轮续跑） |
| `ingest.scan_finished` / `ingest.scan_failed` | info 或 warn / error | 一轮扫描的汇总 / 整轮异常 |
| `ingest.monitor_cycle` / `ingest.monitor_cycle_failed` | info / error | V1.4 定时监测周期 |
| `llm.call_completed` / `llm.call_failed` | info / warn；不确定请求为 error | DeepSeek 调用的 token、耗时与错误码 |
| `worker.failed`, `ai.auto_tick_failed`, `lab.document_*`, `mail.*` | warn / error | 后台任务失败 |

## 脱敏规则（代码强制）

- **所有异常消息默认只保留长度与 SHA-256 前缀**（`message_redacted`）；`safeMessage:true` 不再允许原文透传。短 ASCII、英文私人文字与中英文 JSON 解析错误一视同仁，不尝试从文字样式推断安全性。
- 元数据采用 `platform/log.mjs` 中的明确字段/值契约：已知错误码、错误类、来源/阶段枚举、HTTP 状态、耗时和计数保留。未知字符串（包括 Error.name/code/cause.code、供应商头和嵌套值）仅保留摘要；未知字段连字段名一起摘要，避免正文被放进对象键。密码/Token 等字段只标记 credential，不保留值或指纹。
- `body/text/content/prompt/messages/abstract/manuscript/transcript/response/quote/note/summary/chat/query/evidence` 及 message/detail/reason/cause，无论字符串、对象或数组，均只留长度和哈希。调用者不得把正文塞进事件名；事件名必须是代码中的固定常量。
- 稳定 `error_code` 包括显式属性中的 `http_<状态码>`、`timeout`、`aborted`、`request_uncertain` 等及已登记的 Node/供应商码；不从任意异常正文猜码。新增码/阶段/模型须补允许值及测试，否则只显示摘要。Resend 失败不再把响应正文放入 Error，保留 HTTP 状态及可识别的供应商码。
- 堆栈只保留仓库内实际存在的 src/test 模块相对位置（文件、行、列）；函数名、eval、用户路径和原始堆栈均不输出。原堆栈仅留摘要，代价是第三方/动态代码栈需通过错误码、阶段与关联 ID 定位。
- `X-Request-Id` 仅透传 UUID；其他格式生成新的服务端 UUID，响应头、错误体和日志使用同一个值。任务/调用 UUID 和数字 ID 可保留；其他文本 ID（包括 DOI）只留摘要。供应商 UUID 可保留，其他格式请求 ID 只留摘要供关联。
- 访问日志只显示登记的静态路径段，其余替换为 `:id`，不记录 query string。未知路由可能合并显示，这是避免私人 URL 片段泄露的取舍。health 的 commit/schema/node/sqlite 可见性不变。
- stdout 与跨容器数据卷文件使用同一份已清洗 JSON；日志不写数据库。已有历史日志、CLI 人工输出及数据库中的旧错误记录不由此修复清理，不应把这些原始内容直接导出为服务日志。

## 常用命令（服务器上，只读）

```bash
# 某次请求的全部事件（浏览器开发者工具或错误响应体中的 request_id）
sudo docker logs fanscope-api 2>&1 | grep '"request_id":"<ID>"'
# 跨发布保留的告警与错误
sudo docker exec fanscope-api sh -c 'tail -n 200 /app/data/logs/fanscope-$(date -u +%F).jsonl'
# 最近的采集失败
sudo docker exec fanscope-api sh -c 'grep -h ingest.source_failed /app/data/logs/*.jsonl | tail -n 20'
# 当前运行的版本
curl -s https://fanscope-api.adapttochina.com/api/health
```

错误响应体包含 `request_id`，响应头包含 `X-Request-Id`，前端可以通过 CORS 读取该响应头。
