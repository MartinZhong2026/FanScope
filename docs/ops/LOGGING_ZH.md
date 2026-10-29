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
- `error_class, error_code, status, message, upstream{host,status,retry_after,request_id,attempts}, stack`

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

- 键名包含 password/secret/token/api_key/authorization/cookie/admin_key/session 的值替换为 `[REDACTED]`。
- `body/text/content/prompt/messages/abstract/manuscript/transcript/response/quote/note/summary/chat/query/evidence` 等正文字段只保留长度和哈希前缀。
- **异常消息采用白名单**：只有不含引号、括号和非 ASCII 字符、长度不超过 160 的简短诊断（如 `HTTP 429`、`DeepSeek request_uncertain`），或代码显式标记 `safeMessage:true` 的消息，才会原样记录；其他消息只记录长度与哈希（`message_redacted`）。原因：V8 的 JSON 解析错误会原样引用输入文本，邮件供应商的错误会回显响应正文。
- 常见失败会自动派生 `error_code`：`http_<状态码>`、`timeout`、`aborted`。`upstream` 只保留 provider/host/status/retry_after/request_id/attempts 六个字段。
- 字符串中的 Bearer 令牌、`sk-` 密钥、URL 中的 key/token/mailto 参数会被替换，邮箱会被掩码；超长字符串会被截断。
- 新增代码**不得**把提示词、稿件、摘要正文或供应商原始响应作为普通字符串字段写入日志。

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
