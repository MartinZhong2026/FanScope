#!/usr/bin/env bash
# Reviewed actions. No live database write/deploy/paid AI without its own flag.
set -euo pipefail
umask 077
BUNDLE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd "$BUNDLE"
read_manifest() { python3 -c 'import json,sys; print(json.load(open("release-manifest.json"))[sys.argv[1]])' "$1"; }
REV=$(read_manifest commit); SHORT=${REV:0:7}; TAG=$(read_manifest imageTag)
BASE=/home/ubuntu/fanscope/deploy/docker-compose.yml
ACTION=${1:-status}
OLD_IMAGE=sha256:ff847c5a37fe8cdab8164781ab82d9271396584577d0fab375c189f13ab699f3
OLD_CONFIG=sha256:cccafa66dc084a1fcdcf0d35f7b4da8c301dba85c8a76b59d1a906cc2e937faf
PACKAGE_SHA=$(read_manifest chineseSha256)
approval() { test "$1" = "$SHORT" || { echo "STOP: explicit approval for $ACTION ($SHORT) required"; exit 1; }; }
load_image() {
 sha256sum -c SHA256SUMS
 if ! sudo -n docker image inspect "$TAG" >/dev/null 2>&1; then sudo -n docker image load --input api-image.tar; fi
 IMAGE=$(sudo -n docker image inspect "$TAG" --format '{{.Id}}')
 test "$IMAGE" = "$(read_manifest imageIndex)" || test "$IMAGE" = "$(read_manifest imageConfig)" || { echo 'STOP: image mismatch'; exit 1; }
 test "$(sudo -n docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$REV"
}
dc() { sudo -n --preserve-env=FANSCOPE_RELEASE_IMAGE,FANSCOPE_AI_AUTO_ENABLED docker compose -p deploy -f "$BASE" -f "$BUNDLE/v14.yml" "$@"; }
wait_health() {
 for i in $(seq 1 24); do
  state=$(sudo -n docker inspect --format '{{.State.Health.Status}}' fanscope-api)
  test "$state" = healthy && return 0
  test "$state" != unhealthy || return 1
  sleep 5
 done
 return 1
}
proof() {
 sudo -n docker run --rm --network none --memory 420m --cpus 1 --user 0:0 \
  --mount "$DATA_MOUNT" --mount "type=bind,source=$BUNDLE,target=/release,readonly" \
  --entrypoint node "$IMAGE" --experimental-sqlite /release/tools/v14-protected-proof.mjs /data/fanscope.sqlite /release/chinese/chinese-data.json "$@"
}
health_check() {
 local expected_ai=${1:-false}
 sudo -n docker exec fanscope-api node --input-type=module -e "const h=await(await fetch('http://127.0.0.1:8787/api/health')).json();if(h.status!=='ok'||h.emailConfigured||('$expected_ai'!=='any' && !!h.aiConfigured!==('$expected_ai'==='true')))throw Error('Health/AI/mail guard failed');console.log(JSON.stringify({health:h.status,aiConfigured:h.aiConfigured,emailConfigured:h.emailConfigured}));"
}
case "$ACTION" in
validate)
 load_image
 test ! -e validation.json || { echo 'Validation already recorded; refusing to repeat'; exit 1; }
 current=$(sudo -n docker inspect --format '{{.Image}}' fanscope-api)
 test "$current" = "$OLD_IMAGE" || test "$current" = "$OLD_CONFIG" || { echo 'STOP: current image is not reviewed 52cefa4'; exit 1; }
 OLD_IMAGE=$current
 DIR=$(mktemp -d /home/ubuntu/fanscope-v14-isolated.XXXXXXXX)
 sudo -n python3 - /home/ubuntu/fanscope-backup-20261028T024346Z/backup.sqlite "$DIR/fanscope.sqlite" <<'PY'
import sys,hashlib,os
h=hashlib.sha256()
with open(sys.argv[1],'rb') as src,open(sys.argv[2],'xb') as dst:
 for block in iter(lambda:src.read(1024*1024),b''):h.update(block);dst.write(block)
 dst.flush();os.fsync(dst.fileno())
