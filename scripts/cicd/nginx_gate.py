"""Install the FanScope maintenance gate into the server block(s) nginx really loads.

Files come from `nginx -T`, so any layout works (sites-enabled, conf.d, nginx.conf,
panel directories, multi-line server_name). Only blocks naming the FanScope domain
are edited. Any failure restores the original files and reloads nginx.
"""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request

MARKER = 'if (-f /var/lib/fanscope-cd/maintenance)'
MAINTENANCE = Path('/var/lib/fanscope-cd/maintenance')
SNIPPET = '/opt/fanscope-cd/deploy/cicd/nginx-maintenance.conf'
INCLUDE = f'include {SNIPPET};'


def loaded_files(dump):
    return re.findall(r'^# configuration file (.+?):\s*$', dump, re.M)


def tokens(text):
    """Yield (token, offset), skipping comments and honouring quotes."""
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c.isspace():
            i += 1
        elif c == '#':
            while i < n and text[i] != '\n':
                i += 1
        elif c in '{};':
            yield c, i
            i += 1
        elif c in '"\'':
            end = i + 1
            while end < n and text[end] != c:
                end += 2 if text[end] == '\\' else 1
            yield text[i + 1:end], i
            i = end + 1
        else:
            start = i
            while i < n and not text[i].isspace() and text[i] not in '{};':
                i += 1
            yield text[start:i], start


def server_blocks(text):
    """Return [(offset just after the server `{`, [server_name values])]."""
    blocks, stack, words = [], [], []
    for token, offset in tokens(text):
        if token == '{':
            is_server = words == ['server'] and not {'upstream', 'stream'} & set(stack)
            stack.append('server' if is_server else (words[0] if words else ''))
            if is_server:
                blocks.append([offset + 1, []])
            words = []
        elif token == '}':
            stack.pop()
            words = []
        elif token == ';':
            if stack and stack[-1] == 'server' and words and words[0] == 'server_name':
                blocks[-1][1].extend(w.lower() for w in words[1:])
            words = []
        else:
            words.append(token)
    return [(offset, names) for offset, names in blocks]


def matches(names, domain):
    parent = '.'.join(domain.split('.')[1:])
    return domain in names or f'.{domain}' in names or f'*.{parent}' in names or f'.{parent}' in names


def plan(dump, domain, read=lambda f: Path(f).read_text(encoding='utf8')):
    """Return {file: patched text}. Raises if no loaded block names the domain."""
    patched, seen = {}, []
    for file in dict.fromkeys(loaded_files(dump)):
        try:
            text = read(file)
        except (OSError, UnicodeDecodeError):
            continue
        offsets = []
        for offset, names in server_blocks(text):
            seen.append(f'{file}: {" ".join(names) or "(no server_name)"}')
            if matches(names, domain):
                offsets.append(offset)
        for offset in reversed(offsets):
            text = text[:offset] + f'\n    {INCLUDE}' + text[offset:]
        if offsets:
            patched[file] = text
    if not patched:
        raise RuntimeError(f'No loaded nginx server block names {domain}. Blocks found:\n' + '\n'.join(seen))
    return patched


def nginx(*args):
    return subprocess.run(['nginx', *args], capture_output=True, text=True, encoding='utf8', errors='replace')


def probe(domain):
    def status(path):
        request = urllib.request.Request(f'https://{domain}{path}', headers={'Cache-Control': 'no-cache'})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code
    MAINTENANCE.touch()
    try:
        time.sleep(0.2)
        return status('/api/stats?cicd=maintenance'), status('/api/health')
    finally:
        MAINTENANCE.unlink(missing_ok=True)


def install(domain, backup_dir):
    result = nginx('-T')
    if result.returncode != 0:
        raise RuntimeError('nginx -T failed; nothing changed: ' + result.stderr[-300:])
    dump = result.stdout + result.stderr
    if not Path(SNIPPET).is_file():
        raise RuntimeError('Controller is not installed: ' + SNIPPET)
    if MARKER in dump:
        print('Gate already installed.')
        originals = {}
    else:
        patched = plan(dump, domain)
        backup_dir.mkdir(parents=True, exist_ok=True)
        originals = {}
        for index, (file, text) in enumerate(patched.items()):
            real = Path(file).resolve()
            originals[real] = real.read_bytes()
            shutil.copy2(real, backup_dir / f'{index}-{real.name}')
            real.write_text(text, encoding='utf8')
        (backup_dir / 'files.json').write_text(json.dumps([str(f) for f in originals]))
    def restore(reload):
        for file, content in originals.items():
            file.write_bytes(content)
        if originals and reload:
            nginx('-s', 'reload')
    if originals:
        check = nginx('-t')
        if check.returncode != 0:
            restore(False)
            raise RuntimeError('nginx rejected the gate; original files restored: ' + check.stderr[-300:])
        reloaded = nginx('-s', 'reload')
        if reloaded.returncode != 0:
            restore(True)
            raise RuntimeError('nginx reload failed; original files restored')
    time.sleep(1)
    stats, health = probe(domain)
    if (stats, health) != (503, 200):
        restore(True)
        raise RuntimeError(f'Gate test failed (stats {stats}, health {health}); original files restored')
    print('Gate test passed: stats 503, health 200. Changed:', [str(f) for f in originals] or 'nothing')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--domain', default='fanscope-api.adapttochina.com')
    parser.add_argument('--backup-dir', type=Path, required=True)
    args = parser.parse_args()
    install(args.domain, args.backup_dir)
