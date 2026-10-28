# 发布、验收与回滚手册（尚未批准执行）

2026-10-28更新：本人已完成腾讯云核查和在线备份/隔离恢复PASS。此次正式发布请只执行[0d38926执行单](release-0d38926.md)，其中已锁定旧镜像、Compose、现有备份及Pages回滚点。下面为2026-10-27原方案的历史内容，不作为此次操作指令；不再执行其中的停服复制/重复备份步骤。正式生产部署、迁移及重启尚未批准；实际备份副本的新版本兼容性验收仍待执行。

## 本机准备

```powershell
Set-Location C:\Users\martin\Documents\FanScope-Dev
$ErrorActionPreference = 'Stop'
git status --short
$ReleaseSha = (git rev-parse HEAD).Trim()
$ReleaseImage = "fanscope-api:release-$ReleaseSha"
Push-Location api
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw '测试失败' }
Pop-Location
node scripts/prepare-chinese-pages-release.mjs
if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
docker context inspect --format '{{json .Endpoints.docker.Host}}'
# 确认指向本机Docker Desktop后才构建；不得构建到远程Docker。
docker build --tag $ReleaseImage --file api/Dockerfile api
if ($LASTEXITCODE -ne 0) { throw '镜像构建失败' }
$env:FANSCOPE_RELEASE_IMAGE = $ReleaseImage
# 渲染不能打印完整环境值，审查只选择image/command/volumes/ports。
docker image inspect $ReleaseImage --format '{{.Id}} {{.Os}}/{{.Architecture}}'
git archive --format=tar --output=work/release-readiness/source.tar $ReleaseSha api deploy scripts/chinese-release-backup.mjs scripts/chinese-release-db-proof.mjs
docker image save --output work/release-readiness/api-image.tar $ReleaseImage
Get-FileHash work/release-readiness/source.tar,work/release-readiness/api-image.tar
```

仅发布清单folder指定的静态包；sourceTreeDirty必须false，sensitiveScanPassed必须true。不要把密钥放命令行或归档。git archive不包含本地.env及数据库。

## 生产前置批准与一致性备份

本人需先确认实际Compose项目名、文件路径、镜像ID、卷类型及Source/Destination、数据库路径、磁盘余量、旧镜像启动方式和维护窗口。保存目前成功Pages部署和旧镜像回滚点。明确批准传输、维护阻断、停止原服务、复制生产卷、备份异机及副本演练，才执行以下阶段。

1. 用现有入口维护阻断新写请求，处理在途事务；按已核实Compose项目停止服务。停止不删除卷。检查其他容器、宿主CLI和定时任务均不再写同库。
2. 记录旧镜像ID、Compose及私有配置；在全新权限700私有目录完整复制停写后的卷（SQLite、WAL、SHM、lab-documents、UID/GID及文件权限），原卷只读挂载。不要对运行中单独cp主.sqlite，不删除WAL，不用immutable忽略WAL。
3. 在可写的私有副本目录运行备份工具，源以只读打开，VACUUM INTO创建新快照。源目录可能需要SQLite SHM；不直接对生产路径运行工具。下述均在**副本**执行：

```bash
node --experimental-sqlite /VERIFIED_TOOLS/chinese-release-backup.mjs /PRIVATE_COPY/fanscope.sqlite /PRIVATE_BACKUP/pre-release.sqlite
node --experimental-sqlite /VERIFIED_TOOLS/chinese-release-db-proof.mjs /PRIVATE_BACKUP/pre-release.sqlite > /PRIVATE_BACKUP/baseline-proof.json
```