os.chmod(sys.argv[2],0o600)
assert h.hexdigest()=='a7f7893bd788d3f765e0b0bf4bb80d1446b6ffa39cd5b080af86d355cdf9330a'
PY
 DATA_MOUNT="type=bind,source=$DIR,target=/data"
 proof > "$DIR/before.json"
 for round in first repeat; do
  sudo -n docker run --rm --network none --memory 420m --cpus 1 --user 0:0 \
   --mount "$DATA_MOUNT" --mount "type=bind,source=$BUNDLE,target=/release,readonly" \
   --entrypoint node "$IMAGE" --experimental-sqlite src/chinese-production-import.mjs \
   --db=/data/fanscope.sqlite --package=/release/chinese/chinese-data.json --sha256="$PACKAGE_SHA" --apply > "$DIR/$round.json"
 done
 DATA_MOUNT="type=bind,source=$DIR,target=/data"
 proof /data/before.json > "$DIR/after-import.json"
 C1="fanscope-v14-check-$(basename "$DIR")"; C2="fanscope-52-check-$(basename "$DIR")"
 cleanup() { for name in "${C1:-}" "${C2:-}"; do if [ -n "$name" ]; then sudo -n docker stop "$name" >/dev/null 2>&1 || true; fi; done; }
 trap cleanup EXIT
 for version in new old; do
  if [ "$version" = new ]; then RUN_IMAGE=$IMAGE; NAME=$C1; ENTRY=src/v14-server.mjs; else RUN_IMAGE=$OLD_IMAGE; NAME=$C2; ENTRY=src/staged-recovery-server.mjs; fi
  sudo -n docker run -d --rm --name "$NAME" --network none --memory 420m --cpus 1 --user 0:0 \
   --mount "type=bind,source=$DIR,target=/app/data" -e NODE_ENV=production -e DATABASE_PATH=/app/data/fanscope.sqlite \
   -e FANSCOPE_V14_RUNTIME=true -e FANSCOPE_STAGED_RECOVERY=true -e FANSCOPE_ENGLISH_MONITOR=false -e FANSCOPE_AI_AUTO_ENABLED=false \
   -e ADMIN_KEY=isolated-validation-not-a-production-secret -e DEEPSEEK_API_KEY= -e RESEND_API_KEY= -e OPENALEX_API_KEY= \
   --entrypoint node "$RUN_IMAGE" --experimental-sqlite "$ENTRY" >/dev/null
  for i in $(seq 1 30); do if sudo -n docker exec "$NAME" node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi; sleep 1; done
  sudo -n docker exec "$NAME" node --input-type=module -e "const b='http://127.0.0.1:8787';const h=await(await fetch(b+'/api/health')).json();const c=await(await fetch(b+'/api/stats?market=chinese&period=all&article_type=all')).json();if(h.status!=='ok'||h.aiConfigured||h.emailConfigured||c.count!==349)throw Error('API/market guard failed');console.log(JSON.stringify({version:'$version',chinese:c.count,health:h.status}));"
  sudo -n docker stop "$NAME" >/dev/null
  if [ "$version" = new ]; then C1=''; else C2=''; fi
  proof /data/before.json > "$DIR/after-$version.json"
 done
 python3 - "$DIR" "$REV" "$IMAGE" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]);a=json.loads((p/'first.json').read_text());b=json.loads((p/'repeat.json').read_text())
assert a['added']==349 and b['added']==0 and b['duplicates']==349
for name in ['after-import.json','after-new.json','after-old.json']:
 r=json.loads((p/name).read_text());assert r['integrity']=='ok' and not r['differences'] and not r['foreignKeys'] and r['chinese']==349
r=json.loads((p/'after-old.json').read_text());report={'status':'PASS','commit':sys.argv[2],'image':sys.argv[3],'isolatedCopy':str(p),'added':a['added'],'repeatAdded':b['added'],'english':r['english'],'aiJson':r['ai'],'jobs':r['jobs'],'oldRollback':'PASS'}
with open('validation.json','x') as f:json.dump(report,f,indent=2)
print(json.dumps(report))
PY
 ;;
deploy)
 approval "${FANSCOPE_DEPLOY_APPROVED:-}"
 test "${FANSCOPE_MAINTENANCE_CONFIRMED:-}" = yes || { echo 'STOP: confirm frozen ingress writes/in-flight work'; exit 1; }
 load_image
 python3 - "$REV" <<'PY'
import json,sys
r=json.load(open('validation.json'));assert r['status']=='PASS' and r['commit']==sys.argv[1] and r['oldRollback']=='PASS'
PY
 current=$(sudo -n docker inspect --format '{{.Image}}' fanscope-api)
 test "$current" = "$OLD_IMAGE" || test "$current" = "$OLD_CONFIG" || { echo 'STOP: unexpected existing image'; exit 1; }
 test ! -e frozen-before.json && test ! -e frozen-after.json
 health_check
 sudo -n docker exec -i fanscope-api node --experimental-sqlite --input-type=module <<'NODE'
