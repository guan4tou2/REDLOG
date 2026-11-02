import ast, json, os, re, shutil, sys, tempfile, pathlib, threading, time, types, urllib.request
from unittest.mock import patch
# #291: an event admitted to the send queue and not yet delivered was lost
# with no record when the proxy stopped. While anything is in flight the addon
# now keeps a content-free marker on disk with an upper bound per project, so a
# kill leaves something the app can count; a stop it is told about records the
# exact number it will never send, and removes the marker.
# Runs the production transport functions without mitmproxy.
tree = ast.parse(pathlib.Path('hooks/mitmproxy-addon.py').read_text(encoding='utf-8'))
functions = {'_identity_matches_active', '_embed_identity', '_spool_payload', '_send_to_redlog',
             '_write_spool_record', '_note_refusal', '_note_switch_refusal', '_flush_gaps', '_declared_body_bytes',
             '_gap_record', '_save_gaps', '_inflight_key', '_write_inflight_marker', '_inflight_admit', '_inflight_begin',
             '_inflight_end', '_inflight_beat', '_stop_sending', '_stop_and_exit'}
assigns = {'_GAP_FLUSH_MS', '_GAP_WINDOWS', '_GAP_LOCK', '_GAP_TEXT', '_INFLIGHT', '_INFLIGHT_LOCK', '_INFLIGHT_STATE',
           '_INFLIGHT_STEP', '_INFLIGHT_INSTANCE', '_INFLIGHT_STARTED_MS'}
body = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in functions)
        or (isinstance(n, ast.ClassDef) and n.name == 'RedLogAddon')
        or (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in assigns for t in n.targets))
        or (isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.target.id in assigns)]
found = {n.name for n in body if isinstance(n, (ast.FunctionDef, ast.ClassDef))} | {t.id for n in body if isinstance(n, ast.Assign) for t in n.targets} | {n.target.id for n in body if isinstance(n, ast.AnnAssign)}
assert found >= functions | assigns, f'missing from the addon: {sorted((functions | assigns) - found)}'


class Response:
    @staticmethod
    def make(status, content=b'', headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {})


