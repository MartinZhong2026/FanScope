"""Reviewed plan helper; source is read-only. No app imports or production execution.
Usage: python3 chinese-online-backup.py EXISTING_SOURCE NEW_PRIVATE_DIRECTORY
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import time


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def connect_ro(file):
    return sqlite3.connect(file.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)


def manifest(db):
    schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    result = {'schemaSha256': hashlib.sha256(json.dumps(schema).encode()).hexdigest(), 'tables': {}}
    for name in tables:
        info = db.execute('PRAGMA table_info(' + quote(name) + ')').fetchall()
        keys = [r[1] for r in sorted(info, key=lambda r: r[5]) if r[5]]
        order = ','.join(map(quote, keys)) if keys else 'rowid'
        digest, count = hashlib.sha256(), 0
        for row in db.execute('SELECT * FROM ' + quote(name) + ' ORDER BY ' + order):
            values = [('blob', v.hex()) if isinstance(v, bytes) else (type(v).__name__, v) for v in row]
            digest.update(json.dumps(values, ensure_ascii=True, separators=(',', ':')).encode() + b'\n')
            count += 1
        result['tables'][name] = {'count': count, 'sha256': digest.hexdigest()}
    required = {'articles', 'jobs'}
    if not required.issubset(tables):
        raise RuntimeError('Required production tables missing; stop and review schema')
    columns = {r[1] for r in db.execute('PRAGMA table_info(articles)')}
    if not {'market', 'analysis_json', 'analysis_status'}.issubset(columns):
        raise RuntimeError('Expected article fields missing; stop and review schema')
    result['keyCounts'] = {
        'english': db.execute("SELECT count(*) FROM articles WHERE market='international'").fetchone()[0],
        'aiJsonPresent': db.execute("SELECT count(*) FROM articles WHERE analysis_json IS NOT NULL AND analysis_json!=''").fetchone()[0],
        'analyzed': db.execute("SELECT count(*) FROM articles WHERE analysis_status='analyzed'").fetchone()[0],
        'jobs': result['tables']['jobs']['count'],
    }
    return result


def verify(file, expected):
    with connect_ro(file) as db:
        db.execute('PRAGMA query_only=ON')
        integrity = db.execute('PRAGMA integrity_check').fetchall()
        fk_count = sum(1 for _ in db.execute('PRAGMA foreign_key_check'))
        actual = manifest(db)
        if integrity != [('ok',)] or fk_count or actual != expected:
            raise RuntimeError('Isolated integrity, foreign-key or exact manifest comparison failed')
    db.close()


def main():
    source, output = map(lambda s: Path(s).resolve(), sys.argv[1:])
    if not source.is_file() or output.exists() or source.parent == output:
        raise RuntimeError('Existing source and NEW separate private directory required')
    if not all(Path(str(source) + ext).is_file() for ext in ('-wal', '-shm')):
        raise RuntimeError('Require existing WAL/SHM; never create them or use immutable on production')
    os.umask(0o077)
    output.mkdir(mode=0o700)  # Atomic refusal if another run already reserved this path.
    (output / 'pid').write_text(str(os.getpid()))
    backup, restored = output / 'backup.sqlite', output / 'restore.sqlite'
    started, initial_wal = time.monotonic(), Path(str(source) + '-wal').stat().st_size

    def budget():
        if time.monotonic() - started > 60:
            raise RuntimeError('60 second snapshot budget exceeded')
        if shutil.disk_usage(output).free < 2 * 1024**3:
            raise RuntimeError('Free disk below 2 GiB')
        if Path(str(source) + '-wal').stat().st_size - initial_wal > 128 * 1024**2:
            raise RuntimeError('WAL growth exceeded 128 MiB')
        return 0

    src = connect_ro(source)
    try:
        src.execute('PRAGMA query_only=ON')
        if src.execute('PRAGMA journal_mode').fetchone()[0] != 'wal':
            raise RuntimeError('Source is not WAL; do not change its journal mode')
        src.set_progress_handler(budget, 10000)
        src.execute('BEGIN')
        src.execute('SELECT count(*) FROM sqlite_master').fetchone()  # Pin one committed snapshot.
        snapshot_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        baseline = manifest(src)
        budget()
        fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        dst = sqlite3.connect(backup)
        try:
            def progress(status, remaining, total):
                budget()
                if status not in (sqlite3.SQLITE_OK, sqlite3.SQLITE_DONE):
                    raise RuntimeError('Backup busy/locked/error; no automatic retries')
                if remaining:
                    time.sleep(0.02)  # Explicit pacing; backup(sleep=...) only handles busy retries.
            src.backup(dst, pages=128, progress=progress, sleep=0.05)
        finally:
            dst.close()
        src.execute('ROLLBACK')  # End read transaction; no source data writes.
    finally:
        src.close()
    # Source is closed before expensive integrity and restore checks.
    verify(backup, baseline)
    with backup.open('rb') as srcfile, restored.open('xb') as target:
        shutil.copyfileobj(srcfile, target, 1024 * 1024)
        target.flush()
        os.fsync(target.fileno())
    verify(restored, baseline)
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (backup, restored)}
    if len(set(hashes.values())) != 1:
        raise RuntimeError('Completed backup and restore file hashes differ')
    report = {'status': 'PASS', 'snapshotAt': snapshot_at, 'elapsedSeconds': round(time.monotonic() - started, 2),
              'integrity': 'ok', 'foreignKeyViolations': 0, 'allTablesAndSchemaMatch': True,
              'manifest': baseline, 'fileSha256': hashes}
    with (output / 'verified.json').open('x') as file:
        json.dump(report, file, indent=2)
        file.flush()
        os.fsync(file.fileno())
    print(json.dumps({k: v for k, v in report.items() if k != 'manifest'}))


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('STOP: no verified.json means this run is NOT accepted; retain partial files privately. Source connection is closed on exit.', file=sys.stderr)
        raise
