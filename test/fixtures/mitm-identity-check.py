import ast, hashlib, json, tempfile, pathlib, time, types, urllib.request
from urllib.parse import urlparse
# #459: an event derived from a flow belongs to the project the flow started
# in. The TTL sweep, cookie rotation and a DNS answer are sent later than the
# request they describe; each used to take whatever project was active then.
# Runs the production RedLogAddon and transport functions without mitmproxy.
tree = ast.parse(pathlib.Path('hooks/mitmproxy-addon.py').read_text(encoding='utf-8'))
names = {'_identity_matches_active', '_embed_identity', '_spool_payload', '_send_to_redlog', '_send_to_redlog_and_get_id', '_dns_type_name', '_dns_rcode_name'}
body = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in names) or (isinstance(n, ast.ClassDef) and n.name == 'RedLogAddon')]


class Abort(Exception):
    """Stops request() once it has registered the pending flow."""


def stop(*_):
    raise Abort()


log = types.SimpleNamespace(warn=lambda _: None, info=lambda _: None)
stub = types.SimpleNamespace(HTTPFlow=object, TCPFlow=object, TlsData=object, ClientHelloData=object)
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    pending = []
    ns = dict(json=json, time=time, hashlib=hashlib, urllib=urllib, urlparse=urlparse, VERBOSE=False, SKIP_STATIC=False,
              PENDING_TTL_SEC=300, VERIFY_HOST='redlog.verify.invalid', PROXY_MODE='regular',
              http=stub, tcp=stub, tls=stub, ctx=types.SimpleNamespace(log=log),
              _SPOOL_LOCK=__import__('threading').Lock(), _SEND_SLOTS=__import__('threading').BoundedSemaphore(64),
              _SEND_QUEUE=types.SimpleNamespace(put=pending.append),
              _IDENTITY_PATH=root / 'identity', SPOOL_DIR=root / 'pending',
              _get_redlog_connection=lambda: ('1234', 'token'),
              _extract_params=stop, _client_addr=lambda _: '127.0.0.1:5353', _socket_owner_pid=lambda _: None)
    exec(compile(ast.Module(body=body, type_ignores=[]), '<production-addon>', 'exec'), ns)
    sent = []
    real_send = ns['_send_to_redlog']

    def recording_send(payload):
        sent.append(payload)
        return real_send(payload)
    ns['_send_to_redlog'] = recording_send

    def ask_dns(payload):
        ns['_embed_identity'](payload)
        sent.append(payload)
        return 'query-event'
    ns['_send_to_redlog_and_get_id'] = ask_dns

    A = {'engagementId': 'A', 'operatorId': 'op-A'}
    B = {'engagementId': 'B', 'operatorId': 'op-B'}

    def activate(ident):
        if ident is None:
            ns['_IDENTITY_PATH'].unlink(missing_ok=True)
        else:
            ns['_IDENTITY_PATH'].write_text(json.dumps(ident))

    def flow(fid, url='https://a.test/private?token=SECRET'):
        request = types.SimpleNamespace(pretty_host=urlparse(url).hostname, pretty_url=url, method='POST', path=urlparse(url).path, headers={})
        return types.SimpleNamespace(id=fid, request=request, metadata={})

    def start(addon, f):
        try:
            addon.request(f)
        except Abort:
            pass
        assert f.id in addon._request_times, 'request() did not register the pending flow'
        addon._request_times[f.id]['at'] = time.time() - 301

    def reset():
        sent.clear(); pending.clear()

    # 1. Started in A, swept while B is active: the marker is A's, so B gets nothing.
    addon = ns['RedLogAddon']()
    activate(A); start(addon, flow('flow-A'))
    activate(B); reset()
    addon._sweep_stale()
    dropped = [p for p in sent if p['data'].get('subtype') == 'http_request_dropped']
    assert len(dropped) == 1, sent
    assert dropped[0]['_identity'].get('engagementId') == 'A', f"dropped marker rebound to {dropped[0]['_identity']}"
    assert not pending, 'a marker for A was queued while B is active'

    # 2. Same project: the marker is still delivered.
    addon = ns['RedLogAddon']()
    activate(A); start(addon, flow('flow-same'))
    reset(); addon._sweep_stale()
    assert len(pending) == 1 and sent[-1]['_identity']['engagementId'] == 'A' and sent[-1]['data']['flow_id'] == 'flow-same'

    # 3. Started with no project: the late marker is refused, never bound to A.
    addon = ns['RedLogAddon']()
    activate(None); start(addon, flow('flow-none'))
    activate(A); reset(); addon._sweep_stale()
    assert not pending, 'a flow with no project was bound to the project active at sweep time'
    assert all(p.get('_identity', {}).get('engagementId') != 'A' for p in sent)

    # 4. A session cookie rotated by a response in A, reported while B is active.
    addon = ns['RedLogAddon']()
    activate(B); reset()
    addon._track_cookies('a.test', [{'name': 'session', 'value': 'one'}], A)
    addon._track_cookies('a.test', [{'name': 'session', 'value': 'two'}], A)
    changes = [p for p in sent if p['data'].get('subtype') == 'cookie_change']
    assert len(changes) == 1 and changes[0]['_identity'].get('engagementId') == 'A', changes
    assert not pending

    # 5. A DNS question asked in A and answered after B became active.
    addon = ns['RedLogAddon']()
    question = types.SimpleNamespace(name='a.test', type=1)
    dns = types.SimpleNamespace(id='dns-1', client_conn=None,
                                request=types.SimpleNamespace(questions=[question], id=7),
                                response=types.SimpleNamespace(response_code=0, answers=[]))
    activate(A); reset(); addon._dns_query(dns)
    activate(B); reset(); addon._dns_response(dns)
    answer = [p for p in sent if p['data'].get('subtype') == 'dns_response']
    assert len(answer) == 1 and answer[0]['_identity'].get('engagementId') == 'A', answer
    assert not pending
print('flow identity checks passed')
