import ast, json, re, shutil, sys, tempfile, pathlib, time, types, urllib.request
# #459: an event pinned to project A and sent after B was opened is refused,
# so nothing of A's reaches B. The refusal used to leave nothing at all: A
# held the request and no word of why the answer was missing. It now leaves a
# capture_gap for A in the spool — when and how many, never the URL, a header
# or a body — batched one record a window, and never sent through the queue.
# Runs the production transport functions without mitmproxy.
tree = ast.parse(pathlib.Path('hooks/mitmproxy-addon.py').read_text(encoding='utf-8'))
functions = {'_identity_matches_active', '_embed_identity', '_spool_payload', '_send_to_redlog', '_send_to_redlog_and_get_id',
             '_write_spool_record', '_note_refusal', '_note_switch_refusal', '_flush_gaps', '_declared_body_bytes', '_gap_record', '_save_gaps'}
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
    B = {'engagementId': 'B', 'operatorId': 'op-B'}

    def activate(ident):
        if ident is None:
            ns['_IDENTITY_PATH'].unlink(missing_ok=True)
        else:
            ns['_IDENTITY_PATH'].write_text(json.dumps(ident))

    def late(ident=A, size=10):
        """A's answer, arriving after the switch, with content only A may hold."""
        payload = {'agent_type': 'scanner', 'target_id': 'private.test', 'data': {
            'subtype': 'http_response', 'flow_id': 'f', 'url': 'https://private.test/?token=SECRET',
            'response_headers': [['set-cookie', 'session=SECRET']],
            'response_body': {'data': 'UFJJVkFURS1CWVRFUw==', 'encoding': 'base64', 'size': size}}}
        if ident is not None:
            payload['_identity'] = dict(ident)
        return payload

    def spooled():
        return [json.loads(p.read_text()) for p in sorted(ns['SPOOL_DIR'].glob('*.json'))]

    def gaps():
        return [r for r in spooled() if r['data'].get('reason') == 'project-switched']

    # The request was A's and went to A.
    activate(A)
    assert send(late()) is True and len(pending) == 1

    # The switch. A's late answer is refused, and the refusal is on disk at
    # once for A — not queued, so it cannot reach B by the send path.
    activate(B)
    assert send(late(size=10)) is False
    assert len(pending) == 1, 'a refused event for A was queued while B is active'
    first = gaps()
    assert len(first) == 1, f'expected one gap record, found {len(first)}: {spooled()}'
    g = first[0]
    assert g['_identity'] == A and g['agent_type'] == 'scanner'
    assert g['data']['subtype'] == 'capture_gap' and g['data']['source'] == 'mitmproxy'
    assert g['data']['skipped_units'] == 1 and g['data']['skipped_body_bytes'] == 10
    assert g['data']['gap_started_at'] == g['data']['gap_ended_at'] == 1000000
    text = json.dumps(g)
    assert 'SECRET' not in text and 'private.test' not in text and 'UFJJVkFURS1CWVRFUw' not in text, text

    # Refusals inside one window are merged, not a file each.
    for _ in range(999):
        assert send(late(size=1)) is False
    assert len(gaps()) == 1, 'every refusal wrote its own file'
    clock[0] += 2
    assert send(late(size=1)) is False
    second = gaps()[1]['data']
    assert second['skipped_units'] == 1000 and second['skipped_body_bytes'] == 1000
    assert second['gap_started_at'] == 1000000 and second['gap_ended_at'] == 1002000

    # B keeps recording. Its sends do not cut A's window short: unlike a full
    # queue, nothing about the switch has recovered. Once the window has run,
    # the next send writes what A's window still holds.
    assert send(late(size=3)) is False
    assert send(late(B)) is True
    assert len(gaps()) == 2, "B's send wrote A's open window early"
    clock[0] += 2
    assert send(late(B)) is True
    third = gaps()
    assert len(third) == 3 and third[2]['data']['skipped_units'] == 1 and third[2]['data']['skipped_body_bytes'] == 3

    # Shutdown writes what is still counted, and an empty flush writes nothing.
    assert send(late(size=4)) is False
    assert send(late(size=5)) is False
    count = len(gaps())
    ns['_flush_gaps']()
    assert len(gaps()) == count + 1 and gaps()[-1]['data']['skipped_units'] == 1
    ns['_flush_gaps']()
    assert len(gaps()) == count + 1, 'an empty flush wrote a record'

    # The synchronous path (a DNS query) refuses the same way.
    clock[0] += 5
    assert ns['_send_to_redlog_and_get_id'](late(size=0)) is None
    assert len(gaps()) == count + 2 and gaps()[-1]['_identity'] == A

    # An event pinned to no project has no owner to tell: nothing is written.
    activate(None)
    clock[0] += 5
    before = len(spooled())
    assert send(late(None)) is False
    assert len(spooled()) == before

    # Every gap is A's. Nothing in the spool is B's, and nothing carries content.
    assert all(r['_identity'] == A for r in gaps())
    assert not [r for r in spooled() if r['_identity'].get('engagementId') == 'B']
    assert sum(r['data']['skipped_units'] for r in gaps()) == 1 + 1000 + 1 + 2 + 1
    assert not re.search(r'SECRET|private\.test|UFJJVkFURS1CWVRFUw', json.dumps(spooled()))

    # Leave what the production code wrote for a reader on the app side.
    if len(sys.argv) > 1:
        shutil.copytree(root / 'pending', sys.argv[1], dirs_exist_ok=True)

    # A gap that cannot be saved says so — in words the app does not read as a
    # full queue in the project now open, which is B, not the gap's owner.
    activate(B)
    blocked = root / 'blocked'
    blocked.write_text('not a directory')
    ns['SPOOL_DIR'] = blocked / 'pending'
    clock[0] += 5
    warnings.clear()
    assert send(late()) is False
    assert any('gap' in w and 'not saved' in w for w in warnings), warnings
    assert not any(re.search(r'\[redlog\] capture gap not saved: (\d+) event', w) for w in warnings), warnings
print('switch gap checks passed')
