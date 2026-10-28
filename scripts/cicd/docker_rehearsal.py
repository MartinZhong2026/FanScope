"""Real isolated Docker/Compose rehearsal. No production names, ports, keys or network.

Exercises the production backup, startup gate, health, graceful stop and DB rollback.
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from unittest.mock import patch
import deploy_backend as deploy
from sqlite_release import backup, inspect, write_json


def main(image):
    suffix = uuid.uuid4().hex[:12]
    name = 'fanscope-ci-' + suffix
    project = 'fanscope-ci-' + suffix
    root = Path(__file__).resolve().parents[2]
    (root / 'work').mkdir(exist_ok=True)
    original = [json.loads(line) for line in deploy.run('docker', 'ps', '--format', 'json').splitlines()]
    identity = [(c['ID'], c['Names']) for c in original]
    with tempfile.TemporaryDirectory(prefix='cicd-', dir=root / 'work') as temp:
        directory = Path(temp).resolve()
        data = directory / 'data'
        data.mkdir()
        seed = """
        await import('./src/server.mjs');const{db}=await import('./src/db.mjs');
        const insert=db.prepare(`INSERT INTO articles(id,journal_id,market,title,discovered_at,source,analysis_status)
          VALUES(?,?,?,'Synthetic CI paper','2026-01-01','crossref','pending')`);
        insert.run('ci-en','jmir','international');insert.run('ci-zh','candidate-1','chinese');
        db.prepare("INSERT INTO lab_projects(id,title,updated_at,created_by) VALUES('ci-lab','Preserve Lab','2026-01-01','synthetic')").run();
        db.prepare("INSERT INTO meta VALUES('ai-auto:v14:control',?)").run(JSON.stringify({state:'paused'}));db.close();
        """
        deploy.run('docker', 'run', '--rm', '--network', 'none', '--user', '0:0',
            '--mount', f'type=bind,source={data},target=/app/data',
            '--entrypoint', 'node', image, '--experimental-sqlite', '--input-type=module', '-e', seed)
        database = data / 'fanscope.sqlite'
        frozen = backup(database, directory / 'frozen')
        deploy.rehearsal(image, directory / 'frozen', frozen['manifest'])
        spec = {
            'services': {'fanscope-api': {
                'image': image, 'container_name': name, 'network_mode': 'none', 'user': '0:0',
                'command': ['node', '--experimental-sqlite', 'src/v14-server.mjs'],
                'environment': {'NODE_ENV': 'production', 'FANSCOPE_V14_RUNTIME': 'true',
                    'DATABASE_PATH': '/app/data/fanscope.sqlite', 'ADMIN_KEY': 'synthetic-ci-only-not-a-real-secret',
                    'FANSCOPE_AI_AUTO_ENABLED': 'false', 'FANSCOPE_ENGLISH_MONITOR': 'false',
                    'DEEPSEEK_API_KEY': '', 'RESEND_API_KEY': ''},
                'volumes': [{'type': 'bind', 'source': str(data), 'target': '/app/data'}],
                'healthcheck': {'test': ['CMD', 'node', '-e',
                    "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                    'interval': '1s', 'timeout': '3s', 'retries': 10}}}}
        file = directory / 'compose.json'
        file.write_text(json.dumps(spec))
        def compose(selected, *args):
            current = json.loads(file.read_text())
            current['services']['fanscope-api']['image'] = selected
            file.write_text(json.dumps(current))
            return deploy.run('docker', 'compose', '-p', project, '-f', str(file), *args)
        def public_probe():
            deploy.run('docker', 'exec', name, 'node', '--input-type=module', '-e',
                "for(const market of ['international','chinese']){const r=await fetch('http://127.0.0.1:8787/api/stats?market='+market+'&period=all&article_type=all');"
                "if(!r.ok||(await r.json()).count!==1)throw Error('Existing paper data missing')}"
                "const h=await(await fetch('http://127.0.0.1:8787/api/health')).json();if(h.aiConfigured||h.emailConfigured)throw Error('Paid keys enabled')")
        try:
            with patch.object(deploy, 'CONTAINER', name), patch.object(deploy, 'STATE', directory), \
                    patch.object(deploy, 'compose', side_effect=compose), patch.object(deploy, 'public_health', side_effect=public_probe):
                compose(image, 'up', '-d', '--no-build', '--no-deps', 'fanscope-api')
                actual = deploy.docker_json('inspect', name)['Image']
                deploy.health(actual)
                public_probe()
                assert inspect(database) == frozen['manifest'], 'Start modified protected data'
                # Online backup while the real container holds WAL connections.
                assert backup(database, directory / 'online')['manifest'] == frozen['manifest']
                deploy.stop()
                # A failed candidate and unexpected migration must restore DB before restart.
                bad = directory / 'bad.json'
                bad.write_text(json.dumps({'services': {'fanscope-api': {'command': ['node', '-e', 'process.exit(17)']}}}))
                deploy.run('docker', 'compose', '-p', project, '-f', str(file), '-f', str(bad), 'up', '-d', '--no-build', 'fanscope-api')
                try:
                    deploy.health(actual)
                except RuntimeError:
                    pass
                else:
                    raise AssertionError('Bad candidate unexpectedly healthy')
                c = deploy.docker_json('inspect', name)
                if c['State']['Running']:
                    deploy.run('docker', 'wait', name)
                db = sqlite3.connect(database)
                db.executescript("CREATE TABLE bad_migration(id INTEGER); UPDATE lab_projects SET title='damaged candidate';")
                db.close()
                record = {'database': str(database), 'backup': str(directory), 'previousImage': actual,
                          'commit': 'a' * 40, 'status': 'frozen'}
                (directory / 'maintenance').touch()
                write_json(directory / 'transaction.json', record)
                deploy.rollback(record)
                assert inspect(database) == frozen['manifest']
                assert not (directory / 'maintenance').exists()
                assert (directory / 'failed-startup/backup.sqlite').is_file()
                deploy.stop()
                # Reject a changed schema on the rehearsal copy without touching original.
                db = sqlite3.connect(directory / 'frozen/restore.sqlite')
                db.execute('CREATE TABLE incompatible_schema(id INTEGER)')
                db.close()
                try:
                    deploy.rehearsal(image, directory / 'frozen', frozen['manifest'])
                except RuntimeError:
                    pass
                else:
                    raise AssertionError('Schema-changing startup accepted')
        finally:
            # Only this test's uniquely named container, never volumes or other projects.
            subprocess.run(['docker', 'rm', '-f', name], check=True, stdout=subprocess.DEVNULL)
        remaining = deploy.run('docker', 'ps', '--format', '{{.ID}} {{.Names}}').splitlines()
        assert all(cid + ' ' + cname in remaining for cid, cname in identity), 'Unrelated container changed'
        print(json.dumps({'dockerRehearsal': 'PASS', 'onlineBackup': 'PASS', 'dataRestore': 'PASS',
                          'unhealthyRollback': 'PASS', 'schemaChangeRejected': True, 'unrelatedContainersPreserved': len(identity)}))


if __name__ == '__main__':
    os.umask(0o077)
    main(sys.argv[1])
