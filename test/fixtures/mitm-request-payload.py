"""What the mitmproxy addon sends for a request with a given body.

Loads hooks/mitmproxy-addon.py unmodified with a stand-in for the `mitmproxy`
package (not installed in CI) and calls the addon's own `request` hook once per
case. Only `_send_to_redlog` is replaced: it records the payload instead of
posting it.

Usage: python3 -I mitm-request-payload.py <addon path> < cases.json
  cases.json: [{"content_type": "...", "body_b64": "...", "url": "optional"}, ...]
Prints {"python": "<version>", "results": [{"data": {...}} | {"error": "<exception name>"}, ...]}.
Run with HOME (and USERPROFILE) pointing at an empty directory: the addon reads
~/.redlog files when it loads.
"""
import base64
import importlib.util
import json
import re
import sys
import types
from unittest import mock


def stub_mitmproxy() -> None:
    root = types.ModuleType('mitmproxy')
    for name in ('http', 'tcp', 'tls', 'ctx'):
        sub = mock.MagicMock(name=f'mitmproxy.{name}')
        setattr(root, name, sub)
        sys.modules[f'mitmproxy.{name}'] = sub
    sys.modules['mitmproxy'] = root


class Headers:
    def __init__(self, pairs):
        self._pairs = list(pairs)

    def items(self, multi=False):
        return list(self._pairs)

    def get(self, name, default=None):
        for k, v in self._pairs:
            if k.lower() == name.lower():
                return v
        return default


class Request:
    def __init__(self, content_type: str, content: bytes, url: str):
        self.pretty_url = url
        self.pretty_host = '10.0.0.5'
        self.method = 'POST'
        self.http_version = 'HTTP/1.1'
        self.stream_id = None
        self.headers = Headers([('Host', '10.0.0.5:8080'), ('Content-Type', content_type)])
        self.content = content
        self.timestamp_start = 1000.0
        self.timestamp_end = 1000.01

    def get_text(self, strict=True):
        # mitmproxy decodes with the charset the content type names.
        found = re.search(r'charset=([\w-]+)', self.headers.get('Content-Type', ''), re.I)
        return self.content.decode(found.group(1) if found else 'utf-8', errors='strict' if strict else 'replace')


def main() -> None:
    stub_mitmproxy()
    spec = importlib.util.spec_from_file_location('redlog_mitmproxy_addon', sys.argv[1])
    addon = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(addon)

    sent = []
    addon._send_to_redlog = lambda payload: sent.append(json.loads(json.dumps(payload))) or True
    addon._socket_owner_pid = lambda addr: None
    hooks = addon.RedLogAddon()

    results = []
    for n, case in enumerate(json.load(sys.stdin)):
        flow = types.SimpleNamespace(
            id=f'flow-{n}',
            metadata={},
            request=Request(case['content_type'], base64.b64decode(case['body_b64']), case.get('url', 'http://10.0.0.5:8080/api/items')),
            response=None,
            client_conn=types.SimpleNamespace(peername=('127.0.0.1', 51234)),
        )
        sent.clear()
        try:
            hooks.request(flow)
        except BaseException as exc:  # what mitmproxy would catch and log
            results.append({'error': type(exc).__name__})
            continue
        results.append({'data': sent[0]['data']} if sent else {'error': 'nothing sent'})
    json.dump({'python': sys.version.split()[0], 'results': results}, sys.stdout)


main()
