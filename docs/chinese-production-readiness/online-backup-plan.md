# 在线一致性备份与隔离恢复验收方案（待批准，未执行）

2026-10-28，Asia/Taipei。基于分支feat/chinese-release-blockers、提交0d38926。本人提供的已核实条件：API容器fanscope-api Healthy，Compose位于/home/ubuntu/fanscope/deploy/docker-compose.yml，数据卷fanscope_data，数据库/app/data/fanscope.sqlite约43MB，空闲磁盘约29GB。以下为将来获批后的命令，**本轮没有执行任何服务器操作**。

## 方法与验收口径

使用Python标准库sqlite3.Connection.backup（SQLite Online Backup API），每次128页，批次间主动等待20ms；源连接mode=ro、query_only，不执行生产写SQL、不改变journal_mode、不checkpoint、不导入FanScope模块。旧chinese-release-backup.mjs采用VACUUM INTO，这次不调用它。

先建立WAL只读事务并固定一个已提交快照T，从同一连接计算全部表的记录数和完整行SHA256，再调用backup。这样生产继续写入时，备份和源端证据仍属于同一快照，不用前后两个时刻的数量硬比较。源连接在备份完成后立即关闭，再对备份及恢复副本执行完整性检查。快照T后提交的新增数据不属于此备份，报告明确记录snapshotAt（UTC）；它不是备份完成时间。

备份仅包含SQLite中的内容，不包含磁盘上的文档附件、Docker配置或密钥；不能单凭本方案声称全站灾难恢复已完成。没有启动旧/新应用，没有迁移验证，也不证明任意旧镜像兼容性。

实现见scripts/chinese-online-backup.py：新目录必须不存在，权限700，文件600；拒绝既有目标，失败无自动重试。源端需要既有WAL和SHM且实际journal_mode=wal，否则停止，不改生产设置。SQLite正常读取仍使用共享内存/锁协调；“源只读”不是零文件系统影响或零资源成本的承诺。

## 0. 工具准备（本人批准后才传输）

本机PowerShell检查源码并计算工具哈希，不使用GitHub：

```powershell
Set-Location C:\Users\martin\Documents\FanScope-Dev
git branch --show-current
git rev-parse --short HEAD
Get-FileHash scripts/chinese-online-backup.py -Algorithm SHA256
```

预期分支feat/chinese-release-blockers、HEAD 0d38926；备份方案和工具目前是新增本地文件，尚未提交，不属于该旧提交。记录脚本实际SHA256，后续逐字比较，不使用占位哈希。

服务器已有登录终端：

```bash
set -euo pipefail
umask 077
TOOLS_DIR=$(mktemp -d /home/ubuntu/fanscope-backup-tools.XXXXXXXX)
printf '%s\n' "$TOOLS_DIR"
```

预期创建一个全新、随机后缀、权限700的工具目录。本人将其路径填入下一条本机命令，**下一条是传输，不是只读检查，必须待批准**：

```powershell
scp -o StrictHostKeyChecking=yes scripts/chinese-online-backup.py ubuntu@43.133.108.137:/home/ubuntu/fanscope-backup-tools.REPLACE_WITH_ACTUAL_SUFFIX/
```

连接失败立即停止，不重试密码、不发送密钥。也可由本人使用现有已认证文件传输渠道传入同一份脚本。不要上传.env、数据库或整个仓库。

## 1. 服务器前置检查（同一终端保留变量）

```bash
cd /home/ubuntu/fanscope
sudo -n docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' fanscope-api
sudo -n docker inspect --format '{{range .Mounts}}{{printf "%s %s %s %s\n" .Type .Name .Source .Destination}}{{end}}' fanscope-api
VOL_ROOT=$(sudo -n docker volume inspect --format '{{.Mountpoint}}' fanscope_data)
SOURCE_DB="$VOL_ROOT/fanscope.sqlite"
sudo -n test -f "$SOURCE_DB"
sudo -n test -f "$SOURCE_DB-wal"
sudo -n test -f "$SOURCE_DB-shm"
sudo -n stat -c '%s %n' "$SOURCE_DB" "$SOURCE_DB-wal" "$SOURCE_DB-shm"
df -h /home/ubuntu
free -m
python3 -c 'import sys,sqlite3; print(sys.version.split()[0],sqlite3.sqlite_version,hasattr(sqlite3.Connection,"backup"))'
command -v timeout nice ionice vmstat curl sha256sum
sha256sum "$TOOLS_DIR/chinese-online-backup.py"
```

