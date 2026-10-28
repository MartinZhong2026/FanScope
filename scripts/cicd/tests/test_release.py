import hashlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sqlite_release as sql
import deploy_backend as deploy
import pull_release as pull


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.file = self.root / 'synthetic.sqlite'
        self.db = sqlite3.connect(self.file)
        self.db.executescript('''PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE journals(id TEXT PRIMARY KEY);
            CREATE TABLE articles(id TEXT PRIMARY KEY, journal TEXT REFERENCES journals(id),
              market TEXT,analysis_json TEXT,analysis_status TEXT);
            CREATE TABLE jobs(id INTEGER PRIMARY KEY,status TEXT);
            CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE analysis_batch_items(status TEXT);
            CREATE TABLE analysis_usage_log(status TEXT);
            CREATE TABLE lab_projects(id TEXT PRIMARY KEY,title TEXT);
            CREATE TABLE blob_data(id TEXT PRIMARY KEY,payload BLOB) WITHOUT ROWID;
            INSERT INTO journals VALUES('synthetic');
            INSERT INTO articles VALUES('en','synthetic','international','{"preserve":1}','analyzed');
            INSERT INTO articles VALUES('zh','synthetic','chinese','','pending');
            INSERT INTO lab_projects VALUES('lab','Preserve Lab');
            INSERT INTO blob_data VALUES('blob',x'0001ff');
        ''')
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_online_wal_backup_restore_all_tables_and_source_unchanged(self):
        before = sql.inspect(self.file)
        result = sql.backup(self.file, self.root / 'snapshot')
        self.assertEqual(before, result['manifest'])
        self.assertEqual(before, sql.inspect(self.file))
        self.assertEqual(before, sql.inspect(self.root / 'snapshot/restore.sqlite'))
        self.db.execute("UPDATE lab_projects SET title='changed'")
        self.db.commit()
        sql.restore(self.root / 'snapshot/backup.sqlite', self.file)
        self.assertEqual(before, sql.inspect(self.file))
        with self.assertRaises(FileExistsError):
            sql.backup(self.file, self.root / 'snapshot')

    def test_committed_snapshot_excludes_uncommitted_writes(self):
        before = sql.inspect(self.file)
        self.db.execute("UPDATE lab_projects SET title='uncommitted'")
        result = sql.backup(self.file, self.root / 'snapshot')
        self.assertEqual(before, result['manifest'])
        self.db.rollback()

    def test_foreign_key_violation_is_rejected(self):
        self.db.execute('PRAGMA foreign_keys=OFF')
        self.db.execute("INSERT INTO articles VALUES('bad','missing','chinese','','pending')")
        self.db.commit()
        with self.assertRaisesRegex(RuntimeError, 'foreign key'):
            sql.backup(self.file, self.root / 'bad')
        self.assertFalse((self.root / 'bad/verified.json').exists())

    def test_pause_retains_paid_claims_and_never_resumes(self):
        self.db.execute("INSERT INTO meta VALUES('ai-auto:v14:control',?)",
                        (json.dumps({'state': 'running', 'rateLimits': 2}),))
        self.db.commit()
        sql.pause_ai(self.file)
        state = json.loads(self.db.execute('SELECT value FROM meta').fetchone()[0])
        self.assertEqual(state, {'state': 'paused', 'rateLimits': 2, 'reason': 'deployment'})
        sql.assert_idle(self.file)
        self.db.execute("INSERT INTO analysis_usage_log VALUES('uncertain')")
        self.db.commit()
        with self.assertRaisesRegex(RuntimeError, 'uncertain'):
            sql.assert_idle(self.file)
        self.assertEqual(self.db.execute('SELECT status FROM analysis_usage_log').fetchone()[0], 'uncertain')

    def test_stale_running_job_blocks_release_without_reset(self):
        self.db.execute("INSERT INTO jobs VALUES(1,'running')")
        self.db.commit()
        with self.assertRaisesRegex(RuntimeError, 'jobs'):
            sql.assert_idle(self.file)
        self.assertEqual(self.db.execute('SELECT status FROM jobs').fetchone()[0], 'running')

    def test_missing_production_database_is_never_created(self):
        with self.assertRaises(FileNotFoundError):
            sql.backup(self.root / 'missing.sqlite', self.root / 'missing-backup')
        with self.assertRaisesRegex(RuntimeError, 'missing'):
            sql.restore(self.file, self.root / 'missing.sqlite')
        self.assertFalse((self.root / 'missing.sqlite').exists())

    def test_empty_stopped_database_needs_no_wal_sidecars(self):
        self.db.close()
        self.db = sqlite3.connect(self.file)
        self.assertEqual(sql.backup(self.file, self.root / 'stopped')['integrity'], 'ok')


