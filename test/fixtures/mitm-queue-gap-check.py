import ast, json, shutil, sys, tempfile, pathlib, time, types, urllib.request
# #460: when the 64 send slots are taken, an event refused at admission used
# to leave only a log line. It now leaves a capture_gap in the spool: bounded,
# pinned to the event's project, with when and how much, and no URL, header
# or body. The gap does not go through the full queue it is reporting.
# Runs the production transport functions without mitmproxy.
tree = ast.parse(pathlib.Path('hooks/mitmproxy-addon.py').read_text(encoding='utf-8'))
functions = {'_identity_matches_active', '_embed_identity', '_spool_payload', '_send_to_redlog',
             '_write_spool_record', '_note_refusal', '_note_switch_refusal', '_flush_gaps', '_declared_body_bytes',
             '_gap_record', '_save_gaps'}
assigns = {'_GAP_FLUSH_MS', '_GAP_WINDOWS', '_GAP_LOCK', '_GAP_TEXT'}
body = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in functions)
        or (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in assigns for t in n.targets))
        or (isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.target.id in assigns)]
found = {n.name for n in body if isinstance(n, ast.FunctionDef)} | {t.id for n in body if isinstance(n, ast.Assign) for t in n.targets} | {n.target.id for n in body if isinstance(n, ast.AnnAssign)}
assert found >= functions | assigns, f'missing from the addon: {sorted((functions | assigns) - found)}'

clock = [1000.0]
warnings = []
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    pending = []
    ns = dict(json=json, urllib=urllib, VERBOSE=False, threading=__import__('threading'),
              time=types.SimpleNamespace(time=lambda: clock[0], time_ns=time.time_ns),
              ctx=types.SimpleNamespace(log=types.SimpleNamespace(warn=warnings.append)),
              _SPOOL_LOCK=__import__('threading').Lock(), _SEND_SLOTS=__import__('threading').BoundedSemaphore(64),
              _SEND_QUEUE=types.SimpleNamespace(put=pending.append),
              _IDENTITY_PATH=root / 'identity', SPOOL_DIR=root / 'pending',
              _get_redlog_connection=lambda: ('1234', 'token'))
    exec(compile(ast.Module(body=body, type_ignores=[]), '<production-transport>', 'exec'), ns)
    send = ns['_send_to_redlog']
    A = {'engagementId': 'A', 'operatorId': 'op-A'}
    ns['_IDENTITY_PATH'].write_text(json.dumps(A))

    def event(size=10):
        return {'agent_type': 'scanner', 'target_id': 'private.test', 'data': {
            'subtype': 'http_response_chunk', 'flow_id': 'f', 'url': 'https://private.test/?token=SECRET',
            'response_headers': [['set-cookie', 'SECRET']],
            'response_body': {'data': 'UFJJVkFURS1CWVRFUw==', 'encoding': 'base64', 'size': size}}}

    def gaps():
        rows = [json.loads(p.read_text()) for p in sorted(ns['SPOOL_DIR'].glob('*.json'))]
        return [r for r in rows if r['data'].get('reason') == 'queue-full']

    def drain():
        with __import__('unittest.mock', fromlist=['patch']).patch('urllib.request.urlopen', return_value=None):
            while pending: pending.pop(0)()

    for _ in range(64):
        assert send(event()) is True
    # The first refusal is on disk at once, so a gap exists even if the
    # producer is killed straight after it.
    assert send(event(10)) is False
    first = gaps()
    assert len(first) == 1, f'expected one gap record, found {len(first)}'
    g = first[0]
    assert g['_identity'] == A and g['agent_type'] == 'scanner'
    assert g['data']['subtype'] == 'capture_gap' and g['data']['source'] == 'mitmproxy'
    assert g['data']['skipped_units'] == 1 and g['data']['skipped_body_bytes'] == 10
    assert g['data']['gap_started_at'] == g['data']['gap_ended_at'] == 1000000
    text = json.dumps(g)
    assert 'SECRET' not in text and 'private.test' not in text and 'UFJJVkFURS1CWVRFUw' not in text, text

    # Refusals inside one window are merged, not a file each.
    for _ in range(999):
        assert send(event(1)) is False
    assert len(gaps()) == 1, 'every refusal wrote its own file'
    clock[0] += 2
    assert send(event(1)) is False
    second = gaps()[1]['data']
    assert second['skipped_units'] == 1000 and second['skipped_body_bytes'] == 1000
    assert second['gap_started_at'] == 1000000 and second['gap_ended_at'] == 1002000

    # A refusal that is not yet flushed is written when the queue recovers.
    assert send(event(5)) is False
    assert len(gaps()) == 2
    drain()
    assert send(event()) is True
    tail = gaps()
    assert len(tail) == 3 and tail[2]['data']['skipped_units'] == 1 and tail[2]['data']['skipped_body_bytes'] == 5
    assert sum(g['data']['skipped_units'] for g in tail) == 1002

    # Shutdown writes what is still counted.
    drain()
    for _ in range(64):
        assert send(event()) is True
    assert send(event(3)) is False
    assert send(event(4)) is False
    count = len(gaps())
    ns['_flush_gaps']()
    assert len(gaps()) == count + 1 and gaps()[-1]['data']['skipped_units'] == 1
    ns['_flush_gaps']()
    assert len(gaps()) == count + 1, 'an empty flush wrote a record'

    # Another project's event is refused by identity, not counted as A's gap.
    ns['_IDENTITY_PATH'].write_text(json.dumps({'engagementId': 'B', 'operatorId': 'op-B'}))
    before = len(gaps())
    clock[0] += 5
    assert send({'_identity': A, 'agent_type': 'scanner', 'data': {}}) is False
    assert len(gaps()) == before
    # It is A's project-switched gap instead (#459), which is not this file's
    # subject: leave only queue-full records for the reader below.
    switched = [p for p in ns['SPOOL_DIR'].glob('*.json') if json.loads(p.read_text())['data'].get('reason') == 'project-switched']
    assert len(switched) == 1, switched
    switched[0].unlink()

    # Leave what the production code wrote for a reader on the app side.
    if len(sys.argv) > 1:
        shutil.copytree(root / "pending", sys.argv[1], dirs_exist_ok=True)

    # A gap that cannot be saved says so instead of passing silently.
    ns['_IDENTITY_PATH'].write_text(json.dumps(A))
    blocked = root / 'blocked'
    blocked.write_text('not a directory')
    ns['SPOOL_DIR'] = blocked / 'pending'
    clock[0] += 5
    warnings.clear()
    assert send(event()) is False
    assert any('gap' in w for w in warnings), warnings
print('queue gap checks passed')
