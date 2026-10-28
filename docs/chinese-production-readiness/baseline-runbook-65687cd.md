# 待批准后执行的发布、验收和回滚手册

**本文件所有SSH、SCP、生产Docker/Nginx、Wrangler发布和数据库命令均未执行。** 当前结论NO-GO；先满足[就绪报告](README.md)的门槛。下述`readiness-65687cd`只代表本轮已构建的检查候选；来源状态修复后必须替换为重新验证、锁定的新SHA/镜像和Pages产物，不能沿用旧检查结论上线。

## A. 本机可执行的准备（无生产变更）

```powershell
cd C:\Users\martin\Documents\FanScope-Dev
$ErrorActionPreference = 'Stop'
$env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
$env:PATH = 'C:\Program Files\Git\usr\bin;C:\Program Files\Git\mingw64\bin;' + $env:PATH
git status --short
git rev-parse HEAD
Push-Location api
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw '后端测试失败' }
Pop-Location
node scripts/prepare-chinese-pages-release.mjs
if ($LASTEXITCODE -ne 0) { throw '安全前端构建失败' }
docker context inspect --format '{{json .Endpoints.docker.Host}}'
# 仅当确认指向本机Docker Desktop，而非远端Docker时构建
docker build --tag fanscope-api:readiness-65687cd --file api/Dockerfile api
if ($LASTEXITCODE -ne 0) { throw '镜像构建失败' }
docker image inspect fanscope-api:readiness-65687cd --format '{{.Id}} {{.Os}}/{{.Architecture}}'
```

产物路径以`work/release-readiness/pages-manifest.json`为准。本机脚本不会调用Wrangler；仅复制白名单前端资源、排除本地工作台并去掉相应入口。不要上传整个仓库、work、api/.env、授权文档或SQLite。

生产上线需要镜像和源码工具包一起保存并记录SHA-256。传输先由本机生成；源码归档只包含被审查版本的api/deploy目录，不包含工作区数据库或.env：

```powershell
$ReleaseSha = '65687cd2cb86eefbc2e35a612d32c03debeca60c' # 修复后换成最终已验SHA
git archive --format=tar --output=work/release-readiness/source.tar $ReleaseSha api deploy
if ($LASTEXITCODE -ne 0) { throw '源码归档失败' }
docker image save --output work/release-readiness/api-image.tar fanscope-api:readiness-65687cd
if ($LASTEXITCODE -ne 0) { throw '镜像归档失败' }
Get-FileHash work/release-readiness/source.tar,work/release-readiness/api-image.tar -Algorithm SHA256
```

检查候选标签固定为65687cd；未来最终镜像需以对应新SHA命名并同步替换本手册/覆盖文件。不要对已审核标签重新build成另一份内容。

## B. 取得批准后的只读服务器核对和传输

先由用户明确现有主机别名、SSH身份、仓库目录、是否sudo、维护窗口和磁盘容量。本轮没有读取SSH私钥或.env，也没有连接主机。以下占位值故意会失败，必须由实际运维资料替换，不能猜IP或项目路径。

```powershell
$ServerTarget = 'REPLACE_USER@REPLACE_SERVER'
if ($ServerTarget -match 'REPLACE') { throw '先确认现有SSH目标及主机指纹' }
ssh -o StrictHostKeyChecking=yes $ServerTarget
```

在服务器确认（只输出指定字段，不输出含密钥的完整docker inspect或Compose渲染环境）：

```bash
set -euo pipefail
APP_ROOT=/REPLACE_WITH_EXISTING_FANSCOPE_ROOT
case "$APP_ROOT" in *REPLACE*) echo 'Confirm existing application directory'; exit 2;; esac
cd "$APP_ROOT"
pwd
git rev-parse HEAD                         # 若现有发布目录无Git，记录版本文件/镜像来源
sudo docker inspect --format '{{.Image}}' fanscope-api
sudo docker inspect --format '{{range .Mounts}}{{println .Type .Name .Destination}}{{end}}' fanscope-api
sudo docker exec fanscope-api node --version
sudo docker compose -f deploy/docker-compose.yml ps
uname -m
df -h
```

核对实际数据库确为`/app/data/fanscope.sqlite`、现有持久卷确为`fanscope_data`，及架构与已构建镜像一致；不一致立即停止，调整方案而不是新建空卷。磁盘要容纳旧/新镜像、卷外快照、演练副本、迁移可能生成的额外快照及WAL。