class ArtifactTests(unittest.TestCase):
    def make_zip(self, names):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            for name in names:
                archive.writestr(name, b'synthetic')
        data = stream.getvalue()
        return data, {'digest': 'sha256:' + hashlib.sha256(data).hexdigest()}

    def test_digest_and_path_traversal_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, artifact = self.make_zip(['../escape'])
            with self.assertRaisesRegex(RuntimeError, 'members'):
                pull.extract_verified(data, artifact, Path(tmp) / 'out', {'approved.json'})
            data, artifact = self.make_zip(['approved.json'])
            with self.assertRaisesRegex(RuntimeError, 'digest'):
                pull.extract_verified(data + b'tamper', artifact, Path(tmp) / 'out', {'approved.json'})
            pull.extract_verified(data, artifact, Path(tmp) / 'valid', {'approved.json'})
            self.assertTrue((Path(tmp) / 'valid/approved.json').is_file())
            download = Path(tmp) / 'download.zip'
            download.write_bytes(data)
            pull.extract_verified(download, artifact, Path(tmp) / 'streamed', {'approved.json'})
            self.assertTrue((Path(tmp) / 'streamed/approved.json').is_file())

    def test_only_new_successful_dispatch_of_pinned_main_workflow_is_eligible(self):
        run = dict(workflow_id=123, head_repository={'full_name': pull.REPO}, head_branch='main',
                   head_sha='a' * 40, event='workflow_dispatch', status='completed',
                   conclusion='success', run_attempt=1, run_number=10)
        self.assertTrue(pull.eligible(run, 123, 'a' * 40, 9))
        for key, value in [('event', 'pull_request'), ('head_sha', 'b' * 40), ('head_branch', 'feature'),
                           ('conclusion', 'failure'), ('run_attempt', 2), ('workflow_id', 1), ('run_number', 9)]:
            self.assertFalse(pull.eligible({**run, key: value}, 123, 'a' * 40, 9))

    def test_release_bundle_sha_checksums_and_no_automatic_migration(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / 'image.tar').write_bytes(b'synthetic image')
            m = {'commit': 'a' * 40, 'image': 'sha256:' + 'b' * 64, 'migrationPolicy': 'no-change'}
            (p / 'manifest.json').write_text(json.dumps(m))
            (p / 'SHA256SUMS').write_text(''.join(sql.sha256(p / n) + '  ' + n + '\n'
                                                  for n in ['image.tar', 'manifest.json']))
            self.assertEqual(deploy.verify_bundle(p, 'a' * 40), m)
            with self.assertRaisesRegex(RuntimeError, 'manifest'):
                deploy.verify_bundle(p, 'c' * 40)
            (p / 'image.tar').write_bytes(b'tampered')
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                deploy.verify_bundle(p, 'a' * 40)


class RollbackTests(unittest.TestCase):
    setUp = DatabaseTests.setUp
    tearDown = DatabaseTests.tearDown
    def test_rollback_restores_changed_lab_and_schema_before_old_image(self):
        sql.pause_ai(self.file)
        state = self.root / 'state'
        state.mkdir()
        release = self.root / 'release'
        release.mkdir()
        baseline = sql.backup(self.file, release / 'frozen')['manifest']
        self.db.executescript("ALTER TABLE articles ADD COLUMN bad TEXT; UPDATE lab_projects SET title='damaged';")
        report = {'database': str(self.file), 'backup': str(release), 'previousImage': 'old', 'commit': 'a' * 40}
        (state / 'maintenance').touch()
        sql.write_json(state / 'transaction.json', report)
        calls = []
        def compose(image, *args):
            self.assertEqual(sql.inspect(self.file), baseline)
            calls.append(image)
        with patch.object(deploy, 'STATE', state), patch.object(deploy, 'docker_json', return_value={'State': {'Running': False}}), \
                patch.object(deploy, 'compose', side_effect=compose), patch.object(deploy, 'health'), patch.object(deploy, 'public_health'):
            deploy.rollback(report)
        self.assertEqual(calls, ['old'])
        self.assertEqual(sql.inspect(self.file), baseline)
        self.assertTrue((release / 'failed-startup/backup.sqlite').exists())
        self.assertFalse((state / 'maintenance').exists())

    def test_rollback_health_failure_retains_maintenance_and_transaction(self):
        state = self.root / 'state'
        state.mkdir()
        release = self.root / 'release'
        release.mkdir()
        sql.backup(self.file, release / 'frozen')
        report = {'database': str(self.file), 'backup': str(release), 'previousImage': 'old'}
        (state / 'maintenance').touch()
        sql.write_json(state / 'transaction.json', report)
        with patch.object(deploy, 'STATE', state), patch.object(deploy, 'docker_json', return_value={'State': {'Running': False}}), \
                patch.object(deploy, 'compose'), patch.object(deploy, 'health', side_effect=RuntimeError('unhealthy')):
            with self.assertRaisesRegex(RuntimeError, 'unhealthy'):
                deploy.rollback(report)
        self.assertTrue((state / 'maintenance').exists())
        self.assertTrue((state / 'transaction.json').exists())


