from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import nginx_gate as gate

DOMAIN = 'fanscope-api.adapttochina.com'
INCLUDE = gate.INCLUDE


def dump(*files):
    return ''.join(f'# configuration file {f}:\n...\n\n' for f in files)


class GateTests(unittest.TestCase):
    def patched(self, files):
        return gate.plan(dump(*files), DOMAIN, read=lambda f: files[f])

    def test_only_fanscope_blocks_change_in_any_file_and_layout(self):
        text = '''# server { server_name fanscope-api.adapttochina.com; }
upstream other { server 127.0.0.1:9000; }
server {
    server_name
        other.example.com;
    location / { return 200; }
}
server { listen 80; server_name "fanscope-api.adapttochina.com"; return 301 https://$host$request_uri; }
server {
    listen 443 ssl;
    server_name fanscope-api.adapttochina.com;
    location / { proxy_pass http://127.0.0.1:8787; }
}
'''
        result = self.patched({'/www/server/panel/vhost/nginx/site.conf': text, '/etc/nginx/nginx.conf': 'events {}\nhttp { }\n'})
        self.assertEqual(list(result), ['/www/server/panel/vhost/nginx/site.conf'])
        out = result['/www/server/panel/vhost/nginx/site.conf']
        self.assertEqual(out.count(INCLUDE), 2)
        self.assertIn('other.example.com;\n    location / { return 200; }', out)
        self.assertEqual(out.replace(f'\n    {INCLUDE}', ''), text, 'nothing else changes')

    def test_multi_line_server_name_and_shared_block(self):
        text = 'http {\n server {\n  server_name a.example.com\n     fanscope-api.adapttochina.com;\n }\n}\n'
        self.assertIn(INCLUDE, self.patched({'/etc/nginx/nginx.conf': text})['/etc/nginx/nginx.conf'])

    def test_wildcard_parent_is_accepted_but_other_domains_are_not(self):
        self.assertIn(INCLUDE, self.patched({'/a': 'server { server_name *.adapttochina.com; }'})['/a'])
        with self.assertRaisesRegex(RuntimeError, 'other.example.com'):
            self.patched({'/a': 'server { server_name other.example.com; }'})

    def test_comment_mentioning_the_domain_is_not_a_match(self):
        with self.assertRaisesRegex(RuntimeError, 'No loaded'):
            self.patched({'/a': '# fanscope-api.adapttochina.com\nserver { server_name x.y; }\n'})

    def test_stream_and_upstream_server_entries_are_ignored(self):
        text = 'stream { server { listen 1; } }\nserver { server_name fanscope-api.adapttochina.com; }\n'
        self.assertEqual(self.patched({'/a': text})['/a'].count(INCLUDE), 1)

    def test_snippet_only_affects_the_fanscope_host(self):
        snippet = (Path(__file__).resolve().parents[3] / 'deploy/cicd/nginx-maintenance.conf').read_text()
        self.assertIn(gate.MARKER, snippet)
        self.assertIn(f'if ($host != "{DOMAIN}")', snippet)


class InstallRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.conf = self.root / 'site.conf'
        self.original = 'server { server_name fanscope-api.adapttochina.com; }\n'
        self.conf.write_text(self.original)
        self.snippet = self.root / 'snippet.conf'
        self.snippet.write_text('x')
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def nginx(self, reload_fails=False):
        def fake(*args):
            self.calls.append(args[-1])
            if args == ('-T',):
                return SimpleNamespace(returncode=0, stdout=f'# configuration file {self.conf}:\n', stderr='')
            if args[-1] == 'reload' and reload_fails and self.conf.read_text() == self.original:
                return SimpleNamespace(returncode=1, stdout='', stderr='reload refused')
            return SimpleNamespace(returncode=0, stdout='', stderr='')
        return fake

    def run_install(self, probe, reload_fails=False):
        with patch.object(gate, 'nginx', self.nginx(reload_fails)), patch.object(gate, 'probe', probe), \
                patch.object(gate, 'SNIPPET', str(self.snippet)), patch.object(gate.time, 'sleep'):
            gate.install(DOMAIN, self.root / 'saved')

    def test_probe_network_failures_restore_and_reload(self):
        for error in (urllib.error.URLError('dns failure'), TimeoutError('timed out'), ConnectionResetError('reset')):
            with self.subTest(error=error):
                self.calls.clear()
                with self.assertRaisesRegex(RuntimeError, 'original files restored'):
                    self.run_install(Mock(side_effect=error))
                self.assertEqual(self.conf.read_text(), self.original)
                self.assertEqual(self.calls.count('reload'), 2, 'applied, then restored')

    def test_original_error_is_chained(self):
        cause = urllib.error.URLError('dns failure')
        with self.assertRaises(RuntimeError) as caught:
            self.run_install(Mock(side_effect=cause))
        self.assertIs(caught.exception.__cause__, cause)

    def test_failed_recovery_is_not_masked(self):
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY ALSO FAILED.*reload refused'):
            self.run_install(Mock(side_effect=TimeoutError('timed out')), reload_fails=True)
        self.assertEqual(self.conf.read_text(), self.original)

    def test_wrong_status_restores_and_success_keeps_the_gate(self):
        with self.assertRaisesRegex(RuntimeError, 'stats 200'):
            self.run_install(Mock(return_value=(200, 200)))
        self.assertEqual(self.conf.read_text(), self.original)
        self.run_install(Mock(return_value=(503, 200)))
        self.assertIn(INCLUDE, self.conf.read_text())


if __name__ == '__main__':
    unittest.main()