批准后再以SCP传输到**新建的私有暂存目录**，不直接覆盖现有项目。Windows原生SCP使用`${变量}`避免冒号解析错误：

```powershell
# 先由服务器运维创建并确认 /var/tmp/fanscope-release-65687cd 属于当前SSH用户
scp -o StrictHostKeyChecking=yes work/release-readiness/api-image.tar work/release-readiness/source.tar "${ServerTarget}:/var/tmp/fanscope-release-65687cd/"
if ($LASTEXITCODE -ne 0) { throw '传输失败' }
scp -o StrictHostKeyChecking=yes deploy/chinese-release.safe.yml deploy/chinese-release.nginx-locations.conf scripts/chinese-release-db-proof.mjs scripts/chinese-release-backup.mjs "${ServerTarget}:/var/tmp/fanscope-release-65687cd/"
if ($LASTEXITCODE -ne 0) { throw '发布工具传输失败' }
```

服务端用`sha256sum`与本机清单核对。加载新镜像只用`docker image load`，不删除旧镜像；将源码解到新release目录并单独保留旧目录，不从GitHub拉取。原.env只在服务器私下复制到新release的api/.env，权限600；不传回本地、不输出内容。

准备新目录的服务器步骤（全部待批准；占位路径未确认时停止）：

```bash
STAGE=/var/tmp/fanscope-release-65687cd
NEW_RELEASE_ROOT=/REPLACE_WITH_NEW_PRIVATE_RELEASE_DIRECTORY
case "$NEW_RELEASE_ROOT" in *REPLACE*) echo 'Confirm a NEW release directory'; exit 2;; esac
test ! -e "$NEW_RELEASE_ROOT"                # 不覆盖旧目录
mkdir -m 750 "$NEW_RELEASE_ROOT"
tar -tf "$STAGE/source.tar"                 # 核对仅有预期api/deploy内容后再解包
tar -xf "$STAGE/source.tar" -C "$NEW_RELEASE_ROOT"
install -m 600 "$APP_ROOT/api/.env" "$NEW_RELEASE_ROOT/api/.env"
install -m 644 "$STAGE/chinese-release.safe.yml" "$NEW_RELEASE_ROOT/deploy/chinese-release.safe.yml"
# 新覆盖文件是独立传输的准备材料，原65687cd源码归档本身不含它
sudo docker image load --input "$STAGE/api-image.tar"
sudo docker image inspect fanscope-api:readiness-65687cd --format '{{.Id}} {{.Os}}/{{.Architecture}}'
EXISTING_COMPOSE_PROJECT=$(sudo docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' fanscope-api)
test -n "$EXISTING_COMPOSE_PROJECT"
```

`APP_ROOT`须指向原服务目录，`NEW_RELEASE_ROOT`是新版本目录；两者不得混淆。确认Compose label是有效原项目名（不是空值或`<no value>`）后再进入下一步，避免启动第二套服务。

## C. 维护窗口、一致性备份及恢复验证

下面会停止服务，**只有获得下一次明确生产操作批准后才可执行**。先在Nginx/现有入口开启维护阻断新请求、处理在途写入，再停止原Compose服务。停止不会删除卷；旧服务的实际目录和Compose project name必须沿用，以免误创建另一个服务或卷。

```bash
set -euo pipefail
cd "$APP_ROOT"
umask 077
RELEASE_ID=65687cd-20261026                  # 最终候选确定后替换
PRIVATE_BACKUP="$HOME/fanscope-private-backups/$RELEASE_ID"
test ! -e "$PRIVATE_BACKUP"                # 每次发布使用新目录，避免覆盖旧回滚点
mkdir -p "$PRIVATE_BACKUP"
chmod 700 "$PRIVATE_BACKUP"
OLD_IMAGE=$(sudo docker inspect --format '{{.Image}}' fanscope-api)
printf '%s\n' "$OLD_IMAGE" > "$PRIVATE_BACKUP/old-image-id.txt"
sudo docker image tag "$OLD_IMAGE" "fanscope-api:rollback-$RELEASE_ID"
sudo docker compose -p "$EXISTING_COMPOSE_PROJECT" -f deploy/docker-compose.yml stop fanscope-api
# 上一命令仅在批准后的维护窗口执行；不是本轮已执行动作
```

