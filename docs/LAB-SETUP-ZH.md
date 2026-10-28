# FanScope v1.1 Lab Workspace：完整中文部署与操作指南

> 此文档补充 `DEPLOY-ZH.md`，并不替代原有的期刊监测部署流程。**原 v1.0 数据库可保留，v1.1 通过 `CREATE TABLE IF NOT EXISTS` 自动新增 Lab 数据表。** 先备份 SQLite 数据卷再升级。

## 0. 最终结构

- **Cloudflare Pages**：`web/` 静态目录。原期刊监测首页保持不变，左侧出现「科研项目与 AI 组会更新」链接，进入 `/lab/`。
- **曼谷服务器**：原 Node.js 22 + SQLite / Docker Compose API，增加 `/api/lab/*`。
- **外部服务**：DeepSeek API 用来阅读 Word/PDF 的可提取文字、提出结构化变更建议；Resend 仍只负责原研究雷达的邮件订阅。
- **没有音频转写服务**：会议先使用飞书等软件转写，再导出 `.docx` 或可复制文本的 `.pdf`。
- **没有课题组原始研究数据库上传**：Research Library 页面是灰色规划入口。当前会上传经成员主动选择的 Word/PDF 会议文档，保存在后端私有数据目录，并用它生成变更建议。

## 1. GitHub 手动上传

1. 解压 ZIP，进入 `FanScope-v1/` 文件夹。
2. GitHub 新建**私有**仓库，例如 `FanScope`。
3. 将 `FanScope-v1/` **里面的文件与子目录**上传至仓库根目录（而不是将外层 `FanScope-v1` 多套一层）。目录应该以 `web/`、`api/`、`deploy/`、`docs/`、`README.md` 开头。
4. GitHub 网页端可在 `Add file -> Upload files` 中拖入文件夹内容；如果浏览器不能正确保留文件夹路径，使用电脑上的 Git Bash/PowerShell：

```powershell
cd "你解压后的目录\FanScope-v1"
git init
git branch -M main
git add .
git commit -m "Add FanScope Research Radar and Lab Workspace v1.1"
git remote add origin https://github.com/你的用户名/你新建的仓库.git
git push -u origin main
```

> 不要上传你的 `api/.env`、实际数据库、课题组访谈文件或个人研究资料。仓库中 `.env.example` 是不带凭证的模板。

## 2. 本地运行

前提：Windows 上有 Node.js 22.13+、Python 3；**本机 PDF 解析需要安装 `pdftotext`，DOCX 解析需要安装 `unzip`**。Docker 镜像会自动安装这两个工具。如果只运行期刊雷达或创建项目/论文，本机暂时不装解析工具也可以。

```powershell
cd .\FanScope-v1\api
Copy-Item .env.example .env
# 在 .env 中填写 ADMIN_KEY，并确认 DATABASE_PATH
node --experimental-sqlite src/server.mjs
```

另开窗口：

```powershell
cd .\FanScope-v1\web
python -m http.server 4173
```

- 期刊雷达：`http://127.0.0.1:4173/`
- 课题组工作台：`http://127.0.0.1:4173/lab/`

首次打开 Lab Workspace 会出现登录界面；**不会提供公开注册**。

## 3. 创建导师账号（只需运行一次）

进入 `api/`，在服务器或开发电脑执行：

```bash
node --experimental-sqlite src/lab-cli.mjs create-user "杨帆老师" teacher@example.edu mentor '这里放12位以上的真实随机密码'
```

使用该账号登录，然后在「成员动态」页面建立其他人的账号，分配 `member` 或 `lab_admin` 权限；导师也可以授权具体项目的项目管理员。

**升级现有服务器的推荐命令：**

```bash
# 在你的服务器 FanScope 仓库目录：
cd FanScope
# 如果之前已经部署过，请先对持久化数据卷做备份！
git pull
cd deploy
docker compose up -d --build
# 运行中的后台容器内初始化导师账号：
docker compose exec fanscope-api node --experimental-sqlite src/lab-cli.mjs create-user "杨帆老师" teacher@example.edu mentor '更换为随机高强度密码'
```

如不小心忘记密码，管理员可在服务器执行（无需暴露数据库到公网）：

```bash
docker compose exec fanscope-api node --experimental-sqlite src/lab-cli.mjs reset-password teacher@example.edu '新的随机高强度密码'
```

该操作会让该成员现有的会话失效。成员也可以在侧边栏自主「修改密码」。

## 4. Cloudflare Pages 设置

与原版保持一致：

- GitHub 仓库连接 Pages。
- `Root directory`：`web`。
- Build command：`exit 0`（不需要前端构建）。
- Output directory：`.`。
- 无需新域名，Pages 会提供类似 `fanscope.pages.dev` 的免费子域名（取决于项目名是否可用）。
- 先编辑 **`web/config.js`** 中的 `API_BASE_URL`，指向曼谷服务器的真实 **HTTPS** 后端地址；不能把 DeepSeek / Resend 密钥写在浏览器代码里。
- 服务器 `api/.env` 的 `ALLOWED_ORIGINS` 要包含你实际发布的 Pages 地址；前端预览域名需要按需明确加入。

## 5. 后端反向代理 / 上传限制

原 Nginx 样例更新了 `client_max_body_size 12m`，支持最多 10MB 的 Word/PDF 请求。更新此项时不需要覆盖现有 Nginx 全局配置，而是修改你部署 FanScope 的虚拟主机 server block。

