# V1.6 实测记录（2026-10-28，Asia/Taipei）

仅使用隔离合成数据库和 mock AI；未运行生产部署、中文生产导入、真实 DeepSeek、邮件或线上数据库写入。GitHub/Linux CI 结果以 PR 上实际运行记录为准，不以本地通过替代。

| 检查 | 实际命令/环境 | 最终结果 |
| --- | --- | --- |
| API 全量 | Windows 原生 Node 22.23.4，api 目录：`node --experimental-sqlite --test --test-concurrency=2 test/*.test.mjs` | 192 passed，0 failed，0 skipped |
| Python 发布/SQLite | Python 3.13.11：`python -m unittest discover -s scripts/cicd/tests -v` | 15 passed，0 failed；包含全流程编排、启动数据变化后的数据库/镜像恢复及入口未关闭拒绝操作 |
| Pages 安全 | `node --test api/test/cicd-v16.test.mjs`，亦包含在上述全量 API 中 | 4 passed；单渠道、HTTP/SHA、拒绝 Worker、PNG 画廊/标签转义 |
| 双语浏览器 | Playwright 1.62.0，`bilingual-browser-acceptance.py --webkit` | 13 passed，pageErrors/mutations/externalRequests 均为空 |
| Mobile + Desktop | `mobile-browser-acceptance.py --webkit` | 99 passed，0 failed，pageErrors/mutations 均为空 |
| 深色参考 | `dark-reference-acceptance.py` | 35 passed，errors 为空 |
| Quality 中文 | `quality-browser-acceptance.py` | 16 checks，errors/externalRequests/mutations 均为空 |
| Quality 英文 | `quality-browser-acceptance.py --language en` | 16 checks，errors/externalRequests/mutations 均为空 |
| Chinese | `chinese-browser-acceptance.py` | 4 passed（320/390/768/1440），errors/mutations 均为空 |
| 前端构建/扫描 | `node scripts/cicd/build-pages.mjs --allow-dirty`，再 `--preview --allow-dirty` | 两个包构建通过；各复用现有 26 文件静态发布构建，排除中文导入工作台；增加 SHA marker |
| Docker 构建 | `docker build -t fanscope-ci:v16-local -f api/Dockerfile api`（本地测试另加 synthetic revision label） | Linux Node 22 镜像构建通过；不是生产发布 artifact |
| Docker 真演练 | `python scripts/cicd/docker_rehearsal.py fanscope-ci:v16-local` | onlineBackup/dataRestore/unhealthyRollback PASS；schemaChangeRejected=true；当时另外 5 个运行容器保持不变（4 个既有项目容器 + 1 个本任务 API 测试容器） |
| 工作流 | 官方 actionlint 1.7.12，下载包校验 SHA256 后运行 `actionlint`；另用 PyYAML 解析三个 workflow | 通过，无诊断 |
| Shell | WSL Ubuntu：`bash -n scripts/ci-fixture-server.sh deploy/cicd/install-host.sh` | 通过；新增 gitattributes 固定 LF |
| 依赖审计 | `npm audit --omit=dev --prefix api` 和 `--prefix deploy/pages` | 均 0 vulnerabilities |
| 敏感文件/空白 | `node scripts/check-sensitive.mjs`、`git diff --check` | 通过 |

浏览器在 Windows 原生 Node 22 + Chromium/WebKit 上运行。4173/8787 已被已有用户进程占用，未停止该进程；本地临时 wrapper 仅将端口映射为 14173/18787、对应 fixture config/CORS 和验收 URL 一并改端口，其他断言不变。临时 wrapper、日志、截图和数据库均保留在忽略的 work/ 中。CI 继续使用原来的 4173/8787 和 bash fixture helper。修复了 fixture 的 Windows 路径分隔符检查，不改变生产源码。

Chinese 首轮遇到旧的 data-cn-import 内嵌表单断言失败；V1.4 已改为独立的中文授权导入工作台链接。现在检查该链接存在且旧 inline form 不存在，保留市场隔离、布局、错误及无写入检查；重跑 4/4 通过，没有删测试或跳过断言。

## 未掩盖的环境失败

- 首轮 Linux Docker 全量 API 为 186/191：镜像继承 NODE_ENV=production 导致三个测试中的预期 401 变 404；另外两个启动验收超时。改为 NODE_ENV=test 后重跑，没有改生产鉴权或放宽超时。
- 后续 Docker Desktop 存储进入只读状态，测试报告 SQLite disk I/O / EROFS，新容器创建报告 containerd metadata.db read-only（exit 125）。完整 Linux 重跑及 Linux 浏览器因此未完成。仅停止本任务确认为测试命令的容器，没有重启 Docker、清理镜像/Volume 或停止无关容器。
- 转到原生 Windows Node 22，补齐测试工具路径后全量 API 192/192 和上述全部浏览器通过。最终主机控制器还增加了 API/SQLite 两个市场数量核验和镜像本地 ID 归一化，这些修改通过 Python 编排测试/静态检查；Docker 引擎故障后未重跑最终版本的真实 Docker 演练，PR 的 Linux Docker job 会执行它。
- 初次 actionlint 下载校验脚本遇到 PowerShell 字节响应解码问题，校验未通过时未执行程序；改为读取原始 checksums 文件核对后通过。
- Cloudflare 真实 API token、Git 集成状态、Environments/reviewers、nginx/主机安装与生产 smoke 均未验证/执行。它们是启用前置条件，见 [操作手册](CICD_V1_6_ZH.md)。

