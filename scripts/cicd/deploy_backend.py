"""Root-owned, reviewed host controller. Never execute scripts from release artifacts.

No SSH, runner, volume creation, Compose down, pruning, or unrelated container changes.
Schema OR data transformations on startup are rejected on an isolated copy.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import shutil
import time
import urllib.request
import urllib.error
from sqlite_release import assert_idle, backup, inspect, pause_ai, restore, sha256, write_json

STATE = Path('/var/lib/fanscope-cd')
ROOT = Path('/opt/fanscope-cd')
CONTAINER = 'fanscope-api'
SERVICE = 'fanscope-api'
VOLUME = 'fanscope_data'


def run(*args, env=None):
    return subprocess.check_output(args, text=True, encoding='utf8', env=env, stderr=subprocess.PIPE).strip()


def docker_json(*args):
    return json.loads(run('docker', *args))[0]


def compose(image, *args):
    env = {**os.environ, 'FANSCOPE_RELEASE_IMAGE': image}
    base = os.environ.get('FANSCOPE_COMPOSE_FILE', '/home/ubuntu/fanscope/deploy/docker-compose.yml')
    return run('docker', 'compose', '-p', 'deploy', '-f', base,
               '-f', str(ROOT / 'deploy/cicd/production.yml'), *args, env=env)


def health(image):
    for _ in range(48):
        c = docker_json('inspect', CONTAINER)
        if c['Image'] != image or not c['State']['Running']:
            raise RuntimeError('Wrong image or stopped API container')
        status = c['State'].get('Health', {}).get('Status')
        if status == 'healthy':
            report = json.loads(run('docker', 'exec', CONTAINER, 'node', '--experimental-sqlite', '--input-type=module', '-e',
                "const h=await(await fetch('http://127.0.0.1:8787/api/health')).json();"
                "const{DatabaseSync}=await import('node:sqlite');const d=new DatabaseSync(process.env.DATABASE_PATH,{readOnly:true});"
                "try{for(const market of ['international','chinese']){"
                "const n=d.prepare('SELECT count(*) n FROM articles a JOIN journals j ON j.id=a.journal_id WHERE a.demo=0 AND a.market=j.market AND a.market=?').get(market).n;"
                "const r=await fetch('http://127.0.0.1:8787/api/stats?period=all&article_type=all&market='+market);"
                "if(!r.ok||(await r.json()).count!==n)throw Error('Existing paper API/database count mismatch');}}finally{d.close()}"
                "console.log(JSON.stringify(h))"))
            if report.get('status') != 'ok' or report.get('service') != 'fanscope-api' or report.get('aiConfigured') or report.get('emailConfigured'):
                raise RuntimeError('API health/paid-worker guards failed')
            return
        if status == 'unhealthy':
            raise RuntimeError('Docker health check failed')
        time.sleep(5)
    raise RuntimeError('Docker health timeout')


def public_health():
    with urllib.request.urlopen('https://fanscope-api.adapttochina.com/api/health', timeout=15) as r:
        h = json.load(r)
        if r.status != 200 or h.get('status') != 'ok' or h.get('service') != 'fanscope-api' or h.get('aiConfigured') or h.get('emailConfigured'):
            raise RuntimeError('Public HTTPS API guard failed')


def verify_ingress_closed():
    # A read-only probe proves the gate is effective on the real API vhost.
    req = urllib.request.Request('https://fanscope-api.adapttochina.com/api/stats?cicd=maintenance',
                                 headers={'Cache-Control': 'no-cache'})
    try:
        with urllib.request.urlopen(req, timeout=15):
            pass
    except urllib.error.HTTPError as error:
        if error.code == 503:
            return
    raise RuntimeError('Public FanScope ingress is not in maintenance; refusing to touch database')


def stop(*, require_graceful=True):
    run('docker', 'stop', '--time', '180', CONTAINER)
    c = docker_json('inspect', CONTAINER)
    if c['State']['Running'] or (require_graceful and c['State']['ExitCode'] != 0):
        raise RuntimeError('API did not drain gracefully; retain maintenance, inspect uncertain work')


def verify_bundle(bundle, sha):
    if not re.fullmatch('[a-f0-9]{40}', sha):
        raise RuntimeError('Full SHA required')
    expected = {'image.tar', 'manifest.json', 'SHA256SUMS'}
    if {f.name for f in bundle.iterdir()} != expected or any(f.is_symlink() for f in bundle.iterdir()):
        raise RuntimeError('Unexpected release files')
    checks = {}
    for line in (bundle / 'SHA256SUMS').read_text().splitlines():
        digest, name = line.split('  ')
        if name not in {'image.tar', 'manifest.json'} or name in checks or not re.fullmatch('[a-f0-9]{64}', digest):
            raise RuntimeError('Invalid checksum list')
        checks[name] = digest
    if set(checks) != {'image.tar', 'manifest.json'} or any(sha256(bundle / n) != d for n, d in checks.items()):
        raise RuntimeError('Release checksum mismatch')
    m = json.loads((bundle / 'manifest.json').read_text())
    if m.get('commit') != sha or m.get('migrationPolicy') != 'no-change' or not re.fullmatch('sha256:[a-f0-9]{64}', m.get('image', '')):
        raise RuntimeError('Release manifest mismatch')
    return m


def rehearsal(image, directory, baseline):
    # All startup DB/lab initialization runs against the restored copy, no keys/network.
    run('docker', 'run', '--rm', '--network', 'none', '--memory', '420m', '--cpus', '1', '--user', '0:0',
        '--mount', f'type=bind,source={directory},target=/app/data',
        '-e', 'DATABASE_PATH=/app/data/restore.sqlite', '-e', 'DEEPSEEK_API_KEY=', '-e', 'RESEND_API_KEY=',
        '--entrypoint', 'node', image, '--experimental-sqlite', '--input-type=module', '-e',
        "globalThis.fetch=()=>{throw Error('Network forbidden in migration rehearsal')};"
        "await import('./src/server.mjs');const{db}=await import('./src/db.mjs');db.close();")
    if inspect(directory / 'restore.sqlite') != baseline:
        raise RuntimeError('Startup changes schema/data; automatic migration is prohibited, separate reviewed migration needed')


def deploy(bundle, sha, run_id):
    m = verify_bundle(bundle, sha)
    if (STATE / 'maintenance').exists() or (STATE / 'transaction.json').exists():
        raise RuntimeError('Unfinished maintenance/transaction requires explicit recovery')
    old = docker_json('inspect', CONTAINER)
    if old['Config'].get('Labels', {}).get('com.docker.compose.project') != 'deploy':
        raise RuntimeError('Unexpected existing Compose project')
    if old['Config'].get('Labels', {}).get('com.docker.compose.service') != SERVICE or not old['State']['Running']:
        raise RuntimeError('Existing running API service required')
    if old['Config'].get('Cmd') != ['node', '--experimental-sqlite', 'src/v14-server.mjs']:
        raise RuntimeError('First enablement requires reviewed V1.4 graceful-draining baseline')
    mounts = [v for v in old['Mounts'] if v['Destination'] == '/app/data']
    if len(mounts) != 1 or mounts[0].get('Name') != VOLUME:
        raise RuntimeError('Existing production data volume mismatch')
    volume = docker_json('volume', 'inspect', VOLUME)
    database = Path(volume['Mountpoint']) / 'fanscope.sqlite'
    inspect(database)
    # No nginx reload/change. Fail before maintenance if the reviewed gate is absent.
    nginx = subprocess.run(['nginx', '-T'], capture_output=True, text=True, check=True)
    if 'if (-f /var/lib/fanscope-cd/maintenance)' not in nginx.stdout + nginx.stderr:
        raise RuntimeError('FanScope nginx maintenance gate has not been installed')
    if shutil.disk_usage(STATE).free < max((bundle / 'image.tar').stat().st_size * 2 + database.stat().st_size * 4, 1024**3):
        raise RuntimeError('Insufficient image-load and database-restore free space')
    run('docker', 'load', '--input', str(bundle / 'image.tar'))
    image = docker_json('image', 'inspect', m['image'])
    if image['Config'].get('Labels', {}).get('org.opencontainers.image.revision') != sha:
        raise RuntimeError('Image revision label mismatch')
    # Docker may resolve a config digest to a local manifest ID on another engine.
    build_image = m['image']
    m['image'] = image['Id']
    # Validate resolved Compose without printing env/secret values.
    config = json.loads(compose(m['image'], 'config', '--format', 'json'))
    service = config['services'][SERVICE]
    if service['image'] != m['image'] or service['container_name'] != CONTAINER or not config['volumes'][VOLUME].get('external'):
        raise RuntimeError('Resolved Compose guard failed')
    data_mounts = [v for v in service['volumes'] if v['target'] == '/app/data']
    if len(data_mounts) != 1 or data_mounts[0].get('type') != 'volume' or data_mounts[0].get('source') != VOLUME:
        raise RuntimeError('Compose must retain existing production data mount')
    if service['environment'].get('FANSCOPE_AI_AUTO_ENABLED') != 'false' or any(
            service['environment'].get(k) for k in ['DEEPSEEK_API_KEY', 'RESEND_API_KEY', 'OPENALEX_API_KEY']):
        raise RuntimeError('Paid worker/environment guard failed')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    release = STATE / 'backups' / f'{stamp}-{run_id}'
    release.mkdir(mode=0o700)
    report = {'commit': sha, 'image': m['image'], 'buildImage': build_image, 'previousImage': old['Image'], 'runId': run_id,
              'time': stamp, 'backup': str(release), 'status': 'maintenance', 'database': str(database)}
    write_json(STATE / 'transaction.json', report)
    (STATE / 'maintenance').touch(exist_ok=False)
    # Fail closed until frozen final snapshot exists; never resume paid work on failure.
    try:
        verify_ingress_closed()
        pause_ai(database)
        for _ in range(36):
            try:
                assert_idle(database)
                break
            except RuntimeError:
                time.sleep(5)
        else:
            raise RuntimeError('In-flight/uncertain work did not drain; no automatic retries')
        backup(database, release / 'online')
        stop()
        assert_idle(database)
        # Final snapshot includes any monitor work completed during graceful shutdown.
        final = backup(database, release / 'frozen')
        baseline = final['manifest']
        report['status'] = 'frozen'
        write_json(STATE / 'transaction.json', report)
        try:
            rehearsal(m['image'], release / 'frozen', baseline)
            compose(m['image'], 'up', '-d', '--no-build', '--no-deps', '--pull', 'never', SERVICE)
            health(m['image'])
            if inspect(database) != baseline:
                raise RuntimeError('Production data changed during startup')
            public_health()
            report['status'] = 'success'
        except Exception:
            rollback(report)
            report['status'] = 'rolled-back'
            raise
        finally:
            write_json(release / 'result.json', report)
        (STATE / 'maintenance').unlink()
        (STATE / 'transaction.json').rename(release / 'transaction.json')
    except Exception as error:
        # A successful rollback removes the gate itself. Otherwise leave it closed.
        if report['status'] != 'rolled-back':
            report['status'] = 'failed-maintenance'
        report['failureType'] = type(error).__name__
        write_json(release / 'result.json', report)
        if (STATE / 'transaction.json').exists():
            write_json(STATE / 'transaction.json', report)
        raise
    return report


def rollback(report):
    if not (STATE / 'maintenance').is_file():
        raise RuntimeError('Rollback requires closed ingress')
    database = Path(report['database'])
    release = Path(report['backup'])
    final = json.loads((release / 'frozen/verified.json').read_text())
    snapshot = release / 'frozen/backup.sqlite'
    if sha256(snapshot) != final['sha256'] or inspect(snapshot) != final['manifest']:
        raise RuntimeError('Rollback snapshot verification failed')
    c = docker_json('inspect', CONTAINER)
    if c['State']['Running']:
        # Candidate has no paid workers; ingress remains closed. Once stopped,
        # even a failed exit must not prevent verified database/image rollback.
        stop(require_graceful=False)
    # Preserve failed startup data, then restore through SQLite into the SAME file/volume.
    if inspect(database) != final['manifest']:
        backup(database, release / 'failed-startup')
        restore(snapshot, database)
    compose(report['previousImage'], 'up', '-d', '--no-build', '--no-deps', '--pull', 'never', SERVICE)
    health(report['previousImage'])
    if inspect(database) != final['manifest']:
        raise RuntimeError('Old image changed restored data; maintenance retained')
    public_health()
    report['status'] = 'rolled-back'
    write_json(release / 'result.json', report)
    (STATE / 'maintenance').unlink()
    (STATE / 'transaction.json').rename(release / 'transaction.json')


def recover(report):
    # Explicit operator recovery after a kill/power loss before the frozen backup.
    if not (STATE / 'maintenance').is_file():
        raise RuntimeError('Recovery requires maintenance mode')
    verify_ingress_closed()
    final = Path(report['backup']) / 'frozen'
    if not (final / 'verified.json').is_file():
        if final.exists():
            raise RuntimeError('Partial frozen backup requires manual review; never overwrite it')
        current = docker_json('inspect', CONTAINER)
        if current['Image'] != report['previousImage']:
            raise RuntimeError('No frozen backup and unexpected image; manual review required')
        if current['State']['Running']:
            stop()
        assert_idle(report['database'])
        backup(report['database'], final)
    rollback(report)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['deploy', 'recover'])
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--sha')
    parser.add_argument('--run-id', type=int)
    parser.add_argument('--confirm-sha')
    args = parser.parse_args()
    # Same host lock for manual recovery and poller deployment.
    import fcntl
    with (STATE / 'host.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'recover':
            record = json.loads((STATE / 'transaction.json').read_text())
            if args.confirm_sha != record['commit']:
                raise RuntimeError('Confirm exact transaction SHA before recovery')
            recover(record)
        else:
            deploy(args.bundle.resolve(strict=True), args.sha, args.run_id)
