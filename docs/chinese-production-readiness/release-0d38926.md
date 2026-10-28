# 0d38926 正式发布执行单（准备完成，生产操作未批准）

2026-10-28，Asia/Taipei。目标完整SHA：0d3892608c3d07b9c9cbcb03eb07896418cbbd66。当前工作分支feat/chinese-release-blockers；无已跟踪应用源码改动。未提交在线备份Python脚本、方案及.vscode不进入应用包。本单取代旧runbook中“重新备份/停服复制数据库”的阶段，**不重复生产备份**。

## 锁定的发布与回滚资产

| 项目 | 值 |
|---|---|
| 当前服务器源码 | e7203bb（本人提供；运行镜像源码另以指纹核查） |
| 旧镜像ID | sha256:56cc5589f51771e5e9212a4501a7f093a9b69c391e7371671e541f888ae2bb4a |
| Compose | project=deploy；/home/ubuntu/fanscope/deploy/docker-compose.yml |
| 生产卷/库 | fanscope_data；/app/data/fanscope.sqlite |
| 已PASS备份 | /home/ubuntu/fanscope-backup-20261028T024346Z |
| 备份快照 | 2026-10-28T02:43:46Z；本人验收4.74秒，完整性/外键/全表比对PASS |
| backup.sqlite SHA256 | a7f7893bd788d3f765e0b0bf4bb80d1446b6ffa39cd5b080af86d355cdf9330a |
| Pages | 既有fanscope，main；当前成功部署e709f071-5c27-4e46-9b88-3b5b58b48988 |

备份原目录和文件不覆盖、不删除、不改权限。只在新目录写兼容性演练副本。此备份是快照时点的数据库回滚点，不包含随后生产新增数据；代码回滚优先保留当前卷。没有把349条本地论文放入包或生产迁移。

目标镜像标签fanscope-api:release-0d3892608c3d07b9c9cbcb03eb07896418cbbd66；linux/amd64。Docker Desktop镜像ID为sha256:2817669bd7ab51e5ecc51ff4e724e397c660d5eefcc2ed5535b2dabd5d155e51；镜像归档配置摘要为sha256:f404887f4086250a7d3b7dd745a6f51ff5cfda22edd243e52c5971edfc893fd1。不同Docker存储后端可能用配置摘要作为image ID；加载后仅接受这两个已知身份，并核对revision标签。发布最终用服务器加载后的不可变ID，避免标签漂移。

## 差异与兼容性结论

本地Git确认e7203bb是目标版本祖先；目标保留其DeepSeek加固和英文/移动端实现，并包含后续research数据完整性、分析批次重试及双语显示修正。新增中文目录、诊断、去重和来源追溯；db.mjs相对e7203bb只新增两列chinese_identity_key/source_updated_at及对应索引。英文API读取路由和结果未删除。完整源码差异见包内e7203bb-to-0d38926-api.diff与stat。

**数据兼容尚须用实际备份副本验收，不能由在线备份PASS直接推定。** 旧库初始化也可能执行之前未落地的派生字段或Lab迁移；不是全库单事务。新代码和旧镜像都在该副本验证后才进入生产确认。

安全入口src/release-server.mjs只启动HTTP，不恢复任务或启动定时器，清空DeepSeek/Resend/OpenAlex凭据并拒绝外部fetch；CSV工作台不打包，生产中文管理路由404，即使有效管理员身份也不开放。该模式所有写请求503、订阅确认GET503；**英文后台监测、AI、订阅/邮件、Lab登录及其他写操作暂停**，英文历史论文/已有AI结果仍可读取。恢复普通worker属于后续独立任务，不能直接切回旧CMD。中文公开数据仍是生产API实际数量，本次读到0；不会上线349条。

## A. 本机文件及服务器接收（以下服务器命令当前未执行）

本机发布根目录记录在work/release-readiness/active-release-root.txt。server-bundle.tar只包含镜像、审计源码、工具、覆盖配置及清单；pages目录另供Wrangler。所有传输和服务器演练也由本人执行或另行授权，本次助手仅本地准备。

先在服务器创建全新暂存目录（已存在即停止，不覆盖）：

```bash
set -euo pipefail
umask 077
mkdir -p /home/ubuntu/fanscope-releases
mkdir -m 700 /home/ubuntu/fanscope-releases/0d38926
```

本机PowerShell传输，不使用GitHub：