预期running healthy；实际Mounts必须是volume fanscope_data、目的/app/data，Source与VOL_ROOT完全相同；主文件约43MB，WAL/SHM已存在；Python支持backup=True；工具SHA与本机一致。任何路径、挂载类型、哈希不符即停止。不要猜挂载路径、安装运行时、更改权限或直接输出完整docker inspect/环境变量。

## 2. 建立资源/服务基线

在第二个已登录终端运行，持续到整个验收结束：

```bash
# 先观察至少60秒；Ctrl+C仅终止此观察命令。
vmstat 5
```

第三终端按需重复以下只读命令；不读取应用日志原文，避免日志中出现敏感信息：

```bash
sudo -n docker stats --no-stream --format '{{.Name}} CPU={{.CPUPerc}} MEM={{.MemUsage}} IO={{.BlockIO}}' fanscope-api
free -m
df -h /home/ubuntu
curl --max-time 5 --fail --silent --show-error --output /dev/null --write-out 'HTTP=%{http_code} seconds=%{time_total}\n' http://127.0.0.1:8787/api/health
```

预期HTTP200、延迟稳定，容器Healthy，记录CPU/MEM/可用内存/空闲磁盘及vmstat的wa、bi/bo基线。既有应用监控若提供SQLite busy/locked计数，记录其基线；没有该指标不能声称已验证所有生产写延迟。**不向生产插入测试数据，也不调用扫描、AI或管理写接口。**

建议起跑门槛：可用内存至少512MiB、空闲磁盘至少2GiB、服务健康、无已有持续IO拥堵。29GB是已提供值，执行当天仍须实测。

## 3. 在线备份与隔离恢复（执行一次，不循环）

```bash
# 创建私有备份根目录不触碰生产卷；每次RUN_DIR必须全新且不存在。
BACKUP_ROOT=/home/ubuntu/fanscope-private-backups
test ! -L "$BACKUP_ROOT"
if test ! -e "$BACKUP_ROOT"; then mkdir -m 700 "$BACKUP_ROOT"; fi
test "$(stat -c %a "$BACKUP_ROOT")" = 700
RUN_DIR="/home/ubuntu/fanscope-private-backups/online-$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import secrets; print(secrets.token_hex(6))')"
test ! -e "$RUN_DIR"
printf 'RUN_DIR=%s\n' "$RUN_DIR"
sudo -n timeout --signal=INT --kill-after=5s 120s nice -n 10 ionice -c 2 -n 7 python3 "$TOOLS_DIR/chinese-online-backup.py" "$SOURCE_DB" "$RUN_DIR"
```

脚本以权限600创建backup.sqlite；不是cp正在写的源文件。源快照总预算60秒，单次备份128页；每批监控磁盘和WAL增长。备份完成释放源读事务。随后只在隔离备份执行PRAGMA integrity_check、foreign_key_check及全表比较；复制**已关闭且完整的备份**到新restore.sqlite并fsync，再次检查及逐表比较。该复制对象不是在线生产文件。外层120秒硬期限覆盖恢复和检查。仅备份助手使用低CPU/IO优先级，不改变API容器设置；ionice对实际存储调度器的限流效果须观察，不能保证固定带宽。

成功退出码0，最后一行应类似：

```json
{"status":"PASS","snapshotAt":"<UTC>","elapsedSeconds":12.3,"integrity":"ok","foreignKeyViolations":0,"allTablesAndSchemaMatch":true,"fileSha256":{"backup.sqlite":"<SHA>","restore.sqlite":"<相同SHA>"}}
```

示例12.3不是性能承诺。任何非0退出、超时、STOP或缺verified.json都不能验收；不要继续执行下阶段，也不覆盖/删除半成品。

## 4. 查看证据（不输出论文内容或密钥）

```bash
sudo -n python3 - "$RUN_DIR/verified.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
print({k:r[k] for k in ['status','snapshotAt','elapsedSeconds','integrity','foreignKeyViolations','allTablesAndSchemaMatch','fileSha256']})
print('关键数量',r['manifest']['keyCounts'])
for name,proof in r['manifest']['tables'].items():
    print(name,proof['count'],proof['sha256'])
PY
sudo -n sha256sum "$RUN_DIR/backup.sqlite" "$RUN_DIR/restore.sqlite"
sudo -n stat -c '%a %s %n' "$RUN_DIR" "$RUN_DIR/backup.sqlite" "$RUN_DIR/restore.sqlite" "$RUN_DIR/verified.json"
sudo -n docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' fanscope-api
curl --max-time 5 --fail --silent --show-error --output /dev/null --write-out 'HTTP=%{http_code} seconds=%{time_total}\n' http://127.0.0.1:8787/api/health
df -h /home/ubuntu
free -m
```

