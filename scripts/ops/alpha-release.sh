#!/usr/bin/env bash
# FanScope host setup from the server console. Releases then run from GitHub Actions
# (backend-release.yml) and fanscope-pull.timer; this file never releases anything.
#
#   sudo bash alpha-release.sh plan <full-sha>        verified backup, image build and
#                                                     migration dry run; no production change
#   sudo bash alpha-release.sh bootstrap <full-sha>   one-time: controller, nginx gate, GitHub
#                                                     read token, timer
#
# bootstrap does not touch the database or any container. nginx is reloaded gracefully,
# and the gate test closes FanScope's API (not /api/health) for under a second.
set -euo pipefail

ACTION=${1:-}; SHA=${2:-}
REPO=https://github.com/MartinZhong2026/FanScope.git
API=https://fanscope-api.adapttochina.com
DOMAIN=fanscope-api.adapttochina.com
WORK=${ALPHA_WORK:-/opt/fanscope-alpha}
SRC=$WORK/src
DEPLOY_DIR=${ALPHA_DEPLOY_DIR:-/home/ubuntu/fanscope}
ENV_FILE=$DEPLOY_DIR/api/.env
BACKUPS=${ALPHA_BACKUPS:-/var/backups/fanscope-alpha}
BUNDLE=$WORK/bundle-$SHA
KEY_NAME=FANSCOPE_DIAGNOSTIC_DEEPSEEK_API_KEY
WORKFLOW=backend-release.yml

say(){ printf '\n== %s\n' "$*"; }
die(){ printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
[[ $ACTION =~ ^(plan|bootstrap)$ ]] || die 'Usage: alpha-release.sh plan|bootstrap <full-sha>'
[[ $SHA =~ ^[a-f0-9]{40}$ ]] || die 'A full 40-character commit SHA is required'
[ -n "${ALPHA_TEST:-}" ] || [ "$(id -u)" -eq 0 ] || die 'Run with sudo'

fetch_source(){
  say "Source $SHA"
  mkdir -p "$WORK"
  [ -d "$SRC/.git" ] || git clone -q --filter=blob:none "$REPO" "$SRC"
  git -C "$SRC" fetch -q origin main
  git -C "$SRC" merge-base --is-ancestor "$SHA" origin/main || die 'Commit is not on main; merge it first'
  git -C "$SRC" checkout -q --detach "$SHA"
}

database(){
  [ -n "${ALPHA_DB:-}" ] && { echo "$ALPHA_DB"; return; }
  echo "$(docker volume inspect fanscope_data --format '{{.Mountpoint}}')/fanscope.sqlite"
}

check_host(){
  say 'Host checks'
  [ -n "${ALPHA_TEST:-}" ] && return
  [ -f "$DEPLOY_DIR/deploy/docker-compose.yml" ] || die "Compose file missing under $DEPLOY_DIR (set ALPHA_DEPLOY_DIR)"
  [ -f "$ENV_FILE" ] || die "Missing $ENV_FILE"
  [ "$(docker inspect fanscope-api --format '{{json .Config.Cmd}}')" = '["node","--experimental-sqlite","src/v14-server.mjs"]' ] \
    || die 'Running API is not the V1.4 entry; send this output to the engineer before continuing'
  [ "$(docker inspect fanscope-api --format '{{index .Config.Labels "com.docker.compose.project"}}')" = deploy ] || die 'Unexpected Compose project'
  [ ! -e /var/lib/fanscope-cd/maintenance ] && [ ! -e /var/lib/fanscope-cd/transaction.json ] || die 'Unfinished release state; do not continue'
  [ "$(df --output=avail -BG /var/lib/docker | tail -1 | tr -dc 0-9)" -ge 5 ] || die 'Less than 5 GB free for Docker'
  python3 -c 'import sys;sys.exit(sys.version_info<(3,11))' || die 'Python 3.11+ required'
  docker ps --format '{{.Names}}' | sort > "$WORK/containers-before.txt"
  echo "Other containers running: $(grep -vc '^fanscope-api$' "$WORK/containers-before.txt" || true)"
  free -m | sed -n 2p
}

ensure_key(){
  say 'DeepSeek key'
  [ -n "${ALPHA_TEST:-}" ] && return
  if grep -Eq "^$KEY_NAME=.+" "$ENV_FILE"; then echo 'Dedicated key already configured.'; else
    [ -t 0 ] || die "Run from an interactive console to enter $KEY_NAME"
    read -rsp "Paste the dedicated DeepSeek key (input hidden): " KEY; echo
    [[ $KEY =~ ^[A-Za-z0-9_-]{20,}$ ]] || die 'That does not look like an API key; nothing was saved'
    sed -i '/^FANSCOPE_DIAGNOSTIC_/d' "$ENV_FILE"
    printf 'FANSCOPE_DIAGNOSTIC_ENABLED=true\nFANSCOPE_DIAGNOSTIC_PROVIDER=deepseek\n%s=%s\n' "$KEY_NAME" "$KEY" >> "$ENV_FILE"
    unset KEY
    echo "Saved to $ENV_FILE. The running service is not affected until release."
  fi
}

ensure_scheduler(){
  say 'Background updates and source reachability'
  grep -q '^FANSCOPE_SCHEDULER=' "$ENV_FILE" || printf 'FANSCOPE_SCHEDULER=true\n' >> "$ENV_FILE"
  grep '^FANSCOPE_SCHEDULER=' "$ENV_FILE"
  # Information only: a blocked source shows up in /api/ingest/freshness after release.
  for url in https://rkyj.ruc.edu.cn/robots.txt https://www.society.shu.edu.cn/robots.txt https://shjs.ruc.edu.cn/robots.txt https://www.sciopen.com/robots.txt https://api.crossref.org/journals/2096-7713; do
    printf '%s %s\n' "$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$url" || true)" "$url"
  done
}