class PipelineTests(unittest.TestCase):
    setUp = DatabaseTests.setUp
    tearDown = DatabaseTests.tearDown

    def exercise(self, damaged=False, bad_ingress=False):
        state = self.root / 'state'
        state.mkdir()
        (state / 'backups').mkdir()
        bundle = self.root / 'bundle'
        bundle.mkdir()
        sha = 'a' * 40
        old_image, new_image = 'sha256:' + '1' * 64, 'sha256:' + '2' * 64
        (bundle / 'image.tar').write_bytes(b'synthetic image')
        (bundle / 'manifest.json').write_text(json.dumps({'commit': sha, 'image': new_image, 'migrationPolicy': 'no-change'}))
        (bundle / 'SHA256SUMS').write_text(''.join(sql.sha256(bundle / n) + '  ' + n + '\n' for n in ['image.tar', 'manifest.json']))
        container = {'Image': old_image, 'State': {'Running': True, 'ExitCode': 0},
                     'Config': {'Labels': {'com.docker.compose.project': 'deploy', 'com.docker.compose.service': 'fanscope-api'},
                                'Cmd': ['node', '--experimental-sqlite', 'src/v14-server.mjs']},
                     'Mounts': [{'Destination': '/app/data', 'Name': 'fanscope_data'}]}
        # Use the fixture name expected by the actual host controller.
        self.db.close()
        old_file = self.file
        self.file = self.root / 'fanscope.sqlite'
        old_file.rename(self.file)
        self.db = sqlite3.connect(self.file)
        events = []
        def docker_json(*args):
            if args[:2] == ('volume', 'inspect'):
                return {'Mountpoint': str(self.root)}
            if args[:2] == ('image', 'inspect'):
                return {'Id': new_image, 'Config': {'Labels': {'org.opencontainers.image.revision': sha}}}
            return container
        def compose(image, *args):
            if args[0] == 'config':
                return json.dumps({'services': {'fanscope-api': {'image': new_image, 'container_name': 'fanscope-api',
                    'volumes': [{'target': '/app/data', 'type': 'volume', 'source': 'fanscope_data'}],
                    'environment': {'FANSCOPE_AI_AUTO_ENABLED': 'false'}}}, 'volumes': {'fanscope_data': {'external': True}}})
            self.assertEqual(args[-1], 'fanscope-api')
            events.append(image)
            container.update(Image=image, State={'Running': True, 'ExitCode': 0})
            if image == new_image and damaged:
                self.db.executescript("CREATE TABLE candidate_migration(id INTEGER); UPDATE lab_projects SET title='damaged';")
        def stop():
            container['State']['Running'] = False
        def ingress():
            self.assertFalse(self.db.execute("SELECT 1 FROM meta WHERE key='ai-auto:v14:control'").fetchone())
            if bad_ingress:
                raise RuntimeError('ingress open')
        import types
        with patch.object(deploy, 'STATE', state), patch.object(deploy, 'docker_json', side_effect=docker_json), \
                patch.object(deploy, 'compose', side_effect=compose), patch.object(deploy, 'stop', side_effect=stop), \
                patch.object(deploy, 'run'), patch.object(deploy.subprocess, 'run', return_value=types.SimpleNamespace(stdout='if (-f /var/lib/fanscope-cd/maintenance)', stderr='')), \
                patch.object(deploy, 'verify_ingress_closed', side_effect=ingress), patch.object(deploy, 'health'), \
                patch.object(deploy, 'public_health'), patch.object(deploy, 'rehearsal'):
            if damaged or bad_ingress:
                with self.assertRaisesRegex(RuntimeError, 'Production data changed|ingress open'):
                    deploy.deploy(bundle, sha, 123)
            else:
                result = deploy.deploy(bundle, sha, 123)
                self.assertEqual(result['status'], 'success')
        release = next((state / 'backups').iterdir())
        result = json.loads((release / 'result.json').read_text())
        if bad_ingress:
            self.assertEqual(events, [])
            self.assertTrue((state / 'maintenance').exists())
        else:
            self.assertEqual(events, [new_image, old_image] if damaged else [new_image])
            baseline = json.loads((release / 'frozen/verified.json').read_text())['manifest']
            self.assertEqual(sql.inspect(self.file), baseline)
            self.assertEqual(result['status'], 'rolled-back' if damaged else 'success')
            self.assertFalse((state / 'maintenance').exists())

    def test_complete_release_orchestration_preserves_all_data(self):
        self.exercise()

    def test_startup_data_change_triggers_database_and_image_rollback(self):
        self.exercise(damaged=True)

    def test_unclosed_ingress_prevents_any_database_write_or_container_update(self):
        self.exercise(bad_ingress=True)


if __name__ == '__main__':
    unittest.main()