```powershell
Set-Location C:\Users\martin\Documents\FanScope-Dev
$ReleaseRoot=(Get-Content work/release-readiness/active-release-root.txt -Raw).Trim()
scp -o StrictHostKeyChecking=yes "$ReleaseRoot/server-bundle.tar" "$ReleaseRoot/server-bundle.tar.sha256" ubuntu@43.133.108.137:/home/ubuntu/fanscope-releases/0d38926/
if ($LASTEXITCODE -ne 0) { throw '传输失败，停止；不重试密码' }
```

## B. 服务器包核查、备份锁定及当前版本核查

```bash
set -euo pipefail
umask 077
BUNDLE=/home/ubuntu/fanscope-releases/0d38926
BASE=/home/ubuntu/fanscope/deploy/docker-compose.yml
BACKUP=/home/ubuntu/fanscope-backup-20261028T024346Z
OLD_IMAGE=sha256:56cc5589f51771e5e9212a4501a7f093a9b69c391e7371671e541f888ae2bb4a
TAG=fanscope-api:release-0d3892608c3d07b9c9cbcb03eb07896418cbbd66
cd "$BUNDLE"
sha256sum -c server-bundle.tar.sha256
tar --no-same-owner -xf server-bundle.tar
sha256sum -c SHA256SUMS
test "$(sudo -n docker inspect --format '{{.Image}}' fanscope-api)" = "$OLD_IMAGE"
test "$(sudo -n docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' fanscope-api)" = deploy
test "$(git -C /home/ubuntu/fanscope rev-parse --short=7 HEAD)" = e7203bb
test "$(uname -m)" = x86_64
sudo -n docker inspect --format '{{.State.Status}} {{.State.Health.Status}} {{range .Mounts}}{{.Type}} {{.Name}} {{.Destination}}{{end}}' fanscope-api
sudo -n python3 - "$BACKUP" "$BUNDLE/backup-lock.json" <<'PY'
import sys,json,pathlib,hashlib
p=pathlib.Path(sys.argv[1]);r=json.loads((p/'verified.json').read_text())
expected='a7f7893bd788d3f765e0b0bf4bb80d1446b6ffa39cd5b080af86d355cdf9330a'
assert r['status']=='PASS' and r['integrity']=='ok' and r['foreignKeyViolations']==0 and r['allTablesAndSchemaMatch'] is True
assert r['snapshotAt']=='2026-10-28T02:43:46Z'
assert all(hashlib.sha256((p/f).read_bytes()).hexdigest()==expected for f in ['backup.sqlite','restore.sqlite'])
with open(sys.argv[2],'x') as out:json.dump({'directory':str(p),'snapshotAt':r['snapshotAt'],'sha256':expected,'preserve':True},out)
print('Existing backup LOCKED; originals unchanged')
PY
sudo -n docker exec -i fanscope-api node --input-type=module < tools/runtime-fingerprint.mjs > current-runtime.json
python3 - <<'PY'
import json
a=json.load(open('current-runtime.json')); b=json.load(open('tools/expected-e7203bb-runtime.json'))
assert a==b,'Running image source differs from e7203bb; stop and review custom changes'
print('Runtime source matches e7203bb')
PY
sudo -n docker image load --input api-image.tar
NEW_IMAGE=$(sudo -n docker image inspect "$TAG" --format '{{.Id}}')
case "$NEW_IMAGE" in
sha256:2817669bd7ab51e5ecc51ff4e724e397c660d5eefcc2ed5535b2dabd5d155e51|sha256:f404887f4086250a7d3b7dd745a6f51ff5cfda22edd243e52c5971edfc893fd1) ;;
*) echo 'Unexpected image ID'; exit 1;;
esac
test "$(sudo -n docker image inspect "$NEW_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = 0d3892608c3d07b9c9cbcb03eb07896418cbbd66
export FANSCOPE_RELEASE_IMAGE="$NEW_IMAGE"
export FANSCOPE_RELEASE_TOOLS="$BUNDLE/tools"
printf '%s\n' "$NEW_IMAGE" > loaded-image-id.txt
```

预期所有SHA检查OK，备份LOCKED，当前运行源码匹配，原容器仍Healthy，卷仍fanscope_data:/app/data。若架构、指纹、镜像、Compose或备份不符，立即停止，不覆盖当前版本、不尝试登录密钥。脚本只哈希已知源码/元数据文件，不读取.env；不要输出完整inspect或Compose环境。

## C. 用已完成备份做隔离兼容性验收

