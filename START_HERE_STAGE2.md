# FanScope v1.3 · Stage 2（完整源码包）

**这是第二阶段增量修改后的完整源码，包含上一阶段的全部文件。** 请把 ZIP 解压出的 `FanScope/` **内部内容**同步到你本机的 FanScope GitHub 工作目录，**不要把整个 ZIP 作为附件直接提交**；也不要直接修改腾讯云服务器上的数据库或上传 `.env`。

## 先看这几个文件
- `docs/V1_3_STAGE2_ZH.md`：本阶段实际改动、测试结果与验收步骤。
- `web/stage2.css`：可回滚的 Night Academic Workspace 视觉覆盖层。
- `web/theme.js`：深色 / 浅色 / 跟随系统三种主题，默认深色，记住本机偏好。
- `web/app.js`：新首页、来源配置页面、导航与 ECharts 主题适配。
- `web/lab/stage2.css`：Lab 工作台的深浅色样式。
- `api/src/journal-onboarding.mjs`：第一阶段实现的期刊身份验证逻辑，第二阶段由网页界面调用。

## 提交和上线顺序
1. 在 GitHub Desktop 创建新分支 `feat/fanscope-v13-stage2-workspace`，将解压后的源码文件复制并覆盖到仓库。
2. 检查 diff：请特别确认 **没有提交 `api/.env`、任何真实 SQLite 数据库、Lab 上传文件或密钥**。
3. 执行 `cd api && npm ci && npm test`，并在手机/桌面浏览器检查夜晚模式和期刊状态。
4. 推送 PR，审核 GitHub Actions；**不要未经验证直接合并部署**。
5. 如 Stage 1 的新后端尚未部署，必须先确认 `/api/journal-source-status` 等 Stage 1 接口可用，才能使用管理员期刊来源功能。前端变更可独立发布，但管理页面需要新后端。
6. 生产后端如需升级：先在服务器上进行独立数据库备份与隔离迁移测试，核对论文和 Lab 数据数量；不得执行 `docker compose down -v`。

## 重要边界
- **没有**自动连通新增的 17 本英文期刊或 20 本中文期刊；仍要逐一查证数据来源和分区证据。
- 期刊验证会真正访问 Crossref，管理员点击「核验并启用」后才把通过的英文期刊纳入监测。
- 深色模式和 UI 测试不会触发 DeepSeek 解析，也没有新增收费/付款功能。
- 这次没有替换前端框架、数据库或者 Docker 卷。
