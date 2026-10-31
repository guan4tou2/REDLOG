import ast, base64, hashlib, pathlib, types, __future__
from urllib.parse import urlparse
# #290: a raw TCP stream had content but no end. A connection that closed and
# one whose producer died both read as "no close recorded", and a connect that
# failed left nothing at all. The addon now reports the close it observes, with
# the count it numbered, as WebSocket does; it reports one close per flow.
source = ast.parse(pathlib.Path('hooks/mitmproxy-addon.py').read_text(encoding='utf-8'))
wanted = {'tcp_start', 'tcp_message', 'tcp_end', 'tcp_error', '_tcp_close'}
cls = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'RedLogAddon')
cls.body = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
helpers = [n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in ('_capture_body', '_is_text_content', '_truncate', '_next_message_seq', '_tcp_peer')]
constants = [n for n in source.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'TEXT_CONTENT_TYPES' for t in n.targets)]
rows = []
accept = {'ok': True}
stub = types.SimpleNamespace(HTTPFlow=object, TCPFlow=object)
ns = dict(base64=base64, hashlib=hashlib, urlparse=urlparse, VERBOSE=False, MAX_BODY=64, PREVIEW_BODY=4096,
          http=stub, tcp=stub, _client_addr=lambda _: None, _socket_owner_pid=lambda _: None,
          _embed_identity=lambda p: p.__setitem__('_identity', {'engagementId': 'A'}),
          _send_to_redlog=lambda p: rows.append(p) or accept['ok'])
exec(compile(ast.Module(body=constants + helpers + [cls], type_ignores=[]), '<production-tcp>', 'exec',
             flags=__future__.annotations.compiler_flag), ns)
addon = ns['RedLogAddon']()


def flow(fid):
    return types.SimpleNamespace(id=fid, messages=[], metadata={}, error=None,
                                 client_conn=types.SimpleNamespace(error=None),
                                 server_conn=types.SimpleNamespace(peername=('10.0.0.1', 445), address=None, tls_version=None, error=None))


def closes():
    return [r for r in rows if r['data']['subtype'] == 'tcp_end']


# Normal close after three messages.
f = flow('tcp-ok')
addon.tcp_start(f)
for n in range(3):
    f.messages.append(types.SimpleNamespace(from_client=n == 0, content=b'x' * 8))
    addon.tcp_message(f)
addon.tcp_end(f)
end = closes()[-1]
assert end['_identity'] == {'engagementId': 'A'}, end
assert end['data'] == {'subtype': 'tcp_end', 'flow_id': 'tcp-ok', 'host': '10.0.0.1', 'port': 445, 'streamed': True,
                       'stream_state': 'ended', 'message_count_observed': 3, 'stream_not_queued_bytes': 0,
                       'truncated': False, 'capture_delivery': 'unknown'}, end['data']

# A reset mid-stream: mitmproxy closes the flow, but the connection carries
# the error. One close only, and it says interrupted.
rows.clear()
f = flow('tcp-reset')
addon.tcp_start(f)
f.messages.append(types.SimpleNamespace(from_client=False, content=b'y' * 100))  # over MAX_BODY: truncated
addon.tcp_message(f)
accept['ok'] = False
f.messages.append(types.SimpleNamespace(from_client=False, content=b'z' * 10))
addon.tcp_message(f)
accept['ok'] = True
f.server_conn.error = 'connection reset by peer'
addon.tcp_end(f)
end = closes()[-1]['data']
assert end['stream_state'] == 'interrupted' and end['error'] == 'connection reset by peer', end
assert end['message_count_observed'] == 2 and end['stream_not_queued_bytes'] == 10 and end['truncated'] is True, end

# A connect that failed: tcp_error, then nothing else. A later tcp_end for the
# same flow must not turn it into a normal close.
rows.clear()
f = flow('tcp-refused')
addon.tcp_start(f)
f.error = types.SimpleNamespace(msg='connect failed')
addon.tcp_error(f)
addon.tcp_end(f)
assert len(closes()) == 1, closes()
end = closes()[0]['data']
assert end['stream_state'] == 'interrupted' and end['error'] == 'connect failed' and end['message_count_observed'] == 0, end
print('TCP lifecycle reported once per flow')