```bash
REHEARSAL=$(mktemp -d /home/ubuntu/fanscope-rehearsal-0d38926.XXXXXXXX)
printf '%s\n' "$REHEARSAL" > rehearsal-path.txt
sudo -n python3 - "$BACKUP/backup.sqlite" "$REHEARSAL/fanscope.sqlite" <<'PY'
import sys,shutil,os
with open(sys.argv[1],'rb') as src,open(sys.argv[2],'xb') as dst:
    shutil.copyfileobj(src,dst);dst.flush();os.fsync(dst.fileno())
os.chmod(sys.argv[2],0o600)
PY
proof_copy() {
  sudo -n docker run --rm --network none --memory 420m --cpus 1 --user 0:0 \
    --mount "type=bind,source=$REHEARSAL,target=/data" \
    --mount "type=bind,source=$BUNDLE/tools,target=/tools,readonly" \
    --entrypoint node "$NEW_IMAGE" --experimental-sqlite /tools/chinese-release-db-proof.mjs /data/fanscope.sqlite "$@"
}
proof_copy > "$REHEARSAL/before.json"
for round in 1 2; do
  sudo -n docker run --rm --network none --memory 420m --cpus 1 --user 0:0 \
    --mount "type=bind,source=$REHEARSAL,target=/app/data" \
    -e NODE_ENV=production -e DATABASE_PATH=/app/data/fanscope.sqlite \
    -e ADMIN_KEY=isolated-rehearsal-placeholder-only \
    -e DEEPSEEK_API_KEY= -e RESEND_API_KEY= -e OPENALEX_API_KEY= \
    --entrypoint node "$NEW_IMAGE" --experimental-sqlite --input-type=module \
    -e "globalThis.fetch=async()=>{throw Error('No outbound')};globalThis.setInterval=()=>{throw Error('No workers')};await import('./src/server.mjs');const {db}=await import('./src/db.mjs');db.close();"
  proof_copy /data/before.json > "$REHEARSAL/after-$round.json"
done
# 在已升级的隔离副本上测试旧镜像的安全HTTP回滚入口，无生产卷/端口/密钥。
sudo -n docker run -d --name fanscope-rollback-rehearsal-0d38926 --network none --memory 420m --user 0:0 \
  --mount "type=bind,source=$REHEARSAL,target=/app/data" \
  --mount "type=bind,source=$BUNDLE/tools,target=/release-tools,readonly" \
  -e NODE_ENV=production -e DATABASE_PATH=/app/data/fanscope.sqlite \
  -e ADMIN_KEY=isolated-rehearsal-placeholder-only \
  -e DEEPSEEK_API_KEY= -e RESEND_API_KEY= -e OPENALEX_API_KEY= \
  --entrypoint node "$OLD_IMAGE" --experimental-sqlite /release-tools/rollback-entry.mjs
sleep 3
sudo -n docker exec fanscope-rollback-rehearsal-0d38926 node --input-type=module -e "const b='http://127.0.0.1:8787';const h=await(await fetch(b+'/api/health')).json();if(h.status!=='ok'||h.aiConfigured)throw Error('Bad health');if((await fetch(b+'/api/admin/chinese-imports/catalog')).status!==404)throw Error('Admin exposed');if((await fetch(b+'/api/admin/scan',{method:'POST'})).status!==503)throw Error('Write exposed');console.log('Old-image safe rollback PASS');"
sudo -n docker stop fanscope-rollback-rehearsal-0d38926
proof_copy /data/before.json > "$REHEARSAL/after-old-image.json"
```

必须退出0，before/after报告integrity=ok、foreignKeyViolations=0、differences=[]。工具按旧英文/已有AI原字段、期刊运行状态、账户及历史任务逐行核验，派生字段和新结构另审；不能只比数量或忽略difference。旧镜像回滚验收也必须PASS。失败只保留副本报告，不运行D。测试容器异常时只停止上面明确命名的隔离容器，不能pkill或重启fanscope-api。

将脱敏结果交回。**此时再次取得本人明确批准，批准对象是本单镜像、维护暂停范围、结构迁移、容器替换及后端通过后的Pages发布。A–C通过也不自动授权D。**

## D. 正式批准后：停止旧服务、迁移、启动后端

本段会短暂停机并修改生产结构。先确认维护窗口，在现有访问入口阻断新写请求、等待在途请求完成；入口维护方式由现网负责人操作，不盲改Nginx/TLS。旧源码checkout和原Compose/env不覆盖。新服务使用原Compose+包内覆盖文件、原project/卷/端口，实际代码来自新镜像。

收到本次明确上线批准后，才在服务器同一终端单独设置 `export FANSCOPE_PRODUCTION_APPROVED=0d38926`。批准前不要设置，下面的检查会安全停止。若更换终端，重新从B设置变量并复核实际状态，不重复创建或覆盖已有锁定文件。