warnings = []
shutdowns = []
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    pending = []

    def put(deliver):
        """The queue itself checks the order: a kill from here on must find a
        bound on disk that covers everything in flight, this event included."""
        held = sum(e['queued'] + e['sending'] for e in ns['_INFLIGHT'].values())
        on_disk = sum(i['upper_bound'] for m in markers() for i in m['identities'])
        assert on_disk >= held, f'queued with {held} in flight and a bound of {on_disk} on disk'
        pending.append(deliver)

    ns = dict(json=json, os=os, urllib=urllib, time=time, threading=threading, hmac=__import__('hmac'), VERBOSE=False,
              http=types.SimpleNamespace(Response=Response, HTTPFlow=object), tcp=types.SimpleNamespace(TCPFlow=object),
              tls=types.SimpleNamespace(TlsData=object, ClientHelloData=object),
              ctx=types.SimpleNamespace(log=types.SimpleNamespace(warn=warnings.append),
                                        master=types.SimpleNamespace(shutdown=lambda: shutdowns.append(time.time()))),
              _SPOOL_LOCK=threading.Lock(), _SEND_SLOTS=threading.BoundedSemaphore(64),
              _SEND_QUEUE=types.SimpleNamespace(put=put),
              _IDENTITY_PATH=root / 'identity', SPOOL_DIR=root / 'pending', INFLIGHT_DIR=root / 'inflight',
              VERIFY_HOST='redlog.verify.invalid', _get_redlog_connection=lambda: ('1234', 'token'))
    exec(compile(ast.Module(body=body, type_ignores=[]), '<production-transport>', 'exec'), ns)
    send = ns['_send_to_redlog']
    A = {'engagementId': 'A', 'operatorId': 'op-A'}
    ns['_IDENTITY_PATH'].write_text(json.dumps(A))

    def event(size=10):
        return {'agent_type': 'scanner', 'target_id': 'private.test', 'data': {
            'subtype': 'http_response', 'url': 'https://private.test/?token=SECRET',
            'response_headers': [['set-cookie', 'session=SECRET']],
            'response_body': {'data': 'UFJJVkFURS1CWVRFUw==', 'encoding': 'base64', 'size': size}}}

    def markers():
        return [json.loads(p.read_text()) for p in sorted(ns['INFLIGHT_DIR'].glob('*.json'))]

    def spooled():
        return [json.loads(p.read_text()) for p in sorted(ns['SPOOL_DIR'].glob('*.json'))]

    def gaps(reason):
        return [r['data'] for r in spooled() if r['data'].get('reason') == reason]

    # Nothing in flight, nothing on disk.
    assert markers() == []

    # The first admitted event is on disk before it is queued: a kill at any
    # point after admission leaves a bound that covers it.
    assert send(event()) is True and len(pending) == 1
    first = markers()
    assert len(first) == 1, first
    entry = first[0]['identities']
    assert [e['identity'] for e in entry] == [A] and entry[0]['upper_bound'] >= 1, first
    assert first[0]['pid'] == os.getpid() and isinstance(first[0]['heartbeat_at'], int)

    # The bound is rounded up, so a busy queue does not write a file per event.
    writes = []
    real_write = ns['_write_inflight_marker']
    ns['_write_inflight_marker'] = lambda: writes.append(1) or real_write()
    for _ in range(9):
        assert send(event()) is True
    assert len(pending) == 10
    assert len(writes) <= 2, f'{len(writes)} marker writes for 9 events'
    bound = markers()[0]['identities'][0]['upper_bound']
    assert bound >= 10, bound

    # A heartbeat lowers the bound to what is really in flight.
    ns['_inflight_beat']()
    assert markers()[0]['identities'][0]['upper_bound'] == 10

    # Delivered events leave the count; with none left, the marker goes.
    with patch('urllib.request.urlopen', return_value=None):
        for deliver in pending[:4]:
            deliver()
    del pending[:4]
    ns['_inflight_beat']()
    assert markers()[0]['identities'][0]['upper_bound'] == 6

    # The marker carries when and how many, never content.
    assert not re.search(r'SECRET|private\.test|UFJJVkFURS1CWVRFUw|response', json.dumps(markers()))

    # Two of the six are mid-POST when the stop comes, and do not answer in time.
    release = threading.Event()
    calls = []

    def slow(*_args, **_kwargs):
        calls.append(1)
        release.wait(5)

    with patch('urllib.request.urlopen', side_effect=slow):
        workers = [threading.Thread(target=pending.pop(0)) for _ in range(2)]
        for w in workers:
            w.start()
        deadline = time.time() + 2
        while len(calls) < 2 and time.time() < deadline:
            time.sleep(0.01)
        assert len(calls) == 2

        # The stop records the four never taken as exact, and the two being
        # sent as unconfirmed: it cannot know whether they arrived.
        stopper = threading.Thread(target=ns['_stop_sending'], args=(0.6,))
        stopper.start()
        deadline = time.time() + 2
        while not gaps('proxy-stopped') and time.time() < deadline:
            time.sleep(0.01)
        # While it waits on the two: what it recorded exactly is off the bound
        # already, so a kill now does not count those four twice.
        assert [i['upper_bound'] for m in markers() for i in m['identities']] == [2], markers()
        # And a worker that takes one of the four now does not send it.
        with patch('urllib.request.urlopen', side_effect=AssertionError('sent after it was recorded as not sent')) as late:
            pending.pop(0)()
            assert not late.called
        assert stopper.is_alive(), 'the stop stopped waiting before the check ran'
        stopper.join(5)
        stopped = gaps('proxy-stopped')
        assert len(stopped) == 1 and stopped[0]['skipped_units'] == 4 and stopped[0]['skipped_body_bytes'] == 40, stopped
        assert stopped[0]['capture_delivery'] == 'not-sent'
        interrupted = gaps('delivery-interrupted')
        assert len(interrupted) == 1 and interrupted[0]['skipped_units'] == 2, interrupted
        assert interrupted[0]['capture_delivery'] == 'unknown'
        for g in stopped + interrupted:
            assert g['subtype'] == 'capture_gap' and g['source'] == 'mitmproxy'
            assert g['gap_started_at'] <= g['gap_ended_at']
        assert all(r['_identity'] == A for r in spooled())
        assert markers() == [], 'a recorded stop left its marker for the app to count again'
        release.set()
        for w in workers:
            w.join(2)

    # The four still queued are not sent after they were recorded as not sent.
    with patch('urllib.request.urlopen', side_effect=AssertionError('sent after the stop')) as urlopen:
        for deliver in pending:
            deliver()
        assert not urlopen.called
    pending.clear()

    # Every slot came back.
    for _ in range(64):
        assert ns['_SEND_SLOTS'].acquire(blocking=False)
    for _ in range(64):
        ns['_SEND_SLOTS'].release()

    # An event after the stop is refused into a gap, never queued.
    assert send(event(size=7)) is False and not pending
    ns['_flush_gaps']()
    assert sum(g['skipped_units'] for g in gaps('proxy-stopped')) == 5
    assert markers() == []

    # A second stop (the shutdown hook after a requested stop) records nothing new.
    count = len(spooled())
    ns['_stop_sending'](0.1)
    assert len(spooled()) == count
    assert not re.search(r'SECRET|private\.test|UFJJVkFURS1CWVRFUw', json.dumps(spooled()))

    # Leave what the production code wrote for a reader on the app side.
    if len(sys.argv) > 1:
        shutil.copytree(root / 'pending', sys.argv[1], dirs_exist_ok=True)

