#!/usr/bin/env bash
# R0 read-only preflight. Run on the server from the Tencent Cloud console:
#   sudo bash r0-preflight.sh > r0-preflight.txt 2>&1
# Changes nothing in production. Prints facts only: no env values, tokens, keys
# or paper text. With --restore-check it also writes one verified SQLite backup
# plus an isolated restore under /var/tmp (read-only on the production database).
set -u
INVENTORY=$(dirname -- "${BASH_SOURCE[0]}")/readonly-inventory.mjs
section(){ printf '\n=== %s ===\n' "$1"; }

section host
date -u +%FT%TZ; uname -r; . /etc/os-release; echo "$PRETTY_NAME"; df -h / /var/lib/docker 2>/dev/null; free -m | head -2

section containers
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker inspect fanscope-api --format 'cmd={{json .Config.Cmd}} user={{.Config.User}} project={{index .Config.Labels "com.docker.compose.project"}} service={{index .Config.Labels "com.docker.compose.service"}} revision={{index .Config.Labels "org.opencontainers.image.revision"}} image={{.Image}} restart={{.RestartCount}}'
docker inspect fanscope-api --format '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'
docker volume inspect fanscope_data --format 'volume={{.Name}} mountpoint={{.Mountpoint}}'
du -h "$(docker volume inspect fanscope_data --format '{{.Mountpoint}}')"/fanscope.sqlite* 2>/dev/null

section controller
ls -ld /opt/fanscope-cd /var/lib/fanscope-cd /etc/fanscope-cd 2>&1
ls -l /var/lib/fanscope-cd/maintenance /var/lib/fanscope-cd/transaction.json /var/lib/fanscope-cd/runtime 2>&1
python3 -c "import json;c=json.load(open('/etc/fanscope-cd/config.json'));print({k:c.get(k) for k in ('enabled','workflow_id','first_run_number')})" 2>&1
test -s /etc/fanscope-cd/github-token && echo 'github-token: present' || echo 'github-token: MISSING'
systemctl is-enabled fanscope-pull.timer 2>&1; systemctl is-active fanscope-pull.timer 2>&1
ls -1t /var/lib/fanscope-cd/backups 2>/dev/null | head -5

section nginx
nginx -t 2>&1 | tail -2
nginx -T 2>/dev/null | grep -nE 'fanscope-cd/maintenance|client_max_body_size|server_name|proxy_read_timeout' | head -20

section backups
echo 'Off-host encrypted backup is NOT provable from here. Recent local copies and jobs:'
crontab -l 2>/dev/null | grep -iE 'backup|sqlite|fanscope' ; ls /etc/cron.d 2>/dev/null
systemctl list-timers --all --no-pager 2>/dev/null | grep -iE 'backup|fanscope'
find / -xdev \( -name '*.sqlite*' -o -name '*fanscope*backup*' \) -not -path '/proc/*' -not -path '/var/lib/docker/overlay2/*' -mtime -3 -printf '%TY-%Tm-%Td %s %p\n' 2>/dev/null | head -20

section logs
docker inspect fanscope-api --format 'logdriver={{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}'
du -sh /var/lib/docker/containers 2>/dev/null

section inventory
if [ -f "$INVENTORY" ]; then
  docker exec -i fanscope-api node --experimental-sqlite --input-type=module - < "$INVENTORY"
else
  echo "readonly-inventory.mjs not found next to this script"
fi

if [ "${1:-}" = --restore-check ]; then
  section restore-check
  OUT=/var/tmp/fanscope-r0-$(date -u +%Y%m%dT%H%M%SZ)
  SQLITE_RELEASE=$(dirname -- "${BASH_SOURCE[0]}")/../cicd
  DB="$(docker volume inspect fanscope_data --format '{{.Mountpoint}}')/fanscope.sqlite"
  (umask 077; PYTHONPATH="$SQLITE_RELEASE" python3 -c "
import json,sys,sqlite_release as s
r=s.backup(sys.argv[1],sys.argv[2]);m=r['manifest']
print(json.dumps({'integrity':r['integrity'],'foreignKeys':r['foreignKeys'],'restorable':r['restorable'],'sha256':r['sha256'],'tables':len(m['tables']),'rows':sum(t['count'] for t in m['tables'].values())}))
" "$DB" "$OUT")
  echo "Verified copy kept in $OUT (mode 0700). It contains private data: copy off-host encrypted, or delete it."
fi
