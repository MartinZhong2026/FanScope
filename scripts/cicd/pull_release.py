"""Poll only successful manually approved main-branch release workflow runs.

Server token: fine-grained Actions read + Contents read for this repository only.
The downloaded bundle contains data/image only, never host-executed scripts.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import urllib.parse
import urllib.request
import zipfile
from sqlite_release import write_json

STATE = Path('/var/lib/fanscope-cd')
REPO = 'MartinZhong2026/FanScope'


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = urllib.parse.urlparse(newurl)
        if url.scheme != 'https' or not url.hostname or url.username:
            raise RuntimeError('Unsafe artifact redirect')
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if url.hostname != 'api.github.com':
            redirected.remove_header('Authorization')
        return redirected


def eligible(run, workflow_id, current_sha, floor):
    return (run.get('workflow_id') == workflow_id and (run.get('head_repository') or {}).get('full_name') == REPO
            and run.get('head_branch') == 'main' and run.get('head_sha') == current_sha
            and run.get('event') == 'workflow_dispatch' and run.get('status') == 'completed'
            and run.get('conclusion') == 'success' and run.get('run_attempt') == 1
            and run.get('run_number', 0) > floor)


def extract_verified(data, artifact, destination, allowed):
    expected = artifact.get('digest', '')
    if isinstance(data, Path):
        with data.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        archive_input = data
    else:
        digest = hashlib.sha256(data).hexdigest()
        archive_input = io.BytesIO(data)
    if expected != 'sha256:' + digest:
        raise RuntimeError('GitHub artifact digest missing or mismatched')
    with zipfile.ZipFile(archive_input) as archive:
        entries = archive.infolist()
        if {e.filename for e in entries} != allowed or len(entries) != len(allowed):
            raise RuntimeError('Unexpected artifact members (directories/traversal/duplicates rejected)')
        if sum(e.file_size for e in entries) > 3 * 1024**3 or any((e.external_attr >> 16) & 0o170000 == 0o120000 for e in entries):
            raise RuntimeError('Artifact size/symlink rejected')
        destination.mkdir(mode=0o700)
        for entry in entries:
            with archive.open(entry) as src, (destination / entry.filename).open('xb') as dst:
                shutil.copyfileobj(src, dst)


def main():
    config = json.loads(Path('/etc/fanscope-cd/config.json').read_text())
    if config.get('enabled') is not True:
        print('FanScope pull deployment disabled');return
    token = (Path(os.environ['CREDENTIALS_DIRECTORY']) / 'github-token').read_text().strip()
    opener = urllib.request.build_opener(SafeRedirect())
    def api(path, binary=False):
        req = urllib.request.Request('https://api.github.com/repos/' + REPO + path,
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28'})
        with opener.open(req, timeout=60) as response:
            if binary:
                # Stream to private disk: do not buffer an image ZIP in server RAM.
                with tempfile.NamedTemporaryFile(prefix='download-', suffix='.zip', dir=STATE / 'incoming', delete=False) as stream:
                    size = 0
                    while block := response.read(1024 * 1024):
                        size += len(block)
                        if size > 3 * 1024**3:
                            raise RuntimeError('Artifact exceeds size budget')
                        stream.write(block)
                    stream.flush()
                    os.fsync(stream.fileno())
                    return Path(stream.name)
            data = response.read(8 * 1024**2 + 1)
            if len(data) > 8 * 1024**2:
                raise RuntimeError('GitHub JSON response too large')
            return json.loads(data)
    workflow = api('/actions/workflows/backend-release.yml')
    if workflow['id'] != config['workflow_id'] or workflow['path'] != '.github/workflows/backend-release.yml':
        raise RuntimeError('Pinned release workflow identity mismatch')
    head = api('/git/ref/heads/main')['object']['sha']
    cursor_file = STATE / 'cursor.json'
    floor = max(config['first_run_number'] - 1,
                json.loads(cursor_file.read_text())['run_number'] if cursor_file.exists() else 0)
    runs = api(f"/actions/workflows/{workflow['id']}/runs?branch=main&event=workflow_dispatch&per_page=30")['workflow_runs']
    # Select newest requested release first, including pending/failed runs. Never
    # fall back to an older approved run while a newer request is pending/failed.
    newer = [r for r in runs if r['run_number'] > floor]
    if not newer:
        return
    run = max(newer, key=lambda r: r['run_number'])
    if not eligible(run, workflow['id'], head, floor):
        print('Newest release is pending, failed, stale, retried or otherwise ineligible');return
    artifacts = api(f"/actions/runs/{run['id']}/artifacts?per_page=100")['artifacts']
    def unique(name):
        matches = [a for a in artifacts if a['name'] == name and not a['expired']]
        if len(matches) != 1:
            raise RuntimeError('Missing or ambiguous release artifact: ' + name)
        return matches[0]
    bundle, approval = unique('backend-release'), unique('production-approval')
    if shutil.disk_usage(STATE).free < bundle['size_in_bytes'] * 3 + 256 * 1024**2:
        raise RuntimeError('Insufficient release download/extraction space')
    directory = STATE / 'incoming' / str(run['id'])
    directory.mkdir(mode=0o700)
    extract_verified(api(f"/actions/artifacts/{approval['id']}/zip", True), approval,
                     directory / 'approval', {'approved.json'})
    receipt = json.loads((directory / 'approval/approved.json').read_text())
    if receipt != {'commit': head, 'runId': run['id'], 'artifactId': bundle['id'], 'digest': bundle['digest']}:
        raise RuntimeError('Production approval receipt mismatch')
    extract_verified(api(f"/actions/artifacts/{bundle['id']}/zip", True), bundle,
                     directory / 'bundle', {'image.tar', 'manifest.json', 'SHA256SUMS'})
    # Recheck main after downloading. Host-side deploy also holds the same lock.
    if api('/git/ref/heads/main')['object']['sha'] != head:
        raise RuntimeError('main advanced during download; request a fresh release')
    write_json(cursor_file, {'run_number': run['run_number'], 'run_id': run['id'], 'status': 'attempted'})
    subprocess.run(['python3', '/opt/fanscope-cd/scripts/cicd/deploy_backend.py', 'deploy',
                    '--bundle', str(directory / 'bundle'), '--sha', head, '--run-id', str(run['id'])], check=True)
    write_json(cursor_file, {'run_number': run['run_number'], 'run_id': run['id'], 'status': 'success'})
    print(json.dumps({'run': run['id'], 'commit': head, 'status': 'success'}))


if __name__ == '__main__':
    os.umask(0o077)
    # Hold poll lock across download/authorization, not just the container update.
    import fcntl
    with (STATE / 'poll.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        main()