verified_backup(){
  say 'Consistent backup and restore verification'
  mkdir -p "$BACKUPS"; chmod 700 "$BACKUPS"
  BACKUP_DIR=$BACKUPS/$(date -u +%Y%m%dT%H%M%SZ)
  PYTHONPATH=$SRC/scripts/cicd python3 - "$(database)" "$BACKUP_DIR" <<'PY'
import json,sys
import sqlite_release as s
r=s.backup(sys.argv[1],sys.argv[2]);m=r['manifest']['tables']
print(json.dumps({'integrity':r['integrity'],'foreignKeys':r['foreignKeys'],'restoreVerified':r['restorable'],'sha256':r['sha256'],'tables':len(m),
 'articles':m.get('articles',{}).get('count'),'labUsers':m.get('lab_users',{}).get('count')}))
PY
  echo "$BACKUP_DIR" > "$WORK/last-backup.txt"
  echo "Backup: $BACKUP_DIR/backup.sqlite"
}

build_bundle(){
  say 'Build image'
  docker build -q --label "org.opencontainers.image.revision=$SHA" --build-arg "FANSCOPE_COMMIT=$SHA" \
    -t "fanscope-api:$SHA" -f "$SRC/api/Dockerfile" "$SRC/api" >/dev/null
  rm -rf "$BUNDLE"; mkdir -p "$BUNDLE"
  docker run --rm --network none --entrypoint node "fanscope-api:$SHA" --experimental-sqlite src/migrate-cli.mjs lint > "$WORK/lint.json"
  DIAGNOSTIC=false; SCHEDULER=false
  if [ -n "${ALPHA_TEST:-}" ] || grep -q '^FANSCOPE_SCHEDULER=true' "$ENV_FILE"; then SCHEDULER=true; fi
  if [ -n "${ALPHA_TEST:-}" ] || grep -Eq "^$KEY_NAME=.+" "$ENV_FILE"; then DIAGNOSTIC=true; fi
  python3 - "$SHA" "$(docker image inspect "fanscope-api:$SHA" --format '{{.Id}}')" "$DIAGNOSTIC" "$SCHEDULER" "$WORK/lint.json" "$BUNDLE/manifest.json" <<'PY'
import json,sys
sha,image,diagnostic,scheduler,lint,out=sys.argv[1:]
data=json.load(open(lint)); assert data['ok'],'migration lint failed'
items=[{k:m[k] for k in ('id','checksum','declared')} for m in data['migrations']]
json.dump({'commit':sha,'image':image,'migrationPolicy':'additive' if items else 'no-change','migrations':items,
           'diagnosticAiEnabled':diagnostic=='true','schedulerEnabled':scheduler=='true'},open(out,'w'))
PY
  docker save "fanscope-api:$SHA" -o "$BUNDLE/image.tar"
  (cd "$BUNDLE" && sha256sum image.tar manifest.json > SHA256SUMS)
  PYTHONPATH=$SRC/scripts/cicd python3 -c "
import sys;from pathlib import Path;import deploy_backend as d
d.verify_bundle(Path(sys.argv[1]),sys.argv[2]);print('Bundle verified')" "$BUNDLE" "$SHA"
}

