"""SQLite backup/restore without importing application code or running migrations.

Every table (including Lab, usage claims and Chinese data) is fingerprinted.
Only an explicitly frozen deployment may restore, with the API container stopped.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time


def ro(file):
    file = Path(file).resolve(strict=True)
    return sqlite3.connect(file.as_uri() + '?mode=ro', uri=True, timeout=5)


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def fingerprint(db):
    schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
    tables = {}
    for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        info = db.execute('PRAGMA table_info(' + quote(name) + ')').fetchall()
        # Stream in a deterministic total order, also supporting WITHOUT ROWID.
        # typeof breaks numeric int/real ties without loading the corpus into RAM.
        columns = [c[1] for c in info]
        order = ','.join([quote(c) for c in columns] + ['typeof(' + quote(c) + ')' for c in columns])
        digest, count = hashlib.sha256(), 0
        for row in db.execute('SELECT * FROM ' + quote(name) + ' ORDER BY ' + order):
            encoded = json.dumps([('blob', v.hex()) if isinstance(v, bytes) else (type(v).__name__, v)
                                  for v in row], ensure_ascii=True, separators=(',', ':'))
            digest.update(encoded.encode() + b'\n')
            count += 1
        tables[name] = {'count': count, 'sha256': digest.hexdigest(), 'columns': columns}
    return {'schema': hashlib.sha256(json.dumps(schema).encode()).hexdigest(), 'tables': tables}


def inspect(file):
    db = ro(file)
    try:
        db.execute('BEGIN')
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise RuntimeError('SQLite integrity check failed')
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise RuntimeError('SQLite foreign key check failed')
        return fingerprint(db)
    finally:
        db.close()


def sha256(file):
    with open(file, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def backup(source, output):
    output = Path(output)
    output.mkdir(mode=0o700)  # Exclusive reservation, never reuse a backup.
    source = Path(source).resolve(strict=True)
    if shutil.disk_usage(output).free < max(source.stat().st_size * 4, 256 * 1024**2):
        raise RuntimeError('Insufficient backup/restore free space')
    target, restored = output / 'backup.sqlite', output / 'restore.sqlite'
    src = ro(source)
    started = time.monotonic()
    try:
        src.execute('BEGIN')
        src.execute('SELECT count(*) FROM sqlite_master').fetchone()
        baseline = fingerprint(src)
        def progress(status, remaining, total):
            if status not in (sqlite3.SQLITE_OK, sqlite3.SQLITE_DONE) or time.monotonic() - started > 180:
                raise RuntimeError('SQLite backup busy or snapshot time budget exceeded')
        dst = sqlite3.connect(target)
        try:
            src.backup(dst, pages=256, progress=progress, sleep=0.05)
        finally:
            dst.close()
    finally:
        src.close()
    os.chmod(target, 0o600)
    if inspect(target) != baseline:
        raise RuntimeError('Backup differs from pinned SQLite snapshot')
    restore(target, restored, new=True)
    if inspect(restored) != baseline:
        raise RuntimeError('Restore rehearsal differs from backup')
    report = {'integrity': 'ok', 'foreignKeys': 0, 'restorable': True,
              'sha256': sha256(target), 'manifest': baseline}
    write_json(output / 'verified.json', report)
    return report


def restore(source, target, new=False):
    # Destination is opened in rw mode; never silently create a lost production DB.
    target = Path(target).resolve()
    if new:
        with target.open('xb'):
            pass
    elif not target.is_file():
        raise RuntimeError('Refusing to recreate a missing production SQLite file')
    src = ro(source)
    dst = sqlite3.connect(target.as_uri() + '?mode=rw', uri=True, timeout=5)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    os.chmod(target, 0o600)
    if inspect(target) != inspect(source):
        raise RuntimeError('Restored database verification failed')


def assert_idle(file):
    db = ro(file)
    try:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required = {'articles', 'jobs', 'analysis_batch_items', 'analysis_usage_log', 'meta'}
        if not required.issubset(tables):
            raise RuntimeError('V1.4 database baseline required')
        for table, condition in [('articles', "analysis_status='analyzing'"),
                                 ('jobs', "status='running'"),
                                 ('analysis_batch_items', "status='running'"),
                                 ('analysis_usage_log', "status IN ('running','uncertain')")]:
            if db.execute('SELECT 1 FROM ' + table + ' WHERE ' + condition + ' LIMIT 1').fetchone():
                raise RuntimeError('In-flight or uncertain work requires operator review: ' + table)
        for table in tables:
            if table.startswith(('journal_', 'chinese_', 'lab_')):
                columns = {r[1] for r in db.execute('PRAGMA table_info(' + quote(table) + ')')}
                if 'status' in columns and db.execute('SELECT 1 FROM ' + quote(table) +
                        " WHERE status IN ('running','analyzing','processing') LIMIT 1").fetchone():
                    raise RuntimeError('Unfinished work requires review: ' + table)
    finally:
        db.close()


def pause_ai(file):
    # Raw SQL only; preserve all results, claims, costs and uncertain request records.
    db = sqlite3.connect(Path(file).resolve(strict=True).as_uri() + '?mode=rw', uri=True, timeout=5)
    try:
        with db:
            row = db.execute("SELECT value FROM meta WHERE key='ai-auto:v14:control'").fetchone()
            value = json.loads(row[0]) if row else {}
            value.update(state='paused', reason='deployment')
            db.execute("INSERT INTO meta(key,value) VALUES('ai-auto:v14:control',?) "
                       "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(value),))
    finally:
        db.close()


def write_json(file, value):
    file = Path(file)
    temp = file.with_suffix('.tmp')
    with temp.open('w', encoding='utf8') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, file)