确认没有其他容器、宿主机CLI或定时任务继续写同一数据库。`sudo docker ps --filter volume=fanscope_data`若仍显示其他写入者，停止备份流程，先处理写入冻结。保留原卷只读挂载，把停写后的**完整卷文件（含SQLite、WAL、SHM和原始文档）**复制到全新私有目录，再在副本上操作SQLite：

```bash
sudo docker run --rm --network none --user 0:0 \
  --mount type=volume,src=fanscope_data,dst=/data,readonly \
  --mount type=bind,src="$PRIVATE_BACKUP",dst=/backup \
  --entrypoint sh fanscope-api:readiness-65687cd -eu -c \
  'test ! -e /backup/frozen-volume; mkdir -m 700 /backup/frozen-volume; cp -a /data/. /backup/frozen-volume/'

sudo docker run --rm --network none --user 0:0 \
  --mount type=bind,src="$PRIVATE_BACKUP",dst=/backup \
  --mount type=bind,src=/var/tmp/fanscope-release-65687cd,dst=/tools,readonly \
  --entrypoint node fanscope-api:readiness-65687cd \
  --experimental-sqlite /tools/chinese-release-backup.mjs /backup/frozen-volume/fanscope.sqlite /backup/pre-release.sqlite
```

工具以只读模式打开副本源库，但其目录可创建必要SHM；只有新快照文件被写入。**不要**将正在写入的主.sqlite单独复制、删除WAL，或对生产库使用immutable模式忽略WAL。本机已复现只读挂载可能打不开WAL数据库，并验证冻结副本方案；真实服务器仍需演练。[SQLite WAL只读条件](https://www.sqlite.org/wal.html)、[一致性快照说明](https://www.sqlite.org/lang_vacuum.html)

备份由容器root创建时，完成后仅对已知快照文件执行 `sudo chown "$(id -u):$(id -g)" "$PRIVATE_BACKUP/pre-release.sqlite"` 并保留权限600，便于受控SCP异机保存；不要递归改变生产数据卷权限。完整冻结卷副本另外归档保管，其中的原始文档、WAL和权限信息不可随意丢弃。

同一维护窗口私下备份`.env`、实际Nginx配置、旧Compose配置，以及卷中的`lab-documents/`和其他原始文件。保存UID/GID、权限和文件清单；快照与文档备份必须属于同一冻结窗口。Docker volume整体备份可以作为第二道保障，但不能取代独立可打开的SQLite快照。禁止删除卷、覆盖原SQLite或用本地349库替代。

在私有目录运行只读证明工具，输出到私有文件，不把账号/研究元数据上传Git或Pages：

```bash
sudo docker run --rm --network none --user 0:0 \
  --mount type=bind,src="$PRIVATE_BACKUP",dst=/backup \
  --mount type=bind,src=/var/tmp/fanscope-release-65687cd,dst=/tools,readonly \
  --entrypoint node fanscope-api:readiness-65687cd \
  --experimental-sqlite /tools/chinese-release-db-proof.mjs /backup/pre-release.sqlite \
  > "$PRIVATE_BACKUP/baseline-proof.json"
```

工具逐行哈希英文论文、已有AI结果、原期刊启用/游标状态及已有任务/账号等表，不运行迁移；派生类型/相关性/缓存指纹列与schema版本另行核对。保护摘要不相同即停止；不能在差异列表里有内容时宣称数据无损。

将备份**复制为新文件**至私有演练目录，绝不移动唯一快照。用候选镜像、`--network none`、空付费Key、无生产卷挂载，对此副本导入`server.mjs`一次，再新建容器导入第二次；不要运行`src/server.mjs`主入口，不映射公网端口。Windows Docker Desktop本轮已验证原构建和Node22冒烟；这不替代腾讯云真实副本的验证。

演练副本经两次迁移后，用同一证明工具读取副本并把`baseline-proof.json`作为第二参数：

```bash
# 示例：/backup/rehearsal/fanscope.sqlite 已经是副本，不是持久生产文件
sudo docker run --rm --network none --user 0:0 \
  --mount type=bind,src="$PRIVATE_BACKUP",dst=/backup \
  --mount type=bind,src=/var/tmp/fanscope-release-65687cd,dst=/tools,readonly \
  --entrypoint node fanscope-api:readiness-65687cd \
  --experimental-sqlite /tools/chinese-release-db-proof.mjs /backup/rehearsal/fanscope.sqlite /backup/baseline-proof.json \
  > "$PRIVATE_BACKUP/rehearsal-proof.json"
```

须exit0、integrity=ok、foreignKeyViolations=0、differences=[]，并人工核对新增表/期刊和允许变化的派生字段。若旧版本的Lab备注迁入私有归档而触发差异，必须核对原字段与归档逐条一致并明确批准，不能放宽校验一键忽略。

最后在另一个新目录恢复一份pre-release快照，用**旧镜像**隔离启动并核验旧英文数、AI JSON、账号/文档与任务；所有付费Key为空、无外网、无自动worker。旧镜像是否支持导入makeServer需先核查，不可默认它识别新开关。下载一份快照和必要文件到另一台受控机器并核SHA-256，确保服务器损坏时仍能恢复。没有这一步不能称为“可恢复性验证完成”。

## D. 获批准后迁移结构，再更新后端

真实副本验证通过，且生产仍处维护窗口、旧容器已停，才运行一次性迁移进程。新release目录必须保留原.env，原Compose服务名、container_name、volume实际绑定不变。镜像已加载并核对ID，覆盖文件已人工审查。

```bash
cd "$NEW_RELEASE_ROOT"                      # 运维已核实的新源码目录
sudo docker compose -p "$EXISTING_COMPOSE_PROJECT" \
  -f deploy/docker-compose.yml -f deploy/chinese-release.safe.yml \
  run --rm --no-deps -T fanscope-api \
  node --experimental-sqlite --input-type=module \
  -e "await import('./src/server.mjs');"
```

`run`继承服务卷，**会接触生产SQLite并执行迁移**；仅上段明确批准后运行。没有启动原入口worker。成功后对持久库做只读证明与基线比较；异常停止，保留升级现场和备份。完成批准清单的离线中文导入与第二次去重验收前，不打开公众中文数据展示。本轮清单尚未放行，因此没有生成直接执行导入全部349条的命令。

通过后更新后端：

```bash
sudo docker compose -p "$EXISTING_COMPOSE_PROJECT" \
  -f deploy/docker-compose.yml -f deploy/chinese-release.safe.yml \
  up -d --no-build --no-deps fanscope-api
sudo docker compose -p "$EXISTING_COMPOSE_PROJECT" \
  -f deploy/docker-compose.yml -f deploy/chinese-release.safe.yml ps
curl --fail --show-error http://127.0.0.1:8787/api/health
```

现有Nginx加入管理路由阻断片段，先`sudo nginx -t`，成功才按批准流程reload；不替换原TLS、域名或proxy_pass。Nginx reload也属生产变更，本轮未执行。解除维护前核验API、CORS、数据证明及AI关闭状态。英文普通监测恢复与付费AI队列恢复分开决定；不直接恢复原CMD而带动历史running任务。

## E. Windows本地Wrangler发布前端（待批准）

从现有Cloudflare项目读取真实生产分支和上一个成功生产部署ID。Wrangler本轮未安装/登录或调用账户API，故这些值仍待确认。不要新建项目、换域名或连接GitHub。

```powershell
cd C:\Users\martin\Documents\FanScope-Dev
$Manifest = Get-Content work/release-readiness/pages-manifest.json -Raw | ConvertFrom-Json
$PagesDir = Join-Path (Get-Location) $Manifest.folder
if (Test-Path (Join-Path $PagesDir 'chinese-import.html')) { throw '禁止发布本地工作台' }
$ProductionBranch = 'REPLACE_WITH_EXISTING_PRODUCTION_BRANCH'
if ($ProductionBranch -match 'REPLACE') { throw '先确认现有Pages生产分支' }
# 以下npx会使用Wrangler；只在批准、正确账户登录后执行，建议锁定验证过的版本
npx.cmd wrangler pages project list
if ($LASTEXITCODE -ne 0) { throw 'Cloudflare账户或项目权限检查失败' }
npx.cmd wrangler pages deployment list --project-name fanscope --environment production --json
if ($LASTEXITCODE -ne 0) { throw '无法记录旧生产部署' }
npx.cmd wrangler pages deploy $PagesDir --project-name fanscope --branch $ProductionBranch --commit-hash $Manifest.sourceCommit --commit-dirty=true
if ($LASTEXITCODE -ne 0) { throw '前端发布失败，按回滚方案处理' }
```

使用已确认的现有项目名；若Cloudflare实际项目名不是fanscope，停止并修正，不能根据域名猜后新建。`--commit-dirty=true`如实表明产物经过只读安全变换，并非原web目录逐字副本。Wrangler `pages deploy`不需要GitHub，但没有验证过当前账户的生产分支，命令不能提前运行。[官方参考](https://developers.cloudflare.com/workers/wrangler/commands/pages/)

## F. 发布后验收命令（下一次批准后）

PowerShell公开读检查：

```powershell
$Api = 'https://fanscope-api.adapttochina.com'
Invoke-RestMethod "$Api/api/health"
$English = Invoke-RestMethod "$Api/api/stats?market=international&period=all&article_type=all"
$Chinese = Invoke-RestMethod "$Api/api/stats?market=chinese&period=all&article_type=all"
$Diagnostics = Invoke-RestMethod "$Api/api/chinese-diagnostics"
$English | Select-Object count,analyzed
$Chinese | Select-Object count,analyzed
$Diagnostics.items | Select-Object id,title,total,market
Invoke-WebRequest -UseBasicParsing -Method Options -Uri "$Api/api/health" -Headers @{Origin='https://fanscope.pages.dev';'Access-Control-Request-Method'='GET'}
```

与维护冻结时真实基线比，英文原论文ID/字段、原AI JSON和历史任务证明必须一致；count10803/analyzed375是本轮观察值，不能代替新快照。中文新增数须等于批准批次的实际去重结果，不能写死349/58/3。核对中英文market无冲突、无测试demo混入、未知日期/月份精度/无摘要不会被算作近期AI已分析。

只读检查管理入口：`/chinese-import.html`不能返回工作台内容；前端`/chinese-import.js`和templates不应存在；API `/api/admin/chinese-imports/catalog`及其他中文管理路径应由Nginx404阻断，包括带有效管理员身份的受控内部测试。不要在公开终端打印管理员密钥。原英文管理员操作与Lab身份功能须单独回归，在恢复其写入功能前确认维护限制已按计划解除。

1440px与390px实测：首页、英文列表/搜索/详情、中文列表/按期刊与日期/主题筛选、原文链接、来源状态和趋势缺失分母；检查控制台异常、网络404/CORS、整页溢出。只触发GET/OPTIONS，不点击付费AI、批量回填或邮件发送。读出当前API数据与页面核对，不注入349或3本作为替代。

## G. 故障回滚

1. **前端问题**：在现有Pages项目回滚到发布前记录的成功生产deployment ID；preview部署不能作为生产回滚目标。先回滚前端以免继续请求旧后端不存在的新API，不删除当前部署或项目。[Pages回滚说明](https://developers.cloudflare.com/pages/configuration/rollbacks/)
2. **后端代码问题、数据库兼容已验证**：恢复记录的旧镜像ID/旧Compose配置和安全HTTP启动方式；保留当前数据卷。切回前再核验旧镜像可读当前schema；未知时不强行启动。付费Key仍暂不提供，禁止靠旧版本不认识的新开关阻止消费。
3. **数据库问题或旧镜像不兼容**：维护阻断并停止新服务；先把升级后的完整库/WAL及文件生成一致性故障现场快照，记录上线后新增、AI账本和文档，**不丢弃这些新增成果**。将pre-release快照恢复为同一持久卷中的**另一个新文件名**（例如`fanscope.rollback-RELEASE.sqlite`），让临时回滚覆盖文件的DATABASE_PATH指向该文件；不要覆盖或删除现库，不删除卷。按旧镜像恢复旧文档副本和环境，核对完整性与保护证明再恢复访问。后续按审计导出补录期间新增数据。
4. 回滚会暂时退回快照时点，需用户明确同意数据恢复点并处理期间增量；不能“回滚代码”同时无声清空新论文或AI花费记录。保留新旧镜像、数据库和所有快照，后续清理由用户另行安排。

禁止`docker compose down -v`、`docker volume rm`、DROP/DELETE清表、清空api/data、直接用本地库覆盖生产库，或在未核验的路径执行递归删除。回滚也必须作为明确获准的生产变更执行，本轮没有执行。