dry_run_migrations(){
  say 'Migration dry run on the backup copy'
  EXPECT=$(python3 -c "import json,sys;print(','.join(m['id']+':'+m['checksum'] for m in json.load(open(sys.argv[1]))['migrations']))" "$BUNDLE/manifest.json")
  STATUS=$(docker run --rm --network none --user 0:0 --mount "type=bind,source=$BACKUP_DIR,target=/app/data" -e DATABASE_PATH=/app/data/restore.sqlite -e FANSCOPE_LOG_DIR=/tmp/logs \
    --entrypoint node "fanscope-api:$SHA" --experimental-sqlite src/migrate-cli.mjs status) || { echo "$STATUS"; die 'Migration status failed'; }
  echo "$STATUS" | python3 -c "import json,sys;d=json.load(sys.stdin);print('status:',d['status'],'pending:',[p['id'] for p in d['pending']])"
  docker run --rm --network none --user 0:0 --mount "type=bind,source=$BACKUP_DIR,target=/app/data" -e DATABASE_PATH=/app/data/restore.sqlite -e FANSCOPE_LOG_DIR=/tmp/logs \
    --entrypoint node "fanscope-api:$SHA" --experimental-sqlite src/migrate-cli.mjs apply --dry-run --expect "$EXPECT" >/dev/null \
    || die 'Migration dry run failed; nothing was changed'
  echo 'Dry run passed and rolled back.'
}

summary(){
  say 'Ready for approval'
  cat <<EOF
Release:   $SHA
Backup:    $(cat "$WORK/last-backup.txt")/backup.sqlite
Image:     fanscope-api:$SHA
Previous:  $(docker inspect fanscope-api --format '{{.Image}}' 2>/dev/null || echo unknown)
No production change has been made.
EOF
}

install_controller(){
  say 'Install controller'
  MODE=install; [ -d /opt/fanscope-cd ] && MODE=upgrade
  bash "$SRC/deploy/cicd/install-host.sh" "$MODE" >/dev/null
  echo "Controller $MODE done."
}

ensure_gate(){
  say 'nginx maintenance gate'
  python3 /opt/fanscope-cd/scripts/cicd/nginx_gate.py --backup-dir "$WORK/nginx-before-$(date -u +%Y%m%dT%H%M%SZ)"
}

ensure_token(){
  say 'GitHub read token'
  TOKEN_FILE=/etc/fanscope-cd/github-token
  if [ ! -s "$TOKEN_FILE" ]; then
    [ -t 0 ] || die 'Run from an interactive console to enter the token'
    read -rsp 'Paste the fine-grained token (Actions read, Contents read; input hidden): ' TOKEN; echo
    (umask 077; printf '%s' "$TOKEN" > "$TOKEN_FILE.new")
    unset TOKEN
  else
    cp -p "$TOKEN_FILE" "$TOKEN_FILE.new"
  fi
  # Pins the workflow and the next run number; never prints the token.
  python3 - "$TOKEN_FILE.new" "$WORKFLOW" <<'PY' || { rm -f "$TOKEN_FILE.new"; die 'GitHub rejected the token; nothing was saved'; }
import json,sys,urllib.request
token=open(sys.argv[1]).read().strip()
def api(path):
    request=urllib.request.Request('https://api.github.com/repos/MartinZhong2026/FanScope'+path,
        headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
    with urllib.request.urlopen(request,timeout=30) as response:
        return json.load(response)
workflow=api('/actions/workflows/'+sys.argv[2])
runs=api(f"/actions/workflows/{workflow['id']}/runs?per_page=1")['workflow_runs']
config={'enabled':True,'workflow_id':workflow['id'],'first_run_number':(runs[0]['run_number'] if runs else 0)+1}
json.dump(config,open('/etc/fanscope-cd/config.json','w'))
print('Config:',config)
PY
  mv "$TOKEN_FILE.new" "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE" /etc/fanscope-cd/config.json
}

start_timer(){
  say 'Pull timer'
  systemctl daemon-reload
  systemctl enable --now fanscope-pull.timer >/dev/null
  # One real poll with the production service sandbox; finds nothing to release yet.
  systemctl start fanscope-pull.service || { journalctl -u fanscope-pull.service -n 20 --no-pager; die 'Pull service failed'; }
  # Same sandbox for the Compose call a release will make.
  systemd-run --quiet --wait --collect -p ProtectHome=read-only -p ProtectSystem=full -p NoNewPrivileges=true \
    --setenv=FANSCOPE_RELEASE_IMAGE=sha256:check docker compose -p deploy -f "$DEPLOY_DIR/deploy/docker-compose.yml" \
    -f /opt/fanscope-cd/deploy/cicd/production.yml config -q || die 'Compose check failed under the service sandbox'
  systemctl is-active fanscope-pull.timer
  rm -rf "$WORK"/bundle-*
  echo 'Host is ready. Releases now start from GitHub Actions.'
}

fetch_source
check_host
if [ "$ACTION" = plan ]; then
  ensure_key
  verified_backup
  build_bundle
  dry_run_migrations
  summary
else
  ensure_key
  ensure_scheduler
  install_controller
  ensure_gate
  ensure_token
  start_timer
fi
