# DeepSeek JSON 分析修复

20 次输出都达到旧上限 1800 token，与输出截断相符；仅凭旧日志的 `invalid JSON` 无法确定每次的结束原因。请求现显式禁用 thinking，输出上限改为 4096，保留 JSON object 模式，提示词提供完整 JSON 示例。证据原文匹配、置信度下限 0.7、样本数与单位等验证规则保持不变。

每次实际请求预先创建一条费用记录，并原位更新 token 用量和估算费用；不额外添加费用行。缺失用量时保留 20000 输入 / 4096 输出 token 的保守估算；实际费用以提供商账单为准。新增 `finish_reason`、`response_length`（响应 content 的 JavaScript 字符串长度）、`error_code`，不保存响应原文、论文内容或凭据到错误日志。

- `length`：提供商报告截断，即使内容恰好能解析，也按失败处理。
- `empty_content`：内容缺失、null、空串或纯空白。
- `invalid_json`：JSON 解析失败，或顶层不是对象。
- `unexpected_finish_reason`：明确返回了除 stop / length 外的结束原因。
- HTTP 429 / 5xx：指数退避，单轮最多五次实际请求；其余 HTTP 错误不自动重试。
- `request_uncertain`：网络中断或重启前请求已预留，可能已计费，禁止自动重放。

解析类错误和不确定请求标为 `failed`，没有自动重试时间，不计入分析成功。跨 worker 的论文认领与费用预留在同一 SQLite 事务中完成；已有成功且输入未变化的结果继续复用。重启恢复不会重发未提交结果的已预留请求。

人工重试仍需管理员明确操作：暂停批次，选择重试失败项，再单独启动。重试只重置失败项，保留已完成结果及所有历史费用记录。重试本身保持暂停，不会调用 DeepSeek。生产环境已暂停的批次不会因本修复自动启动；本次变更不包含生产迁移执行、部署或这 20 篇论文的重新处理。

验证：`cd api && npm ci --ignore-scripts && npm test`；`node scripts/check-sensitive.mjs`；`git diff --check`。新增离线模拟覆盖截断、空内容、非法 / 合法 JSON、证据校验、错误日志、失败状态、有限退避、人工重试、缓存、重复批次、并发和中断恢复。
