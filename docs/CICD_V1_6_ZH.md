# FanScope V1.6 CI/CD 操作手册

## 检查结果与实现边界

开始时已 fetch，main 与 origin/main 同步、工作区干净，基线 b77f2b09d4035ded549d6e2b188d24f0eb5ab746。实际 Dockerfile 为 api/Dockerfile，前端为 web 静态文件。保留原 API、Mobile、Desktop、Chinese、双语、Chromium/WebKit 验收、敏感信息扫描和 npm audit，新增静态构建、Docker、备份/恢复和发布安全测试。

V1.4 的 v14-server.mjs 独立运行英文增量监测/显式启用的 AI，不恢复通用 server 入口中的历史回填、邮件、文档队列。旧发布脚本有固定旧镜像和备份路径，本 CD 不调用它的部署、中文导入或 enable-ai 操作。

**没有执行生产部署、数据库操作、付费 AI 或平台配置变更。Cloudflare 当前 Git 绑定未取得账户级证据，尚未确认。** 两个 CD 开关默认关闭；本地通过不能等同线上验证。

## 信任边界

前端使用 Actions + Wrangler；成功的 main CI 触发可信 main 工作流，只下载静态产物。PR 预览采用独立 fanscope-preview 上的**浏览器验收截图画廊**，原交互测试在合成 fixture 中执行。预览无脚本、生产 API、表单或 iframe；不是连接生产的交互式副本。工具只复制 PNG、生成可信 HTML，拒绝 Worker/Functions/symlink/私有文件，覆盖 CSP/config 并去掉 redirects，不执行 PR 产物中的代码。预览 URL 在工作流 Summary。

后端使用服务器拉取制：GitHub hosted 构建固定 SHA → production 审批 → receipt 绑定 run/SHA/artifact ID/digest → 腾讯云 systemd 出站 HTTPS 拉取。无需新增公网 SSH、SSH 私钥或同机生产 runner。成本为一次性 Python/systemd 控制器及只读 GitHub token。专用 runner 的 Docker 权限等价 root，Environment 不隔离进程，因此不选；公网 SSH 则增加入口和长期私钥。本方案不改变现有管理员 SSH、防火墙或其他容器。

## 必须手动配置的 GitHub 设置

先手动创建 Environment 并设规则，不依赖 YAML 自动创建未保护环境：

| Environment | 规则 | Secrets | Variables |
| --- | --- | --- | --- |
| production | 仅 main；Required reviewers；禁止绕过。多人维护建议防自批，单维护者先确认审批制度可执行 | 无 | 无 |
| pages-production | 仅 main；合并后自动发布，无逐次审批 | CLOUDFLARE_API_TOKEN | CLOUDFLARE_ACCOUNT_ID |
| pages-preview | 仅 main（可信 workflow_run 在 main 执行） | 独立 CLOUDFLARE_API_TOKEN | CLOUDFLARE_ACCOUNT_ID |

仓库 Variables：PAGES_CD_ENABLED=false、BACKEND_CD_ENABLED=false。完成验证后再分别设 true。不要添加仓库级 Cloudflare token、SSH、DeepSeek、Resend 或数据库 Secrets。

Settings → Rulesets / Branch protection：main 必须 PR + trusted review，要求 **FanScope checks / required**（界面可能仅显示 required），要求分支最新或 merge queue，禁止 force push/删除/绕过。required 依赖 api/mobile/build，失败/取消/跳过均失败，CI 支持 merge_group。**YAML 不能代替远端保护，本次不擅改远端规则。** workflows、scripts/cicd、deploy/cicd 是生产信任根，修改须严格审查。

CI contents read；发布仅额外 actions read、PR 元数据 read，无 contents/packages/id-token write。Actions 固定 SHA，Wrangler 精确版本与独立 lockfile，升级须重新审核。

## Cloudflare：只允许一个生产渠道

Workers & Pages → fanscope → Settings → Builds & deployments：确认 Git 是否绑定本仓库、production branch 为 main，记录当前成功 production deployment UUID。若有 Git 绑定，**关闭 production 自动部署及全部 preview 自动部署**，保留项目与旧部署，不删除或重建项目。

每次 Actions 部署调用项目 GET API；如存在 source，严格要求 production_deployments_enabled=false、preview_deployment_setting=none；缺字段也拒绝。若继续 Git 集成，则 PAGES_CD_ENABLED 保持 false，本实现的保护不自动适用于 Git 集成。

