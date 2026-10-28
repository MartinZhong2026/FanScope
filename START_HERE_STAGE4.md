# FanScope v1.3 Stage 4 — GitHub 上传和验收

本 ZIP 是 Stage 1–4 累积的**完整项目源码**，根目录为 `FanScope/`；不含生产 SQLite、API 密钥或服务器 `.env`。

## 本阶段完成

- 新增 `/api/admin/journal-discoveries`：一次性创建 17 本尚未启用英文期刊的 ISSN 来源调查任务（默认为暂停）。
- 新增 `/api/admin/journal-discoveries/start-all`：管理员确认后将暂停的调查排队。
- 服务器 worker 每 15 秒挑选 1 条任务，向 Crossref `works?query.bibliographic=<期刊名>` 查询公开文章元数据；用匹配的期刊名称 + 不重复的 DOI 样本生成 ISSN 建议。
- `/api/journal-discoveries` 显示状态、候选 ISSN、引用 DOI、失败原因；重启后恢复未完成任务。
- 来源管理页面新增调查任务控制与一键填入候选 ISSN；必须再次手动检测 Crossref 期刊的 DOI + ISSN + 期刊名称，显式确认后才允许启用。
- 现有正式监测、2025–2026 历史回填、AI 队列与研究经费预算保持独立。

## 明确未完成的工作

- 未在本地执行真实 Crossref 联网核验：当前开发容器无外网，17 本英文候选期刊**还没有**被标记为启用。
- 中文 CSSCI 20 本期刊的稳定合法来源尚未取得，未自动启用。
- Full CI 依赖 `exceljs`，本地环境没有该依赖，完整集成测试需要 GitHub Actions。
- 还需管理员在实际联网的生产或 staging 环境逐本检查 DOI 样本、ISSN 与实际同步日志。

## 管理员操作

1. 登录 FanScope，打开「期刊来源管理」。
2. 点击「创建待配置英文期刊调查」，输入管理员密钥（前端不保存）。
3. 点击「启动待调查任务」。任务逐条在后台处理，刷新状态查看结果。
4. 对有 DOI 证据的 ISSN，点击「填入 … 并准备检测」→「检测来源」。人工核对后再点击「核验并启用」。
5. 启用后通过「监测健康状态」查看第一次成功同步；使用历史回填页补足过去的论文。

## 生产上线安全步骤

1. **先备份** `fanscope_data` Docker 卷中的 SQLite，并复制到仓库外的私有目录，校验完整性。
2. 在备份数据库副本上构建并运行新版迁移，核对 `articles`、Lab 账户和项目数量。
3. GitHub PR 检查通过后再合并。Cloudflare Pages 前端部署前，后端应先就绪，避免路由 404。
4. 在服务器 `git pull` 并执行 `sudo docker compose -f deploy/docker-compose.yml build fanscope-api` 和 `sudo docker compose -f deploy/docker-compose.yml up -d --no-deps fanscope-api`；不得使用 `down -v`。
5. 验证 `/api/health`、`/api/journal-discoveries`、`/api/journal-source-status` 和真实历史账户。

## 本地定向测试

```bash
cd FanScope
node --experimental-sqlite --test api/test/journal-discovery-stage4.test.mjs api/test/journal-onboarding-v13.test.mjs api/test/crossref-v12.test.mjs api/test/backfill-stage3.test.mjs api/test/stage2-ui.test.mjs api/test/stage3-contract.test.mjs
```

完整验证需先在 `api/` 内执行 `npm ci --ignore-scripts`，然后 `npm test`。检查站点不应出现伪造的 DOI、ISSN 或 AI 分析结果。