4. 检查完整性、外键，校验SHA256并在受控异机保存；包含同期文档和私有配置，不能上传Git或Pages。
5. 复制快照为演练新文件。候选镜像--network none、无生产卷、空付费Key，通过导入server.mjs只执行初始化，两次各用新容器，不执行server主入口。用证明工具与baseline比较旧英文论文、AI JSON、任务、账户及文档，差异必须逐项解释并批准。迁移非全库事务，失败保留现场。
6. 再把pre-release快照恢复为另一新文件，用已审查的旧镜像HTTP-only方式隔离启动，核实旧数据可读。旧镜像不一定识别新开关，不能直接运行其原CMD恢复历史付费任务。

真实生产副本没有通过以上步骤时禁止继续。已有合成恢复演练不能代替本阶段。

## 批准后传输与后端先发布

Windows传输目标固定为ubuntu@43.133.108.137；但本机SSH目前失败，先由本人恢复既有身份连接，不反复尝试密码。以下仅在另次批准和已核实目标目录后执行，解包到全新release目录，不能覆盖.env或数据。

```powershell
$ServerTarget = 'ubuntu@43.133.108.137'
# /VERIFIED_RELEASE_STAGING须由本人确认的非生产数据目录替换
scp -o StrictHostKeyChecking=yes work/release-readiness/source.tar work/release-readiness/api-image.tar "${ServerTarget}:/VERIFIED_RELEASE_STAGING/"
```

服务器人工核对SHA256、加载镜像、核对镜像ID和体系结构。新源码目录沿用原私有配置；原Compose项目、service、容器名、端口及持久卷绑定必须不变。审核safe覆盖后的配置只输出允许字段，不输出环境密钥。镜像变量必须设置，避免使用旧标签或隐式latest。

```bash
# 只有生产备份/恢复、维护窗口、实际Compose/卷审查全部通过并获批后执行。
# 下列变量由已核实的发布记录提供；不允许猜测。
: "${NEW_RELEASE_ROOT:?}" "${EXISTING_COMPOSE_PROJECT:?}" "${FANSCOPE_RELEASE_IMAGE:?}"
export FANSCOPE_RELEASE_IMAGE
cd "$NEW_RELEASE_ROOT"
# 已确认原服务停写，实际配置绑定原有生产卷；本步骤会运行结构迁移。
sudo --preserve-env=FANSCOPE_RELEASE_IMAGE docker compose -p "$EXISTING_COMPOSE_PROJECT" -f deploy/docker-compose.yml -f deploy/chinese-release.safe.yml run --rm --no-deps -T fanscope-api node --experimental-sqlite --input-type=module -e "await import('./src/server.mjs');"
# 迁移后用证明工具核查持久库，确认与基线一致，再启动。
sudo --preserve-env=FANSCOPE_RELEASE_IMAGE docker compose -p "$EXISTING_COMPOSE_PROJECT" -f deploy/docker-compose.yml -f deploy/chinese-release.safe.yml up -d --no-build --no-deps fanscope-api
curl --fail --show-error http://127.0.0.1:8787/api/health
```

safe覆盖使用src/release-server.mjs：只启动HTTP，不恢复任务；付费AI/Resend/OpenAlex Key为空；所有写请求503，中文管理404。原.env不被改写，但维护期英文监测、AI、邮件和订阅写入都会暂停。恢复普通worker需要额外审查历史队列，不能直接切回旧CMD。

Nginx管理路由片段deploy/chinese-release.nginx-locations.conf须人工合并到现有API server，仅获批后nginx -t及reload；不替换TLS、域名、proxy_pass。后端自身已硬404，不能只依赖前端隐藏按钮。

349条本地库不上传或覆盖生产。当前没有获批公开记录，所以本轮不给出导入全部349条的命令。未来如有批准清单，须锁定源导出哈希、逐条许可/字段证据、期刊与ID/DOI、人工审批、去重冲突处理；先在真实副本导入两次，第二次新增0，旧英文/AI证明不变，再另次批准生产迁移。

## 后端验收通过后才发布前端

Cloudflare只读核验：fanscope，生产部署main；当前成功e709f071-5c27-4e46-9b88-3b5b58b48988（956320e），上一成功bffe225d-216b-41be-a42c-8f9886bc86d5（e7203bb）。发布前再次只读确认未被他人更新，并记录最新成功ID作为此次回滚目标，不盲用历史ID。

