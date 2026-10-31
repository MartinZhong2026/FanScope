"""Root-owned, reviewed host controller. Never execute scripts from release artifacts.

No SSH, runner, volume creation, Compose down, pruning, or unrelated container changes.
Schema OR data transformations on startup are rejected on an isolated copy.
Reviewed additive migrations run only here: first on the frozen copy, then on the
stopped production database, each verified independently of the application.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import shutil
import tarfile
import time
import urllib.request
import urllib.error
from sqlite_release import additive_check, assert_idle, backup, inspect, pause_ai, restore, sha256, write_json

STATE = Path('/var/lib/fanscope-cd')
ROOT = Path('/opt/fanscope-cd')
CONTAINER = 'fanscope-api'
SERVICE = 'fanscope-api'
VOLUME = 'fanscope_data'


GATE_ALERT_SECONDS = 2 * 3600
SECRET_TEXT = re.compile(r'(?i)(bearer\s+|sk-|(?:key|token|password|secret)["\']?\s*[=:]\s*["\']?)\S+')


def safe_text(value, limit=400):
    text = SECRET_TEXT.sub(lambda m: m.group(1) + '[redacted]', str(value))
    return text[-limit:]


def run(*args, env=None):
    return subprocess.check_output(args, text=True, encoding='utf8', env=env, stderr=subprocess.PIPE).strip()


def docker_json(*args):
    return json.loads(run('docker', *args))[0]


def compose(image, *args):
    env = {**os.environ, 'FANSCOPE_RELEASE_IMAGE': image}
    base = os.environ.get('FANSCOPE_COMPOSE_FILE', '/home/ubuntu/fanscope/deploy/docker-compose.yml')
    return run('docker', 'compose', '-p', 'deploy', '-f', base,
               '-f', str(ROOT / 'deploy/cicd/production.yml'), *args, env=env)


def gate_file():
    return STATE / 'runtime' / 'gate.json'


def read_gate():
    # Anything unreadable or unknown is treated as "not open" by every caller.
    try:
        gate = json.loads(gate_file().read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(gate, dict) or gate.get('state') not in ('open', 'blocked') or not isinstance(gate.get('generation'), int):
        return None
    return gate


def write_gate(state, release_id, generation, reason):
    now = datetime.datetime.now(datetime.timezone.utc)
    alert = now + datetime.timedelta(seconds=GATE_ALERT_SECONDS)
    gate = {'state': state, 'release_id': str(release_id), 'generation': generation, 'reason_code': reason,
            'blocked_at': now.isoformat() if state == 'blocked' else None,
            'alert_after': alert.isoformat() if state == 'blocked' else None}
    target = gate_file()
    temp = target.with_suffix('.tmp')
    with temp.open('w', encoding='utf8') as stream:
        json.dump(gate, stream)
        stream.flush()
        os.fsync(stream.fileno())
    # The application reads this through a read-only directory mount as another user.
    os.chmod(temp, 0o644)
    os.replace(temp, target)
    if os.name == 'posix':
        directory = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    if read_gate() != gate:
        raise RuntimeError('Release gate write could not be verified')
    return gate


def block_gate(release_id):
    gate = read_gate()
    if gate is None or gate['state'] != 'open':
        raise RuntimeError('Release gate is missing, unreadable or blocked; explicit recovery required')
    return write_gate('blocked', release_id, gate['generation'] + 1, 'release')


def open_gate(release_id, generation, reason='released'):
    gate = read_gate()
    if gate is None or gate['state'] != 'blocked' or gate['generation'] != generation or gate['release_id'] != str(release_id):
        raise RuntimeError('Release gate identity mismatch; gate stays blocked')
    return write_gate('open', release_id, generation, reason)


def finish(report):
    # Opening the gate is last: any earlier failure leaves background work stopped.
    (STATE / 'maintenance').unlink()
    (STATE / 'transaction.json').rename(Path(report['backup']) / 'transaction.json')
    if report.get('gateGeneration') is not None:
        open_gate(Path(report['backup']).name, report['gateGeneration'])


def health(image, manifest=None):
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
            if manifest is not None:
                if report.get('commit') != manifest['commit']:
                    raise RuntimeError('Running commit does not match the release')
                if bool((report.get('diagnostic') or {}).get('aiConfigured')) != bool(manifest.get('diagnosticAiEnabled')):
                    raise RuntimeError('Diagnostic AI state does not match the release manifest')
                if bool(report.get('scheduler')) != bool(manifest.get('schedulerEnabled')):
                    raise RuntimeError('Scheduler state does not match the release manifest')
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


def tar_image_identity(archive):
    """Engine-independent identity of a `docker save` archive: config digest, tags, layers, labels.

    The image ID printed by `docker image inspect` differs between engines (the containerd
    image store reports an index digest, the classic store the config digest), so it cannot
    identify an image across a build host and a server. The config blob can.
    """
    with tarfile.open(archive) as tar:
        manifest = json.load(tar.extractfile('manifest.json'))
        if not isinstance(manifest, list) or len(manifest) != 1:
            raise RuntimeError('Image archive must contain exactly one image')
        name = manifest[0]['Config']
        data = tar.extractfile(name).read()
    digest = hashlib.sha256(data).hexdigest()
    named = re.search(r'([a-f0-9]{64})(?:\.json)?$', name)
    if not named or named.group(1) != digest:
        raise RuntimeError('Image config blob does not match its digest')
    config = json.loads(data)
    return {'configDigest': 'sha256:' + digest, 'tags': manifest[0].get('RepoTags') or [],
            'diffIds': (config.get('rootfs') or {}).get('diff_ids') or [],
            'labels': (config.get('config') or {}).get('Labels') or {}}


def load_release_image(archive, sha, manifest):
    identity = tar_image_identity(archive)
    tag = manifest['imageTag']
    if identity['configDigest'] != manifest['configDigest'] or tag not in identity['tags']:
        raise RuntimeError('Image archive does not match the release manifest')
    run('docker', 'load', '--input', str(archive))
    image = docker_json('image', 'inspect', tag)
    labels = (image.get('Config') or {}).get('Labels') or {}
    if labels.get('org.opencontainers.image.revision') != sha:
        raise RuntimeError('Image revision label mismatch')
    if image['Id'] != identity['configDigest']:
        # Another engine reports a manifest or index digest as the ID. Prove the loaded
        # content is the archived image by its layers and labels instead.
        if (image.get('RootFS') or {}).get('Layers') != identity['diffIds'] or labels != identity['labels']:
            raise RuntimeError('Loaded image content differs from the release archive')
    return image


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
    policy, migrations = m.get('migrationPolicy'), m.get('migrations', [])
    if m.get('commit') != sha or not re.fullmatch('sha256:[a-f0-9]{64}', m.get('image', '')) or \
            not re.fullmatch('sha256:[a-f0-9]{64}', m.get('configDigest', '')) or m.get('imageTag') != f'fanscope-api:{sha}' or \
            not isinstance(m.get('diagnosticAiEnabled', False), bool) or not isinstance(m.get('schedulerEnabled', False), bool):
        raise RuntimeError('Release manifest mismatch')
    if (policy, bool(migrations)) not in (('no-change', False), ('additive', True)) or not all(
            isinstance(x, dict) and isinstance(x.get('declared'), dict) and re.fullmatch('[0-9TZ]+_[a-z0-9_]+', str(x.get('id')))
            and re.fullmatch('[a-f0-9]{64}', str(x.get('checksum'))) for x in migrations):
        raise RuntimeError('Release manifest mismatch: invalid migration policy')
    return m


def rehearsal(image, directory, baseline):
    # All startup DB/lab initialization runs against the restored copy, no keys/network.
    run('docker', 'run', '--rm', '--network', 'none', '--memory', '420m', '--cpus', '1', '--user', '0:0',
        '--mount', f'type=bind,source={directory},target=/app/data',
        '-e', 'DATABASE_PATH=/app/data/restore.sqlite', '-e', 'DEEPSEEK_API_KEY=', '-e', 'RESEND_API_KEY=', '-e', 'FANSCOPE_LOG_DIR=/tmp/logs',
        '--entrypoint', 'node', image, '--experimental-sqlite', '--input-type=module', '-e',
        "globalThis.fetch=()=>{throw Error('Network forbidden in migration rehearsal')};"
        "await import('./src/server.mjs');const{db}=await import('./src/db.mjs');db.close();")
    if inspect(directory / 'restore.sqlite') != baseline:
        raise RuntimeError('Startup changes schema/data; automatic migration is prohibited, separate reviewed migration needed')


def node_on_copy(image, directory, *args):
    return run('docker', 'run', '--rm', '--network', 'none', '--memory', '420m', '--cpus', '1', '--user', '0:0',
        '--mount', f'type=bind,source={directory},target=/app/data',
        '-e', 'DATABASE_PATH=/app/data/restore.sqlite', '-e', 'DEEPSEEK_API_KEY=', '-e', 'RESEND_API_KEY=', '-e', 'FANSCOPE_LOG_DIR=/tmp/logs',
        '--entrypoint', 'node', image, '--experimental-sqlite', *args)


def expect_argument(pending):
    return ','.join(f"{p['id']}:{p['checksum']}" for p in pending)


def declared_for(pending, manifest):
    reviewed = {x['id']: x for x in manifest.get('migrations', [])}
    merged = {}
    for item in pending:
        for key, values in reviewed[item['id']]['declared'].items():
            merged.setdefault(key, []).extend(values)
    return merged


def migration_plan(image, directory, manifest, extra=()):
    # Applied rows must match the image; everything pending must be in the reviewed manifest.
    status = json.loads(node_on_copy(image, directory, 'src/migrate-cli.mjs', 'status', *extra))
    if status.get('status') not in ('up-to-date', 'pending'):
        raise RuntimeError('Database migration state is not releasable: ' + str(status.get('status')))
    reviewed = {x['id']: x['checksum'] for x in manifest.get('migrations', [])}
    for item in status['pending']:
        if reviewed.get(item['id']) != item['checksum']:
            raise RuntimeError('Pending migration is not in the reviewed manifest: ' + item['id'])
    return status['pending']


def rehearse_release(image, old_image, directory, frozen, manifest, extra=()):
    """Everything happens on the frozen copy. Returns the migrations to apply to production."""
    if manifest.get('migrationPolicy') != 'additive':
        rehearsal(image, directory, frozen['manifest'])
        return []
    pending = migration_plan(image, directory, manifest, extra)
    if not pending:
        rehearsal(image, directory, frozen['manifest'])
        return []
    node_on_copy(image, directory, 'src/migrate-cli.mjs', 'apply', *extra, '--expect', expect_argument(pending), '--commit', manifest['commit'])
    additive_check(directory / 'backup.sqlite', directory / 'restore.sqlite', declared_for(pending, manifest))
    migrated = inspect(directory / 'restore.sqlite')
    rehearsal(image, directory, migrated)
    # Code rollback must stay possible without touching the database.
    rehearsal(old_image, directory, migrated)
    return pending


def apply_production(image, user, pending, sha):
    # Same image and exact list as the rehearsal; the API container is stopped.
    run('docker', 'run', '--rm', '--network', 'none', '--memory', '420m', '--cpus', '1', '--user', user,
        '--mount', f'type=volume,source={VOLUME},target=/app/data',
        '-e', 'DATABASE_PATH=/app/data/fanscope.sqlite', '-e', 'DEEPSEEK_API_KEY=', '-e', 'RESEND_API_KEY=',
        '--entrypoint', 'node', image, '--experimental-sqlite', 'src/migrate-cli.mjs', 'apply',
        '--expect', expect_argument(pending), '--commit', sha)


def save_candidate_log(release):
    # Evidence for the next attempt: the rollback replaces this container.
    try:
        done = subprocess.run(['docker', 'logs', '--timestamps', '--tail', '500', CONTAINER],
                              capture_output=True, text=True, encoding='utf8', errors='replace', timeout=30)
        text = '\n'.join(SECRET_TEXT.sub(lambda m: m.group(1) + '[redacted]', line) for line in (done.stdout + done.stderr).splitlines())
        (release / 'candidate.log').write_text(text + '\n', encoding='utf8')
    except Exception as error:
        print('Candidate log unavailable: ' + type(error).__name__)


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
    image = load_release_image(bundle / 'image.tar', sha, m)
    # The build host's ID is informational: engines disagree on what an image ID is.
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
    if bool(service['environment'].get('FANSCOPE_DIAGNOSTIC_DEEPSEEK_API_KEY')) != m.get('diagnosticAiEnabled', False):
        raise RuntimeError('Diagnostic key presence does not match the release manifest')
    if (service['environment'].get('FANSCOPE_SCHEDULER') == 'true') != m.get('schedulerEnabled', False):
        raise RuntimeError('Scheduler flag does not match the release manifest')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    release = STATE / 'backups' / f'{stamp}-{run_id}'
    release.mkdir(mode=0o700)
    report = {'commit': sha, 'image': m['image'], 'buildImage': build_image, 'previousImage': old['Image'], 'runId': run_id,
              'time': stamp, 'backup': str(release), 'status': 'maintenance', 'database': str(database), 'stage': 'gate'}
    # Before anything touches the database. A failed gate write ends the release here.
    report['gateGeneration'] = block_gate(release.name)['generation']
    write_json(STATE / 'transaction.json', report)
    (STATE / 'maintenance').touch(exist_ok=False)
    # Fail closed until frozen final snapshot exists; never resume paid work on failure.
    try:
        report['stage'] = 'ingress'
        verify_ingress_closed()
        report['stage'] = 'drain'
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
            report['stage'] = 'rehearsal'
            pending = rehearse_release(m['image'], old['Image'], release / 'frozen', final, m)
            report['migrations'] = [p['id'] for p in pending]
            if pending:
                report['stage'] = 'migration'
                apply_production(m['image'], old['Config'].get('User') or 'node', pending, sha)
                additive_check(release / 'frozen/backup.sqlite', database, declared_for(pending, m))
                baseline = inspect(database)
            report['stage'] = 'startup'
            compose(m['image'], 'up', '-d', '--no-build', '--no-deps', '--pull', 'never', SERVICE)
            health(m['image'], m)
            if inspect(database) != baseline:
                raise RuntimeError('Production data changed during startup')
            report['stage'] = 'public-health'
            public_health()
            report['status'] = 'success'
        except Exception:
            save_candidate_log(release)
            rollback(report)
            report['status'] = 'rolled-back'
            raise
        finally:
            write_json(release / 'result.json', report)
        report['stage'] = 'finish'
        finish(report)
    except Exception as error:
        # A successful rollback removes the gate itself. Otherwise leave it closed.
        if report['status'] == 'success':
            report['status'] = 'success-gate-blocked'
        elif report['status'] != 'rolled-back':
            report['status'] = 'failed-maintenance'
        report['failureType'] = type(error).__name__
        report['failureMessage'] = safe_text(f"{error} {getattr(error, 'stderr', '') or ''}")
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
    finish(report)


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


def recover_gate(generation):
    # A gate left blocked with no transaction: crash before the transaction was
    # written, or after it was archived. Proves the live state, then opens.
    gate = read_gate()
    if gate is None or gate['state'] != 'blocked' or gate['generation'] != generation:
        raise RuntimeError('Confirm the exact generation of a blocked gate')
    if (STATE / 'maintenance').exists() or (STATE / 'transaction.json').exists():
        raise RuntimeError('Unfinished transaction: use recover --confirm-sha instead')
    container = docker_json('inspect', CONTAINER)
    health(container['Image'])
    volume = docker_json('volume', 'inspect', VOLUME)
    inspect(Path(volume['Mountpoint']) / 'fanscope.sqlite')
    public_health()
    return write_gate('open', gate['release_id'], generation, 'operator-recovered')


def gate_status():
    # For a host watchdog: alerts only, never changes the gate.
    gate = read_gate()
    overdue = gate is None or (gate['state'] == 'blocked' and
        datetime.datetime.now(datetime.timezone.utc) >= datetime.datetime.fromisoformat(gate['alert_after']))
    print(json.dumps({'gate': gate, 'overdue': overdue}))
    return 3 if overdue else 0


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['deploy', 'recover', 'recover-gate', 'gate-status'])
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--sha')
    parser.add_argument('--run-id', type=int)
    parser.add_argument('--confirm-sha')
    parser.add_argument('--confirm-generation', type=int)
    args = parser.parse_args()
    if args.action == 'gate-status':
        raise SystemExit(gate_status())
    # Same host lock for manual recovery and poller deployment.
    import fcntl
    with (STATE / 'host.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'recover':
            record = json.loads((STATE / 'transaction.json').read_text())
            if args.confirm_sha != record['commit']:
                raise RuntimeError('Confirm exact transaction SHA before recovery')
            recover(record)
        elif args.action == 'recover-gate':
            recover_gate(args.confirm_generation)
        else:
            deploy(args.bundle.resolve(strict=True), args.sha, args.run_id)
