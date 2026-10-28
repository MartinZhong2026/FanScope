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