```powershell
$Wrangler = 'C:\Users\martin\AppData\Local\npm-cache\_npx\32026684e21afda6\node_modules\wrangler\bin\wrangler.js'
$env:WRANGLER_SEND_METRICS = 'false'
$env:CI = 'true'
$env:CLOUDFLARE_ACCOUNT_ID = '6814aab23baa7509d3cc00a650b07ca9'
node $Wrangler pages deployment list --project-name fanscope --environment production --json
$Manifest = Get-Content work/release-readiness/pages-manifest.json -Raw | ConvertFrom-Json
if ($Manifest.sourceTreeDirty -or -not $Manifest.sensitiveScanPassed) { throw '产物不满足发布条件' }
$PagesDir = Join-Path (Get-Location) $Manifest.folder
node scripts/verify-pages-release.mjs $PagesDir
if ($LASTEXITCODE -ne 0) { throw '包复核失败' }
# 下一行是生产发布，仅在单独明确批准且后端验收通过后执行。
node $Wrangler pages deploy $PagesDir --project-name fanscope --branch main --commit-hash $Manifest.sourceCommit --commit-dirty=true
if ($LASTEXITCODE -ne 0) { throw '发布失败，按回滚流程处理' }
```

commit-dirty=true反映安全包经过只读变换；源清单仍必须sourceTreeDirty=false。无需GitHub，不创建新项目，不改变域名。缓存Wrangler路径不存在即停止，不自动安装/登录。

## 发布后验收

```powershell
$Api = 'https://fanscope-api.adapttochina.com'
Invoke-RestMethod "$Api/api/health"
Invoke-RestMethod "$Api/api/stats?market=international&period=all&article_type=all" | Select-Object count,analyzed
Invoke-RestMethod "$Api/api/stats?market=chinese&period=all&article_type=all" | Select-Object count,analyzed
(Invoke-RestMethod "$Api/api/chinese-diagnostics").items | Select-Object id,title,total,market
```

健康aiConfigured应false；原英文数量/AI证明和冻结基线比对，不能用历史10803/375代替。中文数取生产API，不写死349或3。验证诊断市场隔离、实际来源状态、日期精度、缺失摘要及分析覆盖率。管理入口404，静态工作台404且不包含工作台内容；受控内部检查有效管理员身份也不能绕过。不在公开终端打印密钥，不向生产写入测试请求。

1440/390px验证首页、英文搜索和详情、中文搜索/期刊/日期/主题筛选、原文链接、来源和趋势分母，无横向溢出、JS异常或CORS/404导致全局失败。只GET/OPTIONS，不触发AI或后台采集。本轮本地截图不能宣称生产新版本已验收。

## 失败回滚

1. 前端故障：在既有Pages项目控制台回滚到此次发布前记录的成功生产部署ID；不使用Preview，不删除项目/部署。现记录e709为发布前候选回滚点，bffe为更早备用点，需发布前重核。
2. 后端代码故障且旧镜像兼容新库：保持维护阻断，回到已记录旧镜像ID与旧配置；使用已验证HTTP-only启动方式，保留当前数据卷，不恢复付费任务。
3. 库故障或旧镜像不兼容：先保留升级后库/WAL/文档的一致性故障快照和新增记录，再把pre-release快照恢复为同卷中的另一个新文件名，临时DATABASE_PATH指向该文件；不覆盖或删除现库，不删除卷。用旧镜像及同期文档副本校验后恢复访问，后续审计补录期间新增数据。
4. 数据恢复点和期间增量处理须本人明确批准。回滚也是生产变更，当前未获准执行。

禁止docker compose down -v、删除Volume、清空表、覆盖生产SQLite。任何关键信息不明即停止；不要用重试或默认值绕过发布门槛。