用户确认资源/费用后手动准备独立 fanscope-preview，production branch main，但仅发布 pr-N 分支；无自动 Git 部署、Functions、生产 Secrets 或 D1/KV/R2 绑定。代码不创建云资源。

Token 仅 **Account → Cloudflare Pages → Edit**，限制实际账户；不用 Global API Key，不授予 DNS/Zone/Workers scripts。Pages 权限按账户而非单项目限制；两个环境独立 token 便于轮换，更强隔离可使用专用预览账户。工具另固定允许两个项目名。

生产必须有上一个成功 canonical production deployment。上传失败保留旧版本；正式域名页面/config/SHA smoke 失败，仅在当前 SHA 仍拥有 active deployment 时自动 rollback。旧版没有 release.json 时，通过不可变 deployment UUID 和页面/config 验证恢复。手动一键回滚：Actions → **FanScope Pages deploy → Run workflow(main) → deployment_id**，填写成功生产 deployment UUID。发布/回滚共用串行并发组，不中途 cancel；过期 main CI 被 SHA 检查拒绝。有尚未结束的生产部署时拒绝新发布/回滚，避免客户端超时后异步旧部署覆盖新版；等待平台任务结束后再回滚。不要并行 Dashboard 手工发布绕过控制。

## 腾讯云安装：管理员审查后执行

前提 Ubuntu 24.04、Python ≥3.11、Docker/Compose v2、nginx、出站 HTTPS 到 GitHub API/artifact 存储及正式 API。现有项目标签 deploy、服务/容器 fanscope-api、唯一数据 Volume fanscope_data。当前容器必须已运行审核过的 V1.4 入口 `node --experimental-sqlite src/v14-server.mjs`，否则先做独立维护验证，不能绕过门禁接管会恢复历史队列的通用入口。

从最终审核 commit checkout 安装禁用控制器：

```bash
sudo bash deploy/cicd/install-host.sh
```

只安装 /opt/fanscope-cd、/etc/fanscope-cd、systemd 和状态目录；拒绝覆盖旧安装，不启动 timer/nginx/容器。控制器升级须单独审核，发布包不能更新主机脚本。

私下创建 /etc/fanscope-cd/github-token，root 所有、0600。fine-grained token 仅本仓库 Actions read + Contents read，设到期/轮换。通过 systemd LoadCredential 传入，不输出、不放 shell 参数/仓库/聊天。它不能审批或写仓库。

查询 `GET /repos/MartinZhong2026/FanScope/actions/workflows/backend-release.yml`，将数字 ID 写入 /etc/fanscope-cd/config.json 的 workflow_id；first_run_number 设置为下一个计划授权运行号，避免旧请求回放；enabled 暂 false。

仅在 FanScope API 的 server {} include [nginx-maintenance.conf](../deploy/cicd/nginx-maintenance.conf)。管理员 nginx -t 通过后 reload；维护窗口短暂创建 /var/lib/fanscope-cd/maintenance，确认正式域名 stats 503、health 200，再移除 marker。确认无绕过 nginx 的入口或其他进程写同一数据。安装设状态目录 0711，供 nginx stat marker，backups/incoming 0700。控制器每次也从正式域名实测 gate，失败不碰数据库。

service 的 FANSCOPE_COMPOSE_FILE 必须指向真实 Compose，env_file 继续使用现有服务器 .env，不复制/打印实际值。控制器解析配置但不输出，overlay 强制 external Volume、V1.4、AI/mail/import 关闭，保留 localhost 8787 与资源限制。root/Docker 是受审查控制器的必要权限，不属于 PR 作业。

配置完成后 enabled 改 true，才运行：

```bash
sudo systemctl enable --now fanscope-pull.timer
sudo systemctl status fanscope-pull.timer
```

停止后续部署：GitHub BACKEND_CD_ENABLED=false，systemctl disable --now fanscope-pull.timer。停止 timer 不会中断已运行 service；切镜像时勿强杀。

## 后端发布与恢复

main CI 成功后 dispatch **FanScope backend release**，选择 main，输入完整当前 SHA。发布包仅 image.tar、manifest.json、SHA256SUMS。审批者核对 SHA/CI/artifact 后批准 production。新 main 出现后旧 SHA 拒绝；失败必须新 dispatch，不重放旧授权。

轮询只接受 pinned workflow ID、首轮成功 dispatch、当前 main、精确 receipt；校验 GitHub ZIP digest、文件 checksum、image ID 和 OCI revision。只考虑最新请求，新请求待批/失败时不消费旧请求。cursor 部署前标 attempted，poll/host lock 防重叠；maintenance/transaction 未处理则拒绝新部署。

