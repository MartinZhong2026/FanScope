# ◢ FanScope v1.2 — Research Intelligence + Lab Workspace

V1.6 CI/CD：[配置、首次启用与回滚手册](docs/CICD_V1_6_ZH.md)。前后端部署默认关闭，启用需完成 Environment、Cloudflare 单渠道和主机维护门禁配置。

v1.2在现有Cloudflare Pages静态前端与曼谷Docker / Node.js 22 / SQLite后端上升级，不替换现有账号和数据。包含固定窗口Crossref恢复、发表日期视图、安全文章外链、独立候选期刊体系、带证据的DeepSeek提取/简报、ECharts趋势、科研项目工作台、共享论文表与人工确认Excel导入、DOCX/PDF/文本更新审批。

- [本版完成/待完成/风险与测试](docs/RELEASE_V1_2.md)
- [配置、费用边界、人工升级/备份/回滚](docs/OPERATIONS_V1_2.md)
- [浏览器验收截图与日志](docs/acceptance/README.md)

本版为Draft PR，未部署生产。CSSCI/JCR候选排名一律待官方核验；中文稳定来源未接入；OpenAlex默认关闭；未配置邮件时明确显示待配置。原始课题组Excel不提交公开仓库。

测试：`cd api && npm ci --ignore-scripts && npm test`，或构建 `api/Dockerfile` 在Node22容器运行。依赖：ExcelJS 4.4.0（MIT），前端本地托管ECharts 6.0.0（Apache-2.0）。仅后端保存服务密钥，`web/config.js`继续使用当前HTTPS API域名。

旧v1.1说明留作历史部署参考；其中“私人论文反馈”和“零npm依赖”已由v1.2共享成果表与受控依赖替代。以本版发布/运维文档为准。

---

> **这是一份可启动的 MVP 源代码，不是已经上线的正式系统。** 设计目标是优先做好“新论文监测 → DOI 去重 → 研究方向匹配 → 邮件通知 → 真实趋势可视化”。

**前端**：Cloudflare Pages 免费子域名（纯 HTML/CSS/JavaScript，**零 npm 依赖**）。

**后端**：曼谷云服务器 Docker + Node.js 22 原生 SQLite + Crossref 期刊查询 + 可选 DeepSeek + Resend 邮件。只有配置了真实数据源后才显示真正的文章；**没有伪造论文、假统计、假通知**。

## v1.1 新增：科研项目 / 论文 / AI 文档更新

在原有 **Research Radar（国内 C 刊、国外英文期刊、Crossref 监测、DeepSeek 摘要、Resend 邮件、研究趋势可视化）** 基础上，本版新增 `/lab/` 登录后工作台：

- **Projects**：全员查看项目公开进展；导师和课题组管理员可以新建项目，并把管理权限授权给负责项目的学生。
- **Manuscripts**：全组可查看论文题目、作者、公开阶段；私人稿件反馈、备注、下一步仅论文负责人和导师可查看。
- **Members**：个人实习、课程、求职、研究等近况；默认仅本人和导师可见。
- **AI Document Update**：外部转写 → 上传 **DOCX 或可复制文字的 PDF** → DeepSeek 提取关联项目/论文/成员的建议 → 原文证据校验 → 逐条审核 → 写入历史记录；**不提供音频转写，不自动更改记录**。
- **分配给我的审核**：与管理员职责匹配的项目建议、自己的论文与个人建议可自行审核；原始文档仍限上传者和导师访问。
- **Research Library**：原始科研数据库和大规模档案的入口继续置灰，没有把之前上传的课题组原始数据打入 ZIP。
- 仍使用 **Cloudflare Pages 前端 + 现有曼谷服务器 Docker API**，利用现有 SQLite 文件自动添加 `lab_` 表，**不需要额外买域名、另买服务器或安装 exe**。

**新增详细部署和操作指南：[`docs/LAB-SETUP-ZH.md`](docs/LAB-SETUP-ZH.md)**。

## 开箱即有