# A bound that failed to reach the disk is not taken as written: the next
# event tries again, so the file is never below what memory believes.
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    blocked = root / 'blocked'
    blocked.write_text('not a directory')
    ns.update(_INFLIGHT={}, _INFLIGHT_STATE={'stopping': False, 'marker': False}, INFLIGHT_DIR=blocked / 'inflight')
    payload = {'_identity': A, 'data': {}}
    assert ns['_inflight_admit'](payload) is True
    assert ns['_INFLIGHT'][('A', 'op-A')]['bound'] == 0, 'a failed write was remembered as written'
    ns['INFLIGHT_DIR'] = root / 'inflight'
    assert ns['_inflight_admit'](payload) is True
    assert [i['upper_bound'] for m in [json.loads(p.read_text()) for p in (root / 'inflight').glob('*.json')] for i in m['identities']] == [8]

# The stop request: only the owner's token stops the proxy, and a stop records
# before it shuts down.
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    ns.update(_INFLIGHT={}, _INFLIGHT_STATE={'stopping': False, 'marker': False},
              SPOOL_DIR=root / 'pending', INFLIGHT_DIR=root / 'inflight')
    addon = ns['RedLogAddon']()

    def control(token):
        flow = types.SimpleNamespace(
            request=types.SimpleNamespace(pretty_host='redlog.verify.invalid', path='/__redlog_stop',
                                          scheme='http', headers={} if token is None else {'x-redlog-control': token}),
            response=None)
        assert addon._answer_verification(flow) is True
        return flow.response.status_code

    os.environ['REDLOG_PROXY_CONTROL_TOKEN'] = 'owner-secret'
    try:
        assert control(None) == 403 and control('wrong') == 403 and control('owner-secre') == 403
        time.sleep(0.2)
        assert shutdowns == [] and ns['_INFLIGHT_STATE']['stopping'] is False
        assert control('owner-secret') == 202
        deadline = time.time() + 3
        while not shutdowns and time.time() < deadline:
            time.sleep(0.02)
        assert len(shutdowns) == 1 and ns['_INFLIGHT_STATE']['stopping'] is True
        os.environ['REDLOG_PROXY_CONTROL_TOKEN'] = ''
        ns['_INFLIGHT_STATE']['stopping'] = False
        assert control('') == 403, 'an unset token let anyone stop the proxy'
    finally:
        os.environ.pop('REDLOG_PROXY_CONTROL_TOKEN', None)
print('stop gap checks passed')