顺序：关入口并实测 503 → 原始 SQL pause AI（不 import 迁移）→ 等待运行工作结束 → SQLite Backup API 在线固定快照 → integrity/foreign keys/全部表指纹/隔离恢复 → 仅 SIGTERM fanscope-api 等待 180 秒 → 再检查 idle、最终冻结快照 → 候选镜像无网络/密钥运行恢复副本的启动初始化 → schema 或数据差异拒绝自动迁移 → Compose up --no-build --no-deps --pull never fanscope-api → Docker/API/全表指纹/正式 HTTPS 健康通过 → 开放入口。

uncertain AI、陈旧 running、强杀/OOM/非零退出保留维护模式，不自动清状态、重发请求、中文导入、迁移或恢复历史任务。不删除 SQLite/Volume，不执行 Compose down、volume rm/create、prune 或其他服务更新。

启动失败则停候选、备份失败数据，必要时通过 SQLite Backup API 将验证快照恢复到**同一 SQLite 文件/Volume**，再恢复上一镜像并验证数据与健康。恢复失败始终关闭入口。AI 不自动 resume；启用需另行审核独立运行配置/凭据和 V1.4 管理控制，部署审批不代表付费授权。不新增人民币预算上限，保留单队列/lease、暂停、缓存指纹及 uncertain 阻断。

result.json 记录 commit、image、previousImage、UTC 时间、runId、backup 路径及结果。GitHub 绿色仅表示授权，实际部署结果看主机：

```bash
sudo journalctl -u fanscope-pull.service -n 100 --no-pager
sudo cat /var/lib/fanscope-cd/backups/<release>/result.json
sudo python3 /opt/fanscope-cd/scripts/cicd/deploy_backend.py recover --confirm-sha <事务完整commit>
```

恢复命令须先人工 review transaction/镜像/任务。有冻结快照则完整恢复；尚未切镜像且无快照则要求原镜像、idle、完整性通过后制作恢复快照。部分备份/uncertain/意外镜像拒绝自动恢复，保留文件调查。不要删 marker/transaction 绕过。**成功开放入口并产生新数据后，不可用旧快照覆盖新数据**：优先 revert PR + CI + 新 dispatch，或另审旧镜像对当前数据的兼容性。自动数据库恢复仅适用尚未开放入口的失败事务。

备份/incoming 不上传 GitHub、不自动清理。空间不足停止。人工维护须保留上一镜像/已验证备份；同机备份不防磁盘损坏，应加密复制到已有独立位置并定期演练，代码不创建付费备份资源。

## 首次启用：9 步

1. 审查代码、本地测试及配置，创建 PR，验证远端 Linux CI。
2. 配置 main 保护和三个 Environments，production 有实际 reviewer，两个开关保持 false。
3. 确认 fanscope Git 绑定，关闭 production/preview 自动部署，记录旧成功 UUID。
4. 用户确认资源后准备 fanscope-preview，设置独立最小权限 token/Account ID。
5. 完成隔离 Docker/数据库演练；生产缺 V1.4 优雅退出基线时先独立维护升级。
6. 从审核 commit 安装禁用控制器，配置只读 credential、workflow ID、run 门槛、Compose 路径。
7. 仅为 FanScope include nginx gate，维护窗口验证 503/health，检查空间及独立备份。
8. 先启用 Pages，用新 PR 验证视觉预览；合并经 CI/review 的变更，核对正式 SHA/回滚。
9. 开主机 enabled/timer 与 BACKEND_CD_ENABLED；dispatch 当前 SHA，批准 production，观察主机结果与其他容器。

## 验证

```bash
cd api && npm ci --ignore-scripts && npm test
cd ..
python3 -m unittest discover -s scripts/cicd/tests -v
node scripts/cicd/build-pages.mjs
node scripts/cicd/build-pages.mjs --preview
node scripts/check-sensitive.mjs
docker build -t fanscope-ci:local -f api/Dockerfile api
python3 scripts/cicd/docker_rehearsal.py fanscope-ci:local
git diff --check
```

浏览器沿用 test.yml 全部原命令。本次实际结果及环境限制见 [测试记录](CICD_V1_6_TESTS.md)。

官方依据：[Cloudflare Git/关闭自动部署](https://developers.cloudflare.com/pages/configuration/git-integration/)、[Pages CI upload](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)、[Pages rollback](https://developers.cloudflare.com/pages/configuration/rollbacks/)、[GitHub Environment](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)。
