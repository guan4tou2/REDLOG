"""Spec 076 T002: what the mitmproxy addon sends for one ordinary flow.

Loads hooks/mitmproxy-addon.py unmodified, with a stand-in for the `mitmproxy`
package (not installed in CI), and calls the addon's own `request` and
`response` hooks with a flow shaped like mitmproxy's. The only thing replaced is
`_send_to_redlog`, which would POST to the API: here it records the payload, so
what is printed is exactly what the addon would have sent to POST /api/events.

Printed: a JSON list of payloads, in the order sent. Time is fixed (the addon
reads time.time() for source_timestamp and duration), and the socket-owner
lookup, which shells out to lsof/ss/netstat, is replaced with "unknown owner".

Usage: python3 -I mitm-flow-payloads.py <path to hooks/mitmproxy-addon.py> <epoch seconds the flow starts at>
Run with HOME (and USERPROFILE) pointing at an empty directory: the addon reads
~/.redlog/active-identity.json and ~/.redlog/api-token when it loads.
"""
import importlib.util
import json
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
    """The parts of mitmproxy's Headers the addon reads."""

    def __init__(self, pairs):
        self._pairs = list(pairs)

    def items(self, multi=False):
        return list(self._pairs)

    def get(self, name, default=None):
        for k, v in self._pairs:
            if k.lower() == name.lower():
                return v
        return default

    def get_all(self, name):
        return [v for k, v in self._pairs if k.lower() == name.lower()]


class Request:
    def __init__(self):
        self.pretty_url = 'http://10.0.0.5:8080/search?next=%2Fadmin'
        self.pretty_host = '10.0.0.5'
        self.method = 'POST'
        self.http_version = 'HTTP/1.1'
        self.stream_id = None
        self.headers = Headers([
            ('Host', '10.0.0.5:8080'),
            ('Content-Type', 'application/x-www-form-urlencoded'),
            ('Cookie', 'session=s-0001; theme=dark'),
        ])
        self.content = b'q=openssh&page=2'
        self.timestamp_start = 1000.0
        self.timestamp_end = 1000.01

    def get_text(self, strict=True):
        return self.content.decode('utf-8')


class Response:
    def __init__(self):
        self.status_code = 302
        self.headers = Headers([
            ('Content-Type', 'text/html; charset=utf-8'),
            ('Location', '/admin'),
            ('Set-Cookie', 'session=s-0002; Path=/; HttpOnly; SameSite=Lax'),
        ])
        self.content = b'<html><body>Found</body></html>'
        self.timestamp_start = 1000.05
        self.timestamp_end = 1000.06
        self.stream = False


def main() -> None:
    stub_mitmproxy()
    spec = importlib.util.spec_from_file_location('redlog_mitmproxy_addon', sys.argv[1])
    addon = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(addon)

    sent = []
    clock = [float(sys.argv[2])]

    def record(payload):
        # What the real _send_to_redlog does first, before any identity check.
        payload.setdefault('data', {}).setdefault('source_timestamp', int(clock[0] * 1000))
        sent.append(json.loads(json.dumps(payload)))
        return True

    addon._send_to_redlog = record
    addon._socket_owner_pid = lambda addr: None
    addon.time = types.SimpleNamespace(time=lambda: clock[0], sleep=lambda s: None, monotonic=lambda: clock[0])

    flow = types.SimpleNamespace(
        id='flow-0001',
        metadata={},
        request=Request(),
        response=Response(),
        client_conn=types.SimpleNamespace(peername=('127.0.0.1', 51234)),
        server_conn=types.SimpleNamespace(tls_version=None, timestamp_start=None, timestamp_tcp_setup=None,
                                         timestamp_tls_setup=None),
    )
    hooks = addon.RedLogAddon()
    hooks.request(flow)
    clock[0] += 0.25
    hooks.response(flow)
    json.dump(sent, sys.stdout, sort_keys=True)


main()
