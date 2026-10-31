import ast, base64, hashlib, pathlib, types, __future__
from urllib.parse import urlparse
# #290: an hours-long WebSocket or TCP stream must not make mitmdump hold every
# message it ever relayed. mitmproxy appends each message to the flow and never
# drops one; the addon has already sent it, so it keeps only the newest (the one
# other addons read as messages[-1]). The per-flow sequence must not come from
# that list's length any more, and must still number every message exactly once.
source = ast.parse(pathlib.Path('hooks/mitmproxy-addon.py').read_text(encoding='utf-8'))
wanted = {'websocket_message', 'websocket_end', 'tcp_start', 'tcp_message'}
cls = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'RedLogAddon')
cls.body = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
helpers = [n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in ('_capture_body', '_is_text_content', '_truncate', '_next_message_seq')]
constants = [n for n in source.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'TEXT_CONTENT_TYPES' for t in n.targets)]
rows = []
stub = types.SimpleNamespace(HTTPFlow=object, TCPFlow=object)
ns = dict(base64=base64, hashlib=hashlib, urlparse=urlparse, VERBOSE=False, MAX_BODY=1 << 20, PREVIEW_BODY=4096,
          http=stub, tcp=stub, _client_addr=lambda _: None, _socket_owner_pid=lambda _: None,
          _embed_identity=lambda p: p.__setitem__('_identity', {'engagementId': 'A'}),
          _send_to_redlog=lambda p: rows.append(p) or True)
exec(compile(ast.Module(body=constants + helpers + [cls], type_ignores=[]), '<production-messages>', 'exec',
             flags=__future__.annotations.compiler_flag), ns)
addon = ns['RedLogAddon']()


def message(n, from_client):
    return types.SimpleNamespace(from_client=from_client, type=2, content=n.to_bytes(4, 'big') * 256)


# WebSocket: a thousand messages, both directions.
ws = types.SimpleNamespace(messages=[], close_code=1000)
flow = types.SimpleNamespace(id='ws-1', websocket=ws, metadata={'redlog_identity': {'engagementId': 'A'}},
                             request=types.SimpleNamespace(pretty_url='http://ws.test/socket'))
for n in range(1, 1001):
    ws.messages.append(message(n, n % 2 == 0))
    addon.websocket_message(flow)
    assert len(ws.messages) <= 1, f'mitmproxy history kept {len(ws.messages)} WebSocket messages'
    assert ws.messages[-1].content[:4] == n.to_bytes(4, 'big'), 'the newest message stays readable as messages[-1]'
sent = [r['data'] for r in rows if r['data']['subtype'] == 'ws_message']
assert [r['message_count'] for r in sent] == list(range(1, 1001)), 'every message numbered once, in order'
assert all(base64.b64decode(r['ws_body']['data'])[:4] == r['message_count'].to_bytes(4, 'big') for r in sent), 'each row carries its own bytes'
addon.websocket_end(flow)
end = rows[-1]['data']
assert end['subtype'] == 'websocket_end' and end['message_count_observed'] == 1000, end
print('WebSocket history bounded and sequenced')

# TCP: same shape.
rows.clear()
tcp_flow = types.SimpleNamespace(id='tcp-1', messages=[], metadata={},
                                 server_conn=types.SimpleNamespace(peername=('10.0.0.1', 445), address=None, tls_version=None))
addon.tcp_start(tcp_flow)
for n in range(1, 501):
    tcp_flow.messages.append(message(n, n % 3 == 0))
    addon.tcp_message(tcp_flow)
    assert len(tcp_flow.messages) <= 1, f'mitmproxy history kept {len(tcp_flow.messages)} TCP messages'
assert [r['data']['message_count'] for r in rows] == list(range(1, 501))
assert all(r['_identity'] == {'engagementId': 'A'} for r in rows)
print('TCP history bounded and sequenced')
