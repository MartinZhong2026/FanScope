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
        with patch.object(deploy, 'STATE', state), patch.object(deploy, 'docker_json', return_value={'State': {'Running': True}}), \
                patch.object(deploy, 'stop') as stop, patch.object(deploy, 'compose', side_effect=compose), patch.object(deploy, 'health'), patch.object(deploy, 'public_health'):
            deploy.rollback(report)
            stop.assert_called_once_with(require_graceful=False)
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


class PullRetryTests(unittest.TestCase):
    def test_failed_download_leaves_nothing_that_blocks_the_next_poll(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            (state / 'incoming/123/approval').mkdir(parents=True)
            (state / 'incoming/download-1.zip').write_bytes(b'partial')
            with patch.object(pull, 'STATE', state), patch.object(pull, 'pull', side_effect=OSError('network')):
                with self.assertRaises(OSError):
                    pull.main()
            self.assertEqual(list((state / 'incoming').iterdir()), [])


class PipelineTests(unittest.TestCase):
    setUp = DatabaseTests.setUp
    tearDown = DatabaseTests.tearDown

    def exercise(self, damaged=False, bad_ingress=False, migration=None, gate_fails=False):
        state = self.root / 'state'
        state.mkdir()
        (state / 'backups').mkdir()
        (state / 'runtime').mkdir()
        with patch.object(deploy, 'STATE', state):
            deploy.write_gate('open', 'install', 0, 'installed')
        bundle = self.root / 'bundle'
        bundle.mkdir()
        sha = 'a' * 40
        old_image, new_image = 'sha256:' + '1' * 64, 'sha256:' + '2' * 64
        (bundle / 'image.tar').write_bytes(b'synthetic image')
        declared = {'tables': ['dx_new'], 'indexes': [], 'columns': [], 'virtualTables': []}
        pending = [{'id': '20261030T060000Z_new', 'checksum': 'c' * 64}]
        (bundle / 'manifest.json').write_text(json.dumps({'commit': sha, 'image': new_image, 'migrationPolicy': 'additive' if migration else 'no-change',
            'migrations': [{**pending[0], 'declared': declared}] if migration else []}))
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
        def stop(**kwargs):
            container['State']['Running'] = False
        def ingress():
            self.assertFalse(self.db.execute("SELECT 1 FROM meta WHERE key='ai-auto:v14:control'").fetchone())
            if bad_ingress:
                raise RuntimeError('ingress open')
        def apply_production(image, user, items, commit):
            self.assertEqual((image, user, items, commit), (new_image, 'node', pending, sha))
            self.assertFalse(container['State']['Running'], 'API must be stopped during migration')
            db = sqlite3.connect(self.file)
            db.executescript(migration)
            db.close()
        import types
        real_open = deploy.open_gate
        def open_gate(*args):
            if gate_fails:
                raise OSError('disk full')
            return real_open(*args)
        with patch.object(deploy, 'STATE', state), patch.object(deploy, 'apply_production', side_effect=apply_production), \
                patch.object(deploy, 'rehearse_release', return_value=pending if migration else []), patch.object(deploy, 'open_gate', side_effect=open_gate), \
                patch.object(deploy, 'save_candidate_log'), patch.object(deploy, 'docker_json', side_effect=docker_json), \
                patch.object(deploy, 'compose', side_effect=compose), patch.object(deploy, 'stop', side_effect=stop), \
                patch.object(deploy, 'run'), patch.object(deploy.subprocess, 'run', return_value=types.SimpleNamespace(stdout='if (-f /var/lib/fanscope-cd/maintenance)', stderr='')), \
                patch.object(deploy, 'verify_ingress_closed', side_effect=ingress), patch.object(deploy, 'health'), \
                patch.object(deploy, 'public_health'), patch.object(deploy, 'rehearsal'):
            rejected = migration and 'UPDATE' in migration
            if gate_fails:
                with self.assertRaisesRegex(OSError, 'disk full'):
                    deploy.deploy(bundle, sha, 123)
            elif damaged or bad_ingress or rejected:
                with self.assertRaisesRegex(RuntimeError, 'Production data changed|ingress open|existing rows'):
                    deploy.deploy(bundle, sha, 123)
            else:
                result = deploy.deploy(bundle, sha, 123)
                self.assertEqual(result['status'], 'success')
        release = next((state / 'backups').iterdir())
        result = json.loads((release / 'result.json').read_text())
        if gate_fails:
            # Released fine, but background work must stay stopped until an operator acts.
            self.assertEqual(result['status'], 'success-gate-blocked')
            self.assertEqual(json.loads((state / 'runtime/gate.json').read_text())['state'], 'blocked')
            return
        if migration:
            baseline = json.loads((release / 'frozen/verified.json').read_text())['manifest']
            tables = {r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if rejected:
                self.assertEqual(events, [old_image], 'candidate must never start')
                self.assertEqual(sql.inspect(self.file), baseline)
                self.assertEqual((result['status'], result['stage']), ('rolled-back', 'migration'))
                self.assertIn('existing rows', result['failureMessage'])
            else:
                self.assertEqual(events, [new_image])
                self.assertIn('dx_new', tables)
                self.assertEqual((result['status'], result['migrations']), ('success', [pending[0]['id']]))
            self.assertEqual(json.loads((state / 'runtime/gate.json').read_text())['state'], 'open')
            self.assertFalse((state / 'maintenance').exists())
            return
        if bad_ingress:
            self.assertEqual(events, [])
            self.assertTrue((state / 'maintenance').exists())
        else:
            self.assertEqual(events, [new_image, old_image] if damaged else [new_image])
            baseline = json.loads((release / 'frozen/verified.json').read_text())['manifest']
            self.assertEqual(sql.inspect(self.file), baseline)
            self.assertEqual(result['status'], 'rolled-back' if damaged else 'success')
            self.assertFalse((state / 'maintenance').exists())
        gate = json.loads((state / 'runtime/gate.json').read_text())
        self.assertEqual((gate['state'], gate['generation']), ('blocked' if bad_ingress else 'open', 1))
        self.assertEqual(result.get('stage'), 'ingress' if bad_ingress else 'startup' if damaged else 'public-health')

    def test_complete_release_orchestration_preserves_all_data(self):
        self.exercise()

    def test_startup_data_change_triggers_database_and_image_rollback(self):
        self.exercise(damaged=True)

    def test_unclosed_ingress_prevents_any_database_write_or_container_update(self):
        self.exercise(bad_ingress=True)

    def test_reviewed_migration_applies_to_stopped_production_database(self):
        self.exercise(migration='CREATE TABLE dx_new(id TEXT PRIMARY KEY);')

    def test_migration_touching_protected_rows_restores_the_frozen_snapshot(self):
        self.exercise(migration="CREATE TABLE dx_new(id TEXT PRIMARY KEY); UPDATE lab_projects SET title='rewritten';")

    def test_gate_open_failure_keeps_background_work_stopped(self):
        self.exercise(gate_fails=True)


class AdditiveTests(unittest.TestCase):
    setUp = DatabaseTests.setUp
    tearDown = DatabaseTests.tearDown
    declared = {'tables': ['dx_new'], 'indexes': ['idx_dx_new'], 'columns': ['articles.note'], 'virtualTables': []}

    def migrated(self, script):
        self.db.commit()
        result = sql.backup(self.file, self.root / 'snapshot')
        copy = self.root / 'snapshot/restore.sqlite'
        db = sqlite3.connect(copy)
        db.executescript(script)
        db.close()
        return self.root / 'snapshot/backup.sqlite', copy, result

    good = """CREATE TABLE dx_new(id TEXT PRIMARY KEY); CREATE INDEX idx_dx_new ON dx_new(id);
              ALTER TABLE articles ADD COLUMN note TEXT;
              CREATE TABLE fanscope_migrations(id TEXT PRIMARY KEY); """

    def test_declared_additions_pass_with_original_rows_intact(self):
        before, after, _ = self.migrated(self.good + "UPDATE articles SET note='new column may change';")
        sql.additive_check(before, after, self.declared)

    def test_second_migration_release_may_only_append_to_the_ledger(self):
        self.db.executescript("""CREATE TABLE fanscope_migrations(id TEXT PRIMARY KEY,checksum TEXT);
            INSERT INTO fanscope_migrations VALUES('1_first','a');""")
        before, after, _ = self.migrated("CREATE TABLE dx_new(id TEXT PRIMARY KEY); INSERT INTO fanscope_migrations VALUES('2_second','b');")
        sql.additive_check(before, after, self.declared)
        db = sqlite3.connect(after)
        db.execute("UPDATE fanscope_migrations SET checksum='forged' WHERE id='1_first'")
        db.commit()
        db.close()
        with self.assertRaisesRegex(RuntimeError, 'existing rows: fanscope_migrations'):
            sql.additive_check(before, after, self.declared)

    def test_every_violation_is_rejected(self):
        cases = {
            "UPDATE lab_projects SET title='x';": 'existing rows',
            "UPDATE articles SET analysis_json='x';": 'existing rows',
            'DROP TABLE lab_projects;': 'removed',
            'CREATE TABLE surprise(id INTEGER);': 'Undeclared new table',
            'CREATE INDEX idx_surprise ON articles(market);': 'Undeclared new index',
            'ALTER TABLE lab_projects ADD COLUMN surprise TEXT;': 'Undeclared new column',
            'CREATE VIEW v_surprise AS SELECT 1;': 'Undeclared new view',
            'ALTER TABLE articles DROP COLUMN market;': 'existing columns',
        }
        for index, (script, message) in enumerate(cases.items()):
            with self.subTest(script=script):
                self.root = Path(self.temp.name) / str(index)
                self.root.mkdir()
                self.file_copy = self.file
                before, after, _ = self.migrated(script)
                with self.assertRaisesRegex(RuntimeError, message):
                    sql.additive_check(before, after, self.declared)

    def test_reviewed_list_is_enforced_before_anything_runs(self):
        manifest = {'commit': 'a' * 40, 'migrationPolicy': 'additive', 'migrations': [{'id': '1_a', 'checksum': 'b' * 64, 'declared': {}}]}
        for status in ({'status': 'pending', 'pending': [{'id': '2_b', 'checksum': 'b' * 64}]},
                       {'status': 'pending', 'pending': [{'id': '1_a', 'checksum': 'c' * 64}]}):
            with patch.object(deploy, 'node_on_copy', return_value=json.dumps(status)):
                with self.assertRaisesRegex(RuntimeError, 'not in the reviewed manifest'):
                    deploy.migration_plan('image', self.root, manifest)
        with patch.object(deploy, 'node_on_copy', return_value=json.dumps({'status': 'checksum-mismatch', 'pending': []})):
            with self.assertRaisesRegex(RuntimeError, 'not releasable'):
                deploy.migration_plan('image', self.root, manifest)

    def test_rehearsal_runs_candidate_and_old_image_on_migrated_copy(self):
        before, after, frozen = self.migrated(self.good)
        manifest = {'commit': 'a' * 40, 'migrationPolicy': 'additive',
                    'migrations': [{'id': '1_a', 'checksum': 'b' * 64, 'declared': self.declared}]}
        pending = [{'id': '1_a', 'checksum': 'b' * 64}]
        calls = []
        with patch.object(deploy, 'migration_plan', return_value=pending), patch.object(deploy, 'node_on_copy'), \
                patch.object(deploy, 'rehearsal', side_effect=lambda image, *_: calls.append(image)):
            self.assertEqual(deploy.rehearse_release('new', 'old', after.parent, frozen, manifest), pending)
        self.assertEqual(calls, ['new', 'old'])

    def test_health_must_match_manifest_features(self):
        image = 'sha256:' + 'a' * 64
        base = {'status': 'ok', 'service': 'fanscope-api', 'commit': 'c' * 40}
        container = {'Image': image, 'State': {'Running': True, 'Health': {'Status': 'healthy'}}}
        for report, manifest, ok in [(base, {'commit': 'c' * 40}, True),
                                     ({**base, 'commit': 'd' * 40}, {'commit': 'c' * 40}, False),
                                     ({**base, 'scheduler': True}, {'commit': 'c' * 40}, False),
                                     ({**base, 'scheduler': True}, {'commit': 'c' * 40, 'schedulerEnabled': True}, True),
                                     ({**base, 'diagnostic': {'aiConfigured': True}}, {'commit': 'c' * 40}, False)]:
            with self.subTest(report=report), patch.object(deploy, 'docker_json', return_value=container),                     patch.object(deploy, 'run', return_value=json.dumps(report)):
                if ok:
                    deploy.health(image, manifest)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'does not match'):
                        deploy.health(image, manifest)

    def test_manifest_policy_requires_a_matching_migration_list(self):
        item = {'id': '20261030T060000Z_a', 'checksum': 'b' * 64, 'declared': {}}
        for manifest, ok in [({'migrationPolicy': 'additive', 'migrations': [item]}, True),
                             ({'migrationPolicy': 'no-change'}, True),
                             ({'migrationPolicy': 'additive', 'migrations': []}, False),
                             ({'migrationPolicy': 'no-change', 'migrations': [item]}, False),
                             ({'migrationPolicy': 'automatic'}, False),
                             ({'migrationPolicy': 'additive', 'migrations': [{'id': '../x', 'checksum': 'b' * 64, 'declared': {}}]}, False)]:
            with self.subTest(manifest=manifest), tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp)
                (p / 'image.tar').write_bytes(b'image')
                (p / 'manifest.json').write_text(json.dumps({'commit': 'a' * 40, 'image': 'sha256:' + 'b' * 64, **manifest}))
                (p / 'SHA256SUMS').write_text(''.join(sql.sha256(p / n) + '  ' + n + '\n' for n in ['image.tar', 'manifest.json']))
                if ok:
                    deploy.verify_bundle(p, 'a' * 40)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'manifest'):
                        deploy.verify_bundle(p, 'a' * 40)


class GateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name)
        (self.state / 'runtime').mkdir()
        self.patch = patch.object(deploy, 'STATE', self.state)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_missing_corrupt_or_blocked_gate_stops_a_release(self):
        with self.assertRaisesRegex(RuntimeError, 'recovery required'):
            deploy.block_gate('r1')
        (self.state / 'runtime/gate.json').write_text('{broken')
        with self.assertRaisesRegex(RuntimeError, 'recovery required'):
            deploy.block_gate('r1')
        deploy.write_gate('open', 'install', 0, 'installed')
        self.assertEqual(deploy.block_gate('r1')['generation'], 1)
        with self.assertRaisesRegex(RuntimeError, 'recovery required'):
            deploy.block_gate('r2')

    def test_only_the_matching_release_generation_can_open(self):
        deploy.write_gate('open', 'install', 0, 'installed')
        deploy.block_gate('r1')
        for release, generation in [('r2', 1), ('r1', 2)]:
            with self.assertRaisesRegex(RuntimeError, 'identity mismatch'):
                deploy.open_gate(release, generation)
        self.assertEqual(deploy.read_gate()['state'], 'blocked')
        self.assertEqual(deploy.open_gate('r1', 1)['state'], 'open')

    def test_overdue_hold_alerts_but_stays_blocked(self):
        deploy.write_gate('open', 'install', 0, 'installed')
        deploy.block_gate('r1')
        self.assertEqual(deploy.gate_status(), 0)
        gate = deploy.read_gate()
        gate['alert_after'] = '2020-01-01T00:00:00+00:00'
        (self.state / 'runtime/gate.json').write_text(json.dumps(gate))
        self.assertEqual(deploy.gate_status(), 3)
        self.assertEqual(deploy.read_gate()['state'], 'blocked')

    def test_recover_gate_needs_exact_generation_and_no_open_transaction(self):
        deploy.write_gate('open', 'install', 0, 'installed')
        deploy.block_gate('r1')
        with self.assertRaisesRegex(RuntimeError, 'exact generation'):
            deploy.recover_gate(9)
        (self.state / 'maintenance').touch()
        with self.assertRaisesRegex(RuntimeError, 'recover --confirm-sha'):
            deploy.recover_gate(1)
        (self.state / 'maintenance').unlink()
        with patch.object(deploy, 'docker_json', return_value={'Image': 'x', 'Mountpoint': self.temp.name}), \
                patch.object(deploy, 'health', side_effect=RuntimeError('unhealthy')):
            with self.assertRaisesRegex(RuntimeError, 'unhealthy'):
                deploy.recover_gate(1)
        self.assertEqual(deploy.read_gate()['state'], 'blocked')
        with patch.object(deploy, 'docker_json', return_value={'Image': 'x', 'Mountpoint': self.temp.name}), \
                patch.object(deploy, 'health'), patch.object(deploy, 'inspect'), patch.object(deploy, 'public_health'):
            self.assertEqual(deploy.recover_gate(1)['state'], 'open')

    def test_failure_text_is_redacted(self):
        self.assertEqual(deploy.safe_text('failed Bearer abc123 token=xyz'), 'failed Bearer [redacted] token=[redacted]')


class RuntimeGuardTests(unittest.TestCase):
    def test_old_runtime_must_drain_but_failed_candidate_can_be_rolled_back(self):
        with patch.object(deploy, 'run'), patch.object(deploy, 'docker_json', return_value={'State': {'Running': False, 'ExitCode': 137}}):
            with self.assertRaisesRegex(RuntimeError, 'drain gracefully'):
                deploy.stop()
            deploy.stop(require_graceful=False)
        with patch.object(deploy, 'run'), patch.object(deploy, 'docker_json', return_value={'State': {'Running': True, 'ExitCode': 137}}):
            with self.assertRaises(RuntimeError):
                deploy.stop(require_graceful=False)

    def test_public_health_rejects_another_project_with_status_ok(self):
        response = io.BytesIO(json.dumps({'status': 'ok', 'service': 'another-project'}).encode())
        response.status = 200
        with patch.object(deploy.urllib.request, 'urlopen', return_value=response):
            with self.assertRaisesRegex(RuntimeError, 'HTTPS API guard'):
                deploy.public_health()


if __name__ == '__main__':
    unittest.main()
