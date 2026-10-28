# 第四阶段实施记录：英文期刊来源证据调查

## 动机

阶段三已经实现历史回填和 AI 任务持久化，但 `api/config/journals.json` 仍有 17 本英文期刊 `enabled:false` 且 `source:manual`，20 本中文期刊同样尚未可靠自动接入。不能依赖 DeepSeek 猜测期刊论文，也不能直接把配置字段改为启用。

## 设计

- 用户管理员授权后才从固定 `https://api.crossref.org/works` 获取公开数据。
- 使用 Crossref 官方的 `query.bibliographic` 参数，不使用已废弃的 `query.title`。
- 仅对 `container-title` 与候选期刊规范化名称完全一致、具有 DOI 的 `journal-article` 提取 ISSN；同一 ISSN 至少需要两个不同 DOI 作为候选证据。
- 搜到的 ISSN 仅作为 **待核验建议**。通过原有 `probeJournalSource` 的官方 `/journals/{issn}/works` 进行二次交叉核实，再经管理员确认启用。
- 调查状态保存到 `journal_discovery_jobs`，只追加 SQLite 表，不清理旧数据。
- 服务器重启后 `running` 恢复为 `queued`。出错保留原因并需要管理员手动重试。
- 操作界面不长期存储 `ADMIN_KEY`，也不自动读取或触发付费的 DeepSeek 请求。

## API

| 方法 | 路径 | 权限 | 功能 |
| --- | --- | --- | --- |
| GET | `/api/journal-discoveries` | 公开 | 展示调查任务状态及 DOI 证据 |
| POST | `/api/admin/journal-discoveries` | 管理员 | 创建待配置期刊调查 |
| POST | `/api/admin/journal-discoveries/start-all` | 管理员 | 开始处理暂停任务 |
| POST | `/api/admin/journal-discoveries/{id}/retry` | 管理员 | 对失败任务重新排队 |
| POST | `/api/admin/journal-source/discover` | 管理员 | 单本期刊即时获取候选建议 |
| POST | `/api/admin/journal-source/test` | 管理员 | 二次核验 ISSN + DOI + 期刊名称 |
| POST | `/api/admin/journal-source/activate` | 管理员 | 明确确认后启用来源 |

## 验收边界

本地 Mock 证明任务创建、恢复、证据筛选和权限接口存在；本地网络限制导致未验证 Crossref API 当天真实结果，也不能推断待接入 17 本都能成功。线上使用需先验证并人工检查样本。若 Crossref DOI 不足，应保持 `needs_review`，考虑出版社公开 API 或合法导入。