预期PASS、integrity=ok、foreignKeyViolations=0、全表和schema相同、两个文件SHA相同；目录700、文件600。报告keyCounts包含english、aiJsonPresent、analyzed、jobs实际数量；所有表完整行摘要覆盖英文论文原字段、AI JSON/摘要/状态，以及jobs、analysis_batches等实际存在的历史任务表和其他表，没有排除派生字段或meta。若生产本来有非零AI/历史记录而快照为零，停止并核对真实库；不采用历史10803/375作为本次固定期望。

只在相同快照T比较源、备份和恢复。验收后的在线生产数量可能继续增加，不能因此判丢失；同样不能拿“数量相等”替代原字段摘要相等。只提供脱敏报告及监控汇总，不发送备份数据库或表内容到聊天、Git或Pages。

## 安全停止条件与处置

| 条件 | 动作 |
|---|---|
| 授权/工具/源路径/卷/哈希不匹配，Python缺backup，WAL/SHM缺失或非WAL | 不开始；不安装工具、不改journal_mode、不猜路径或连接其他库。 |
| 已有目标目录/文件、权限异常 | 不覆盖；停止，重新审批新的独立路径。 |
| 源读事务超过60秒、WAL增长超过128MiB、磁盘低于2GiB、busy/locked/error | 助手自动中止，无自动重试；保留私有半成品和错误，释放连接。 |
| HTTP连续2次失败；延迟连续3次超过max(2秒,基线3倍)；容器变Unhealthy | 人工立即停止助手，先恢复正常负载观察，不重启容器。 |
| MemAvailable低于256MiB，API内存接近其限制；IO wait持续超过20%且比基线增加10个百分点；CPU持续超过85%约30秒 | 人工停止助手；这些是保守操作阈值，不是自动监控承诺。 |
| 外层超过120秒或助手异常退出 | 该轮不接受；只保留文件，不继续恢复步骤或直接重跑。 |
| integrity不是唯一ok、外键不为0、任一表/字段摘要或文件SHA不同 | 标为FAIL，保留证据；不修复源库、不迁移、不把恢复副本放回生产。 |

观察备份助手CPU/RSS或主动停止时，在第二终端手动设置主终端打印的本轮RUN_DIR（不要猜历史目录），读取本轮PID。先核对进程命令和路径，再只向备份助手发SIGINT：

```bash
BACKUP_PID=$(sudo -n cat "$RUN_DIR/pid")
sudo -n ps -p "$BACKUP_PID" -o pid=,etime=,%cpu=,rss=,args=
# 必须看到本轮chinese-online-backup.py、SOURCE_DB及RUN_DIR全部匹配，才执行下一行。
sudo -n kill -INT "$BACKUP_PID"
```

若进程已退出，不发信号；禁止kill容器主进程或宽泛pkill。SIGINT/timeout关闭只读连接并回滚源读事务，生产数据不回滚；失败目标保留为未验收文件，不自动清理。WAL可能被延迟回收，助手退出后让正常应用自行处理，不手工checkpoint、截断或删除WAL。

## 本轮本地证据及参考

仅用本机合成SQLite和并发写线程验证：在线备份、完整性与全表摘要比较、独立恢复及既有目录拒绝通过；合成11英文/3AI不计入真实论文数量。没有运行生产命令，未新增Git提交。原349条库不参与本方案。

依据：[SQLite Online Backup API](https://www.sqlite.org/backup.html)、[Python sqlite3.backup](https://docs.python.org/3.11/library/sqlite3.html#sqlite3.Connection.backup)、[SQLite快照隔离](https://www.sqlite.org/isolation.html)、[WAL与检查点](https://www.sqlite.org/wal.html)。60秒快照会延缓旧WAL回收，所以必须监测WAL和磁盘。本方案待明确批准后执行；成功也只解除SQLite备份/恢复这一项阻碍，不自动授权部署、迁移、中文数据公开或后台任务恢复。
