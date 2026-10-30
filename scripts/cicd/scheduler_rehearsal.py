"""Real Docker rehearsal of the K5 scheduler and K2 release gate. Synthetic data, no network.

Exercises what mocks cannot: the read-only directory mount, atomic gate replacement
seen by a running container, zero writes while blocked, kill -9 and restart, and a
graceful stop inside the production memory limit.
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from unittest.mock import patch
import deploy_backend as deploy
from sqlite_release import inspect


def jobs(database):
    db = sqlite3.connect(f'file:{database}?mode=ro', uri=True)
    try:
        return {r[0]: r[1] for r in db.execute("SELECT name,next_due_at FROM scheduled_jobs WHERE last_status='ok' AND lease_owner=''")}
    finally:
        db.close()


def main(image):
    name = 'fanscope-sched-' + uuid.uuid4().hex[:12]
    fixture_user = f'{os.getuid()}:{os.getgid()}'
    root = Path(__file__).resolve().parents[2]
    (root / 'work').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='sched-', dir=root / 'work') as temp:
        directory = Path(temp).resolve()
        data = directory / 'data'
        data.mkdir()
        (directory / 'runtime').mkdir()
        database = data / 'fanscope.sqlite'
        deploy.run('docker', 'run', '--rm', '--network', 'none', '--user', fixture_user,
            '--mount', f'type=bind,source={data},target=/app/data', '--entrypoint', 'node', image,
            '--experimental-sqlite', '--input-type=module', '-e',
            "const{db}=await import('./src/db.mjs');await import('./src/server.mjs');db.close();")

        def start():
            deploy.run('docker', 'run', '-d', '--name', name, '--network', 'none', '--memory', '420m', '--user', fixture_user,
                '--mount', f'type=bind,source={data},target=/app/data',
                '--mount', f"type=bind,source={directory / 'runtime'},target=/run/fanscope-gate,readonly",
                '-e', 'NODE_ENV=production', '-e', 'FANSCOPE_V14_RUNTIME=true', '-e', 'FANSCOPE_AI_AUTO_ENABLED=false',
                '-e', 'FANSCOPE_ENGLISH_MONITOR=true', '-e', 'FANSCOPE_SCHEDULER=true', '-e', 'FANSCOPE_LOG_DIR=/tmp/logs',
                '-e', 'FANSCOPE_RELEASE_GATE_FILE=/run/fanscope-gate/gate.json', '-e', 'ADMIN_KEY=synthetic-ci-only-not-a-real-secret',
                '-e', 'DATABASE_PATH=/app/data/fanscope.sqlite', image, 'node', '--experimental-sqlite', 'src/v14-server.mjs')
            for _ in range(60):
                probe = subprocess.run(['docker', 'exec', name, 'node', '-e',
                    "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], capture_output=True)
                if probe.returncode == 0:
                    return
                time.sleep(0.5)
            raise RuntimeError('API did not become ready: ' + deploy.run('docker', 'logs', '--tail', '20', name))

        def remove():
            subprocess.run(['docker', 'rm', '-f', name], check=False, capture_output=True)

        with patch.object(deploy, 'STATE', directory):
            try:
                deploy.write_gate('open', 'install', 0, 'installed')
                deploy.block_gate('r1')
                before = inspect(database)
                start()
                time.sleep(3)
                assert inspect(database) == before, 'Write while the gate was blocked'
                denied = subprocess.run(['docker', 'exec', name, 'sh', '-c', 'touch /run/fanscope-gate/x'], capture_output=True)
                assert denied.returncode != 0, 'Gate directory is writable from the container'
                # The running process must see an atomic replacement on the next tick.
                deploy.open_gate('r1', 1)
                for _ in range(75):
                    if len(jobs(database)) == 3:
                        break
                    time.sleep(1)
                else:
                    raise AssertionError('Scheduler did not start after the gate opened')
                due = jobs(database)
                deploy.run('docker', 'kill', '--signal', 'KILL', name)
                remove()
                start()
                time.sleep(3)
                assert jobs(database) == due, 'Restart changed the schedule'
                # Blocked again: a restart in the hold window writes nothing.
                deploy.block_gate('r2')
                time.sleep(1)
                held = inspect(database)
                stopped = subprocess.run(['docker', 'stop', '--time', '30', name], capture_output=True)
                state = deploy.docker_json('inspect', name)['State']
                assert stopped.returncode == 0 and state['ExitCode'] == 0, 'Scheduler blocked a graceful stop'
                remove()
                start()
                time.sleep(3)
                assert inspect(database) == held, 'Write during a blocked restart'
                print(json.dumps({'schedulerRehearsal': 'PASS', 'blockedZeroWrites': True, 'gateReadOnly': True, 'atomicGateOpen': True,
                                  'killRestartKeepsSchedule': True, 'gracefulStop': True, 'jobs': sorted(due)}))
            finally:
                remove()


if __name__ == '__main__':
    os.umask(0o022)
    main(sys.argv[1])