```bash
test "${FANSCOPE_PRODUCTION_APPROVED:-}" = 0d38926 || { echo 'STOP: awaiting explicit approval'; exit 1; }
cd "$BUNDLE"
dc() { sudo -n --preserve-env=FANSCOPE_RELEASE_IMAGE,FANSCOPE_RELEASE_TOOLS docker compose -p deploy -f "$BASE" -f "$BUNDLE/chinese-release.safe.yml" "$@"; }
# 结构/卷审查时不得输出含密钥的完整config；只打印以下字段。
dc config --no-env-resolution --no-interpolate --format json | python3 -c 'import json,sys;d=json.load(sys.stdin);s=d["services"]["fanscope-api"];print({k:s.get(k) for k in ["container_name","command","ports","volumes"]})'
# 确认卷名fanscope_data、目的/app/data、端口127.0.0.1:8787后，才继续。
dc stop fanscope-api
# 这不是备份：只读证明冻结时的实际库，包含快照T后新增的英文/AI/任务。
proof_live() {
  sudo -n docker run --rm --network none --memory 420m --user 0:0 \
    --mount type=volume,source=fanscope_data,target=/data \
    --mount "type=bind,source=$BUNDLE/tools,target=/tools,readonly" \
    --entrypoint node "$NEW_IMAGE" --experimental-sqlite /tools/chinese-release-db-proof.mjs /data/fanscope.sqlite "$@"
}
proof_live > "$BUNDLE/frozen-before.json"
# 要求已有v1.2标记，防止旧库分支隐式另做VACUUM备份；不写入标记。
sudo -n docker run --rm --network none --user 0:0 --mount type=volume,source=fanscope_data,target=/data --entrypoint node "$NEW_IMAGE" --experimental-sqlite --input-type=module -e "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync('/data/fanscope.sqlite',{readOnly:true});if(!d.prepare(\"SELECT 1 FROM schema_migrations WHERE version='1.2'\").get())throw Error('Missing migration baseline; stop');d.close();"
dc run --rm --no-deps -T fanscope-api node --experimental-sqlite --input-type=module -e "globalThis.fetch=async()=>{throw Error('No outbound')};await import('./src/server.mjs');const{db}=await import('./src/db.mjs');db.close();"
# frozen-before.json只读挂载给证明工具；原论文/AI/任务差异不接受。
sudo -n docker run --rm --network none --memory 420m --user 0:0 \
  --mount type=volume,source=fanscope_data,target=/data \
  --mount "type=bind,source=$BUNDLE,target=/release,readonly" \
  --entrypoint node "$NEW_IMAGE" --experimental-sqlite /release/tools/chinese-release-db-proof.mjs /data/fanscope.sqlite /release/frozen-before.json > "$BUNDLE/frozen-after.json"
dc up -d --no-build --no-deps fanscope-api
```

proof_live使用SQLite只读连接、不导入应用、不备份、不修改记录；卷未设文件系统readonly仅为SQLite共享内存/锁所需。任一步失败立即停止，不盲目重跑迁移；使用已验收安全回滚方式。禁止down -v或清空数据库。没有运行普通server CMD，不启动扫描、中文回填、AI或邮件。

## E. 后端健康与数据验收

```bash
dc ps
for attempt in $(seq 1 18); do
  state=$(sudo -n docker inspect --format '{{.State.Health.Status}}' fanscope-api)
  test "$state" = healthy && break
  test "$state" != unhealthy || { echo 'Health failed'; exit 1; }
  sleep 5
done
test "$(sudo -n docker inspect --format '{{.State.Health.Status}}' fanscope-api)" = healthy
sudo -n docker inspect --format '{{.Image}} {{range .Mounts}}{{.Name}} {{.Destination}}{{end}}' fanscope-api
curl --fail --show-error http://127.0.0.1:8787/api/health
curl --fail --show-error 'http://127.0.0.1:8787/api/stats?market=international&period=all&article_type=all'
curl --fail --show-error 'http://127.0.0.1:8787/api/stats?market=chinese&period=all&article_type=all'
curl --fail --show-error http://127.0.0.1:8787/api/chinese-diagnostics
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/admin/chinese-imports/catalog)" = 404
```

