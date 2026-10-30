#!/usr/bin/env bash
# FanScope Alpha release from the server console. Builds the exact commit here
# and hands it to the reviewed controller (deploy_backend.py), which keeps its
# frozen backup, rehearsal, migration checks and automatic rollback.
#
#   sudo bash alpha-release.sh plan <full-sha>                  no production change
#   sudo bash alpha-release.sh deploy <full-sha> <full-sha>     real release, needs approval
#
# plan: stores the DeepSeek key if missing (prompted, never echoed), makes a verified
# SQLite backup and restore, builds the image, dry-runs the migrations on the copy.
# deploy: installs the controller, the nginx gate if absent, then releases.
# Touches only fanscope-api, its volume and the FanScope nginx server block.
set -euo pipefail

ACTION=${1:-}; SHA=${2:-}; CONFIRM=${3:-}
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
GATE_MARKER='if (-f /var/lib/fanscope-cd/maintenance)'

say(){ printf '\n== %s\n' "$*"; }
die(){ printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
[[ $ACTION =~ ^(plan|deploy)$ ]] || die 'Usage: alpha-release.sh plan|deploy <full-sha> [<full-sha>]'
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
  DIAGNOSTIC=false
  if [ -n "${ALPHA_TEST:-}" ] || grep -Eq "^$KEY_NAME=.+" "$ENV_FILE"; then DIAGNOSTIC=true; fi
  python3 - "$SHA" "$(docker image inspect "fanscope-api:$SHA" --format '{{.Id}}')" "$DIAGNOSTIC" "$WORK/lint.json" "$BUNDLE/manifest.json" <<'PY'
import json,sys
sha,image,diagnostic,lint,out=sys.argv[1:]
data=json.load(open(lint)); assert data['ok'],'migration lint failed'
items=[{k:m[k] for k in ('id','checksum','declared')} for m in data['migrations']]
json.dump({'commit':sha,'image':image,'migrationPolicy':'additive' if items else 'no-change','migrations':items,
           'diagnosticAiEnabled':diagnostic=='true','schedulerEnabled':False},open(out,'w'))
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
No production change has been made. Send this output to the engineer.
EOF
}

install_controller(){
  say 'Install controller (timer stays off)'
  MODE=install; [ -d /opt/fanscope-cd ] && MODE=upgrade
  bash "$SRC/deploy/cicd/install-host.sh" "$MODE" >/dev/null
  echo "Controller $MODE done."
}

ensure_nginx_gate(){
  say 'nginx maintenance gate'
  if nginx -T 2>/dev/null | grep -qF "$GATE_MARKER"; then echo 'Already installed.'; else
    mapfile -t FILES < <(grep -rlE "server_name[^;]*$DOMAIN" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | xargs -r -n1 realpath | sort -u)
    [ "${#FILES[@]}" -eq 1 ] || die "Expected one nginx file for $DOMAIN, found ${#FILES[@]}: ${FILES[*]:-none}"
    CONF=${FILES[0]}; SAVED=$WORK/nginx-before-$(date -u +%Y%m%dT%H%M%SZ).conf
    cp -p "$CONF" "$SAVED"
    install -m 0644 "$SRC/deploy/cicd/nginx-maintenance.conf" /etc/nginx/fanscope-maintenance.conf
    sed -i -E "/server_name[^;]*$DOMAIN/a\\    include /etc/nginx/fanscope-maintenance.conf;" "$CONF"
    if ! nginx -t >/dev/null 2>&1; then cp -p "$SAVED" "$CONF"; die 'nginx rejected the gate; original restored'; fi
    systemctl reload nginx
    echo "Gate added to $CONF (saved copy: $SAVED)."
  fi
  touch /var/lib/fanscope-cd/maintenance
  STATS=$(curl -s -o /dev/null -w '%{http_code}' -H 'Cache-Control: no-cache' "$API/api/stats?cicd=maintenance" || true)
  HEALTH=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/health" || true)
  rm -f /var/lib/fanscope-cd/maintenance
  [ "$STATS" = 503 ] && [ "$HEALTH" = 200 ] || die "Gate test failed (stats $STATS, health $HEALTH); nothing released"
  echo 'Gate test passed: stats 503, health 200.'
}

release(){
  say "Release $SHA"
  [ -f "$BUNDLE/manifest.json" ] || die 'Run plan first'
  [ "$CONFIRM" = "$SHA" ] || die 'Repeat the full SHA as the third argument to confirm'
  set +e
  python3 /opt/fanscope-cd/scripts/cicd/deploy_backend.py deploy --bundle "$BUNDLE" --sha "$SHA" --run-id "$(date +%s)"
  CODE=$?
  set -e
  LATEST=$(ls -1dt /var/lib/fanscope-cd/backups/* | head -1)
  python3 -c "import json,sys;r=json.load(open(sys.argv[1]));print({k:r.get(k) for k in ('status','stage','migrations','failureType','failureMessage','previousImage','backup')})" "$LATEST/result.json"
  [ "$CODE" -eq 0 ] || die "Release did not succeed. Controller result above; rollback runs automatically. Logs: $LATEST/candidate.log"
  say 'Live check'
  curl -s "$API/api/health" | python3 -c "
import json,sys
h=json.load(sys.stdin);print({k:h.get(k) for k in ('status','commit','aiConfigured','diagnostic','migrations')})
assert h['commit']==sys.argv[1],'commit mismatch'" "$SHA"
  docker ps --format '{{.Names}}' | sort | diff "$WORK/containers-before.txt" - && echo 'Container list unchanged.'
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
  [ "$CONFIRM" = "$SHA" ] || die 'Repeat the full SHA as the third argument to confirm'
  install_controller
  ensure_nginx_gate
  release
fi