- ✅ 国内中文 C 刊与国外英文期刊**独立管理与筛选**；分区标签不假装已审核为 JCR Q1 / CSSCI。
- ✅ 5 本候选英文期刊的 Crossref ISSN 自动增量监测，默认每 120 分钟检查；启动默认回看近 14 天论文。
- ✅ 3 本候选中文期刊预留条目；**RSS 未核实时默认禁用**，支持配置合法官方 RSS/Atom 或手动导入真实文章。默认**不能声称实时抓取国内 C 刊**。
- ✅ DOI 去重、在线发表日期、首次发现日期、健康检查、按期刊抓取错误日志。
- ✅ 按导师研究方向四组主题匹配：灾害与健康 / 长期照护 / AI 与数字劳动 / 社会救助与贫困。
- ✅ 首页图表、期刊观察名单、论文搜索/筛选、研究设计与样本量统计（信息不够就显示未知）。
- ✅ 可选 DeepSeek API，仅根据标题+摘要进行结构化提取（**不表示全文已审查**）；限制每轮处理数，避免失控收费。
- ✅ 可选 Resend 邮件：邮箱确认订阅、重点相关论文通知、日汇总、周汇总、退订链接。
- ✅ 私有 Lab Data、研究缺口、选题匹配模块显式置灰；**不包含用户此前上传的研究数据库、访谈、群聊或任何私有资料**。
- ✅ Docker 限制内存 420MB，数据卷持久化，Nginx HTTPS 配置样例。

## 目录结构

```text
FanScope-v1/
├── web/                    Cloudflare Pages 前端（直接上传即可）
│   ├── lab/             登录后 Lab Workspace 静态页面
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── config.js          仅需改这里的 API_BASE_URL
│   ├── _headers
│   └── assets/favicon.svg
├── api/
│   ├── src/               Node.js 22 标准库后端（含 lab.mjs）
│   ├── config/journals.json 期刊观察名单
│   ├── config/topics.json   研究方向词典
│   ├── test/              API 与数据处理测试
│   ├── Dockerfile
│   ├── .env.example        修改并复制为 .env，勿上传真实密钥
│   └── package.json
├── deploy/
│   ├── docker-compose.yml
│   └── nginx-site.example.conf
├── examples/chinese-papers.json
└── docs/
    ├── LAB-SETUP-ZH.md   v1.1 登录、项目、论文、文档更新完整指南
    ├── DEPLOY-ZH.md       从 GitHub 到 Pages/VPS 的操作
    ├── SOURCES-AND-LIMITS.md
    └── ACCEPTANCE-ZH.md
```

## 先在 Windows 上本地体验（不需要安装依赖包）

**前提：电脑安装 Node.js 22.13+ 和 Python 3，或使用任何静态 HTTP 文件服务器。**

1. 解压 ZIP。在 `FanScope-v1/api` 中复制 `.env.example` 为 `.env`，将 `DATABASE_PATH=./data/fanscope.sqlite` 保持原样。为 `ADMIN_KEY` 设置随机、至少 24 位的字符串。若只想体验界面，可以暂时不配置 DeepSeek / 邮箱 API Key。
2. PowerShell（API 终端）：

```powershell
cd .\FanScope-v1\api
Copy-Item .env.example .env
# 使用记事本打开 .env 并填写 ADMIN_KEY，其他字段可暂时保持默认
node --experimental-sqlite src/server.mjs
```

3. 新开一个 PowerShell 终端（前端静态服务）：

```powershell
cd .\FanScope-v1\web
python -m http.server 4173
```

4. 浏览器打开 **http://127.0.0.1:4173**。API 默认运行在 `http://127.0.0.1:8787`。
5. API 终端会尝试读取真实 Crossref 文献；如果当前网络不可用，前端将明确提示监测源故障。
6. 手动运行测试：`cd api; npm test`（不安装任何第三方包；使用内置 node:test）。

**重要：** 浏览器直接双击打开 `index.html`（`file://`）可能触发跨源限制，请使用上面的本地 HTTP 服务。

## 正式上线的基本原则