health.aiConfigured和emailConfigured=false；镜像ID等于NEW_IMAGE，卷不变；英文与冻结证明一致，AI JSON/任务摘要不变。中文仍应为原生产实际值（本次公开观察为0），没有导入349条。12442/375仅是2026-10-28准备时观察值，不替代冻结基线。检查外部API的CORS和英文列表/详情/研究趋势；本模式不要用真实写请求验证AI关闭。

## F. 后端通过后，本机发布既有Pages项目

```powershell
Set-Location C:\Users\martin\Documents\FanScope-Dev
$ReleaseRoot=(Get-Content work/release-readiness/active-release-root.txt -Raw).Trim()
$Wrangler='C:\Users\martin\AppData\Local\npm-cache\_npx\32026684e21afda6\node_modules\wrangler\bin\wrangler.js'
$env:WRANGLER_SEND_METRICS='false'
$env:CI='true'
$env:CLOUDFLARE_ACCOUNT_ID='6814aab23baa7509d3cc00a650b07ca9'
node $Wrangler pages deployment list --project-name fanscope --environment production --json
# 确认当前生产仍为e709；若已变，停止并重新记录回滚点。
node "$ReleaseRoot/source/scripts/verify-pages-release.mjs" "$ReleaseRoot/pages"
if ($LASTEXITCODE -ne 0) { throw '静态包复核失败' }
# 仅另次明确批准、后端验收通过后执行下一行。
node $Wrangler pages deploy "$ReleaseRoot/pages" --project-name fanscope --branch main --commit-hash 0d3892608c3d07b9c9cbcb03eb07896418cbbd66 --commit-dirty=true
if ($LASTEXITCODE -ne 0) { throw 'Pages发布失败，停止并评估回滚' }
Invoke-RestMethod https://fanscope-api.adapttochina.com/api/health
```

不新建项目，不依赖GitHub，不发布仓库根目录。26个静态文件已经排除管理工作台/模板、数据库及敏感资料；commit-dirty表示安全包变换，应用源码本身为干净0d38926。发布后1440/390px核验英文搜索/详情、中文真实数量与来源状态、趋势分母、原文链接、工作台404，无页面错误/横向溢出。完成后提供截图；本轮准备不冒称生产新版本已验收。

## G. 故障回滚（同样需要明确批准）

前端优先回到既有生产e709。使用已有会话，不登录或获取新Token：

```powershell
# 本机PowerShell，必须仍在正确Cloudflare账户；这是生产变更，待批准。
Start-Process 'https://dash.cloudflare.com/6814aab23baa7509d3cc00a650b07ca9/pages/view/fanscope'
```

在部署记录选e709f071-5c27-4e46-9b88-3b5b58b48988并使用Rollback to this deployment确认；不使用Preview，不删除部署。选择后核对fanscope.pages.dev/app.js SHA256应为552a690e9a3a6387574dde706fac6a0fd6f6df0a6018425270f89df36ff57053。Wrangler4.149.0本身没有pages rollback命令，不编造CLI；若需要API自动回滚，另行锁定请求与批准。

后端使用C已验证的旧镜像和安全HTTP包装，保留当前持久库，不切回普通worker CMD：

收到针对回滚的明确批准后，才设置 `export FANSCOPE_ROLLBACK_APPROVED=0d38926`，再执行下段。

```bash
test "${FANSCOPE_ROLLBACK_APPROVED:-}" = 0d38926 || { echo 'Awaiting rollback approval'; exit 1; }
export FANSCOPE_RELEASE_TOOLS="$BUNDLE/tools"
sudo -n --preserve-env=FANSCOPE_RELEASE_IMAGE,FANSCOPE_RELEASE_TOOLS docker compose -p deploy -f "$BASE" -f "$BUNDLE/chinese-release.safe.yml" -f "$BUNDLE/rollback-safe.yml" up -d --no-build --no-deps fanscope-api
sudo -n docker inspect --format '{{.Image}} {{.State.Health.Status}}' fanscope-api
curl --fail --show-error http://127.0.0.1:8787/api/health
```

预期旧镜像56cc...、Healthy、付费配置关闭、写入503，原卷保留。若旧镜像/当前库不兼容，禁止自动将快照覆盖现库；保留升级现场及原卷，另行批准把锁定backup.sqlite恢复为同卷中的新文件名，再改变DATABASE_PATH。这样原库/WAL与备份都不被覆盖；需要明确处理快照T后新增论文/任务，不能宣称无损回到T。数据回滚不在本轮代码发布批准中自动包含。

禁止docker compose down -v、docker volume rm、清空表、部署本地349条库、读取/打印.env密钥。部署是否GO最终取决于B/C实际结果与本人对D/F的明确批准。
