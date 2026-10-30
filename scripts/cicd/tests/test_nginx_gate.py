from pathlib import Path
import sys
import unittest

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


if __name__ == '__main__':
    unittest.main()