1. 先在曼谷服务器启动 API、确认其健康，再配置公网 HTTPS 反向代理。
2. Cloudflare Pages 前端通过 `web/config.js` 连接 **HTTPS** 后端，避免浏览器 Mixed Content 阻止 HTTP 请求。
3. Cloudflare Pages 使用 `https://<project>.pages.dev` 免费子域名；**无需购买新的域名**。
4. 后端 HTTPS 仍需要一个稳定域名。若已有 `adapttochina.com` 并且可控制 DNS，可复用其子域名（如 `fanscope-api.adapttochina.com`），**无需新买域名**；若不使用已有域名，则须自行解决稳定 HTTPS 域名问题。
5. Resend 要求你验证邮箱发送域名并配置 DNS；**不要把 API Key 放在 web/config.js 或 GitHub 仓库中**。
6. **不建议将本网站放入 Cloudflare Pages 之后，就把后台 8787 端口直接对公网开放。** Docker 只监听 `127.0.0.1:8787`，公网通过 Nginx 443 转发。
7. 如果原服务器已经运行其他网站，**不要覆盖 `/etc/nginx/nginx.conf` 或现有服务的 Docker Compose**；仅新增 FanScope 单独反向代理配置。

完整逐步操作：**[docs/DEPLOY-ZH.md](docs/DEPLOY-ZH.md)**。

## 仍然不能直接承诺的能力

- 中文 CSSCI 全量实时抓取：需要你确认学校数据库的许可使用范围，找到可用的期刊更新源；RSS 适配器不能替代知网/CSSCI 的正规数据使用授权。
- “Q1 中稿概率”：没有全部投稿和拒稿数据，不能计算真正的录用概率；页面展示已发表论文结构画像和覆盖率。
- 自动获取全部全文：Crossref 很多记录不包含摘要与样本规模，信息缺失时会如实显示。所有 AI 字段需要人工抽样复核。
- 持续运行保证：需要服务器、DNS、外部 API、电子邮件供应商都可访问；本代码未在你的曼谷服务器、Cloudflare、Resend 账户真实部署验证。

## 技术说明

- Node.js 22 内置 `node:sqlite` 当前仍是**实验性 API**，版本升级前应备份和重新跑测试。开发此项目时使用 Node 22.16。
- 当前调度器为单 Node 进程定时轮询；请只运行**一个后端副本**，以免重复扫描和通知。
- SQLite WAL 存储单实例低并发状态，在小团队 MVP 中足够。Docker volume 跨容器更新保留数据。
- API 无管理网页，写接口通过 `X-Admin-Key` 鉴权；密钥不得加入前端代码。后续团队规模扩大应补充登录、角色权限和审计。

**研发依据**：课题组公开名称与三个方向来自你提供的《团队研究方向260914》；未包含内部研究数据本身。

## v1.1 当前验收与未完成项目

- `cd api && npm test`：10 项自动化测试通过，含 DOCX/PDF 解析、模拟 DeepSeek 结构化输出、审核/权限/隐私、原始邮件监测回归。
- 测试使用合成会议文本，**未调用真实付费 DeepSeek API**。
- 本运行环境的浏览器访问本地服务被管理员限制，**没有完成真实浏览器端到端视觉验收**；上线前按 `docs/LAB-SETUP-ZH.md` 手动检查 1440/390px。
- 登录、项目/论文/成员及组会导入功能均为 MVP，非已批准的正式校内科研管理平台。

## 42 本期刊与历史回填验收（2026-10-25）

[阶段交付与运行边界](docs/journal-audit/README-ZH.md) · [42 本逐刊验收矩阵](docs/journal-audit/COVERAGE-ZH.md) · [可下载 CSV](docs/journal-audit/coverage.csv)。实际联网与 Mock 回归证据分开记录，生产环境未操作。

## 当前开发优先级：2026 年最新研究趋势

默认近期与当前年度视图、证据型文章分类、公开摘要补充及暂停的 AI 候选准备，见 [2026 趋势优先开发说明](docs/TRENDS-2026-ZH.md)。2025 年数据完整保留为可选基线，42 本期刊范围不变。
