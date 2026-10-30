#!/usr/bin/env bash
# Run manually from an APPROVED checkout on Ubuntu. Installs a DISABLED controller.
# Does not start a timer, change nginx, deploy a container, or read application secrets.
#   install-host.sh           first install
#   install-host.sh upgrade   replace the reviewed controller files; keeps config, token and timer state
set -euo pipefail
test "$(id -u)" -eq 0
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
MODE=${1:-install}
if [ "$MODE" = upgrade ]; then
  test -d /opt/fanscope-cd
  test ! -e /var/lib/fanscope-cd/maintenance
  test ! -e /var/lib/fanscope-cd/transaction.json
else
  test "$MODE" = install
  test ! -e /opt/fanscope-cd
fi
install -d -m 0755 /opt/fanscope-cd/scripts/cicd /opt/fanscope-cd/deploy/cicd
for file in sqlite_release.py deploy_backend.py pull_release.py; do
  install -m 0644 "$SOURCE/scripts/cicd/$file" "/opt/fanscope-cd/scripts/cicd/$file"
done
install -m 0644 "$SOURCE/deploy/cicd/production.yml" /opt/fanscope-cd/deploy/cicd/production.yml
# nginx needs directory traversal to stat the marker, but private data stays 0700.
install -d -m 0711 /var/lib/fanscope-cd
install -d -m 0700 /var/lib/fanscope-cd/backups /var/lib/fanscope-cd/incoming /etc/fanscope-cd
# World-readable on purpose: the API reads gate.json through a read-only mount.
# It holds release state only, never backups, tokens or the Docker socket.
install -d -m 0755 /var/lib/fanscope-cd/runtime
if [ ! -e /var/lib/fanscope-cd/runtime/gate.json ]; then
  printf '{"state":"open","release_id":"install","generation":0,"reason_code":"installed","blocked_at":null,"alert_after":null}' \
    > /var/lib/fanscope-cd/runtime/gate.json
  chmod 0644 /var/lib/fanscope-cd/runtime/gate.json
fi
if [ "$MODE" = install ]; then
  install -m 0600 "$SOURCE/deploy/cicd/config.example.json" /etc/fanscope-cd/config.json
fi
install -m 0644 "$SOURCE/deploy/cicd/fanscope-pull.service" /etc/systemd/system/fanscope-pull.service
install -m 0644 "$SOURCE/deploy/cicd/fanscope-pull.timer" /etc/systemd/system/fanscope-pull.timer
systemctl daemon-reload
echo 'Installed disabled. Configure token, pinned workflow ID, maintenance gate and production approval before enabling.'