import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.env.DATABASE_PATH,{readOnly:true});try{
if(d.prepare("SELECT COUNT(*) n FROM articles WHERE analysis_status='analyzing'").get().n||d.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='scan' AND status='running'").get().n)throw Error('Work in flight or stale state needs review');
}finally{d.close()}
NODE
 export FANSCOPE_RELEASE_IMAGE=$IMAGE FANSCOPE_AI_AUTO_ENABLED=false
 dc stop fanscope-api
 DATA_MOUNT='type=volume,source=fanscope_data,target=/data'
 proof > frozen-before.json
 dc up -d --no-build --no-deps fanscope-api
 wait_health;health_check
 proof /release/frozen-before.json > frozen-after.json
 printf '%s\n' "$REV" > deployed.txt
 echo 'Backend V1.4 PASS; AI/mail/backfill disabled. Chinese import is separate.'
 ;;
import)
 approval "${FANSCOPE_IMPORT_APPROVED:-}"
 load_image
 test "$(cat deployed.txt)" = "$REV"
 test "$(sudo -n docker inspect --format '{{.Image}}' fanscope-api)" = "$IMAGE"
 if [ -e import-result.json ]; then cat import-result.json; exit 0; fi
 sudo -n docker exec fanscope-api node --input-type=module -e "const h=await(await fetch('http://127.0.0.1:8787/api/health')).json();if(h.status!=='ok'||h.aiConfigured||h.emailConfigured)throw Error('Import requires healthy API with AI/mail off')"
 VOLUME_ROOT=$(sudo -n docker volume inspect --format '{{.Mountpoint}}' fanscope_data)
 BACKUP_DIR="/home/ubuntu/fanscope-backup-v14-$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
 sudo -n python3 "$BUNDLE/tools/chinese-online-backup.py" "$VOLUME_ROOT/fanscope.sqlite" "$BACKUP_DIR"
 printf '%s\n' "$BACKUP_DIR" > latest-import-backup.txt
 IMPORT_OUTPUT=$(mktemp "$BUNDLE/import-result.XXXXXXXX")
 sudo -n docker run --rm --network none --memory 420m --cpus 1 --user 0:0 \
  --mount type=volume,source=fanscope_data,target=/data --mount "type=bind,source=$BUNDLE,target=/release,readonly" \
  --entrypoint node "$IMAGE" --experimental-sqlite src/chinese-production-import.mjs \
  --db=/data/fanscope.sqlite --package=/release/chinese/chinese-data.json --sha256="$PACKAGE_SHA" --apply > "$IMPORT_OUTPUT"
 python3 - "$IMPORT_OUTPUT" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]));assert r['integrity']=='ok' and r['protectedDataUnchanged'] and r['finalChinese']>=349
PY
 mv --no-clobber "$IMPORT_OUTPUT" import-result.json
 cat import-result.json
 ;;
enable-ai)
 approval "${FANSCOPE_AI_APPROVED:-}"
 load_image;test "$(cat deployed.txt)" = "$REV";test -f import-result.json
 sudo -n docker exec fanscope-api node --experimental-sqlite src/ai-auto-control.mjs --action=pause
 export FANSCOPE_RELEASE_IMAGE=$IMAGE FANSCOPE_AI_AUTO_ENABLED=true
 dc up -d --no-build --no-deps fanscope-api
 wait_health;health_check true
 # This final resume starts real paid continuous analysis, without per-batch prompts.
 sudo -n docker exec fanscope-api node --experimental-sqlite src/ai-auto-control.mjs --action=resume
 ;;
pause-ai|resume-ai|stop-ai)
 action=${ACTION%-ai}; if [ "$action" = resume ]; then action=resume; fi
 sudo -n docker exec fanscope-api node --experimental-sqlite src/ai-auto-control.mjs --action="$action"
 ;;
rollback)
 approval "${FANSCOPE_ROLLBACK_APPROVED:-}"
 load_image
 sudo -n docker exec fanscope-api node --experimental-sqlite src/ai-auto-control.mjs --action=pause || true
 # Old 52cefa4 never starts AI workers; current database and imported papers stay.
 if ! sudo -n docker image inspect "$OLD_IMAGE" >/dev/null 2>&1; then OLD_IMAGE=$OLD_CONFIG; fi
 export FANSCOPE_RELEASE_IMAGE=$OLD_IMAGE FANSCOPE_ENGLISH_MONITOR=true
 sudo -n --preserve-env=FANSCOPE_RELEASE_IMAGE,FANSCOPE_ENGLISH_MONITOR docker compose -p deploy -f "$BASE" -f "$BUNDLE/rollback-52cefa4.yml" up -d --no-build --no-deps fanscope-api
 wait_health;health_check
 ;;
status)
 health_check any
 curl --fail --silent --show-error https://fanscope-api.adapttochina.com/api/ai-auto-status
 ;;
*) echo 'Usage: v14-ops.sh validate|deploy|import|enable-ai|pause-ai|resume-ai|stop-ai|rollback|status';exit 1;;
esac