重新构建 Docker 镜像很重要：新版 `api/Dockerfile` 额外安装 `poppler-utils`（pdftotext）和 `unzip`，纯静态前端不能独立解析这些文件。

`/api/lab/documents` 直接上传原始字节，不使用 multipart/form-data。上传后的分析进入后台队列，浏览器会每 2.5 秒读取一次当前所选文档的状态。若进程中断，重启时会尝试恢复未完成的记录（每次最多 10 条，其他文档可手动重试）。

在 `api/.env` 中配置：

```env
DEEPSEEK_API_KEY=你的真实DeepSeekKey
DEEPSEEK_MODEL=deepseek-flash
PUBLIC_FRONTEND_URL=https://你的项目.pages.dev
PUBLIC_API_URL=https://你的HTTPS后端域名
ALLOWED_ORIGINS=https://你的项目.pages.dev,http://localhost:4173,http://127.0.0.1:4173
```

模型名称应以你的 DeepSeek 账户实际可用名称为准，API 失效时，文档显示“需重试”，不会默默修改项目或论文。

## 6. 建议第一次使用的顺序

1. 导师登录并新增至少一名课题组管理员。
2. 管理员在 Projects 中建 2 个项目，并在详情里授权负责项目的学生。
3. 成员在 Manuscripts 登记各自论文，题目与公开阶段对组内全员可见；私人备注及导师反馈只对论文负责人和导师开放。
4. 在 Members 中维护成员名单；成员可以自己更新个人近况。个人近况默认仅本人/导师可见。
5. 组会录音由**外部工具**转写为 Word/PDF，轮值学生在 AI 文档更新页上传文件。
6. 后端调用 DeepSeek，提出“项目/论文/成员”的变更建议和原文短句证据。
7. 轮值学生只审核自己有权限修改的记录。涉及其他论文/成员的建议出现在对应作者本人或导师的待审核队列，项目管理员能从「分配给我的待审核建议」查看自己项目的建议，不必看整份原始文档。
8. 审核通过后才保存更新，并记录来源文档、证据原文、操作者、修改前后状态；拒绝或跳过不会修改记录。

## 7. 权限表

| 内容 | 导师 | 课题组管理员 | 项目管理员 | 普通组员 |
|---|---|---|---|---|
| 项目名称、阶段、公开进度 | 查看/编辑 | 查看/编辑 | 查看全组；编辑所管项目 | 查看全组 |
| 所有论文的题目、作者、公开阶段 | 查看 | 查看 | 查看 | 查看 |
| 论文私人笔记、导师修改记录 | 查看 | 不可查看他人 | 不可查看他人 | 仅自己的论文 |
| 成员个人近况 | 查看 | 仅自己的 | 仅自己的 | 仅自己的 |
| 组会原始上传文件 | 查看 | 仅自己上传 | 仅自己上传 | 仅自己上传 |
| 与本人职责有关的建议 | 审核 | 审核项目 | 审核所管项目 | 审核自己论文和个人动态 |
| 账号创建 / 项目管理员授权 | 有 | 有（不授予导师身份） | 无 | 无 |

**注意**：本版本仅支持一名论文负责人对应的私人讨论。如果需要共同作者和联合指导的细粒度授权、文件协作与评论，后续应扩展对象级 ACL，再考虑真实稿件协作。

## 8. 当前支持/不支持

- ✅ 可复制文字的 PDF、DOCX；上传文件保存在后端受控目录，上传者和导师可下载原件。
- ✅ 单份 Word/PDF 可以为多个项目、论文、成员生成候选更新；AI 只能匹配已经创建的对象。
- ✅ 审批时可编辑摘要与下一步内容、驳回建议、保留来源原文和历史记录。
- ✅ 项目更新全组可见，论文公开阶段全组可见，论文私人反馈仅导师/作者可见，成员动态仅本人/导师可见。
- ✅ 课题组管理员可以添加学生账户，项目管理员可以管理自己的项目。
- ✅ 原 Research Radar 的定时监测、电子邮件通知不受影响。
- ⏳ 图片扫描 PDF 不支持 OCR、旧版 `.doc` 不支持、没有内置音频识别、不能直接连接普通微信群。
- ⏳ 不支持数据集本体上传、文件夹批量归档、全文语义检索、多人共同审阅同一篇论文。
- ⏳ DeepSeek 分析只发送 PDF/Word 中前约 85,000 字符及已有项目/论文的简要信息，超长记录需后续分段提取方案。
- ⏳ 目前没有端到端真实 DeepSeek 账户付费请求验收，需在部署环境做一次样本测试。

## 9. 诊断与维护

```bash
# 健康检查
curl https://你的API域名/api/health
# 工作台是否已创建任一账户
curl https://你的API域名/api/lab/ready
# 日志
cd deploy && docker compose logs -f --tail=150
# 执行自动化测试（建议本地）
cd ../api && npm test
```

服务端所有 Lab 接口使用 Bearer 登录令牌验证；不要将管理员密钥、令牌、DeepSeek Key 或真实学生密码上传到 GitHub。

**生产注意**：本系统提供了第一版认证与对象级 API 权限控制，但还不是学校正式审定的科研档案系统；在承担高敏感数据或大量未公开稿件前，应安排专业安全评审、备份验证和数据管理审核。