本地新增工具位于独立的 D:/FanScope-ci-v16，未全局更换 Node；部署源码、日志和截图中不包含实际密钥。Docker Desktop 需要用户在合适的维护窗口检查存储；本次不对其他项目运行环境作修复操作。

## Chinese Job 连续失败的追加修复

已核对 [main 运行 40665121636](https://github.com/MartinZhong2026/FanScope/actions/runs/40665121636) 和 [PR 运行 40665052498](https://github.com/MartinZhong2026/FanScope/actions/runs/40665052498) 的实际 job 日志：API、Mobile 和 Publication 步骤通过，均在旧脚本第 28 行查找 `[data-cn-import]` 失败。两次 SHA 分别为 b77f2b0 和 64157ef；当时本地 V1.6 尚未推送，远端没有收到初步 selector 修复。

根因：V1.4 的 `chinesePanel(true)` 提供单独的 `chinese-import.html` 本地工作台链接，已无旧的 inline import form。测试应检查该链接存在、旧表单不存在。生产公开包继续排除该工作台，生产 API 在鉴权前关闭中文管理路由；本次没有改动 web/、api/src/ 或生产部署配置。

本次在 **WSL Ubuntu 26.04 / Linux x86_64、Node 22.23.4、Python 3.14、Playwright 1.62.0 Chromium** 中执行。Node 官方下载包通过 SHASUMS256 校验；源码只从 Git 跟踪文件复制到新 Linux 临时目录，不复制实际 .env、数据库或 work 数据。Docker 镜像存储仍报告 I/O error，未重启或清理 Docker。

```bash
cd api
npm ci --ignore-scripts
npm test
cd ..
bash scripts/ci-fixture-server.sh start chinese api/test/chinese-browser-server.mjs
python scripts/chinese-browser-acceptance.py --output work/chinese-browser-linux
bash scripts/ci-fixture-server.sh stop chinese
```

结果：API **193 passed / 0 failed / 0 skipped**；Chinese **4/4 屏宽**通过，覆盖趋势、中文论文列表、真实原文来源、正反向搜索、中英文市场隔离和本地工作台。**8 次 missing/wrong-key 管理权限请求全部返回 401**；浏览器无页面错误、无写请求、无外部请求；验收前后两类论文列表完整一致。

API 全量中继续执行既有的生产模式保护矩阵：7 类中文管理路由 × GET/POST/PATCH/DELETE/OPTIONS，带正确管理员密钥、强制本地导入 flag 和 method override 仍全部 404。另新增子进程测试：本地中文 fixture 在 NODE_ENV=production 时立即拒绝，且不创建数据库。没有通过开放生产接口来满足本地 UI 测试。

扩展验收首次暴露市场切换后读取旧 DOM 的异步时序问题；改为等待匹配 market/q 参数的 articles HTTP 响应再判断列表，重跑通过，没有增加固定延时、删断言或跳过 Chinese。原 Mobile、Desktop、WebKit 和 API CI 配置保留不变。

`git diff --check`、敏感信息扫描、Python 编译和 actionlint 均通过。上述是实际 Linux 本地结果，不能标作新的 GitHub Actions 成功；Push/远端验证需要先完成 Git Credential Manager 认证，旧两次失败记录不会因本地修复自动改变。

### 首次远端 V1.6 演练发现的 Linux ownership 差异

完成 GCM 浏览器认证并推送后，PR #3 的 [运行 40680239339](https://github.com/MartinZhong2026/FanScope/actions/runs/40680239339) 中 API、前端构建、15 项 Python 测试及 Docker 构建通过。真实 Docker 演练在模拟失败迁移时报告 `attempt to write a readonly database`：容器以 root 建立 SQLite，而后续 Python 以 runner 用户模拟迁移；Windows bind mount 未暴露此 ownership 问题。

演练现使用宿主测试 runner 的 UID/GID 运行 seed/API 容器，保证合成数据库仍归 runner 所有；Windows 保留原兼容行为。没有放宽文件权限、跳过演练、使用 sudo 掩盖错误，也没有改生产控制器或 Volume。修复后远端结果以同一 PR 最新 SHA 的实际 Actions 为准。
