import ast, json, tempfile, pathlib, types, urllib.request, urllib.error
from unittest.mock import patch
# Execute the production transport functions without requiring optional mitmproxy.
tree = ast.parse(pathlib.Path('hooks/mitmproxy-addon.py').read_text())
names = {'_identity_matches_active', '_embed_identity', '_spool_payload', '_send_to_redlog', '_send_to_redlog_and_get_id',
         '_write_spool_record', '_note_queue_rejection', '_flush_queue_gaps', '_declared_body_bytes', '_queue_gap_record', '_save_queue_gaps'}
gap_state = {'_QUEUE_GAP_FLUSH_MS', '_QUEUE_GAPS', '_QUEUE_GAP_LOCK'}
ns = dict(json=json, time=__import__('time'), urllib=urllib, VERBOSE=False, threading=__import__('threading'))
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    ns['_SPOOL_LOCK'] = __import__('threading').Lock()
    ns['_SEND_SLOTS'] = __import__('threading').BoundedSemaphore(64)
    ns.update(_IDENTITY_PATH=root/'identity', SPOOL_DIR=root/'pending')
    pending = []
    ns['_SEND_QUEUE'] = types.SimpleNamespace(put=pending.append)
    ns['threading'] = types.SimpleNamespace(Lock=__import__('threading').Lock, Thread=lambda target, daemon: types.SimpleNamespace(start=lambda: pending.append(target)))
    ns['_get_redlog_connection'] = lambda: ('1234', 'original-token')
    exec(compile(ast.Module(body=[n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in names)
        or (isinstance(n, (ast.Assign, ast.AnnAssign)) and any(isinstance(t, ast.Name) and t.id in gap_state for t in (n.targets if isinstance(n, ast.Assign) else [n.target])))],
        type_ignores=[]), '<production-transport>', 'exec'), ns)
    identity = ns['_IDENTITY_PATH']
    identity.write_text(json.dumps({'engagementId':'A','operatorId':'op-A'}))
    payload={'agent_type':'scanner','data':{'flow_id':'old','url':'https://private.test/?token=SECRET','response_body':{'data':'PRIVATE-BYTES'},'headers':{'cookie':'SECRET'}}}
    ns['_send_to_redlog'](payload)
    identity.write_text(json.dumps({'engagementId':'B','operatorId':'op-B'}))
    with patch('urllib.request.urlopen', side_effect=OSError('offline')): pending.pop()()
    rows=list(ns['SPOOL_DIR'].glob('*.json'))
    assert len(rows)==1
    assert json.loads(rows[0].read_text())['_identity']['engagementId']=='A', 'spool rebound old event to B'
    assert 'SECRET' not in rows[0].read_text() and 'PRIVATE-BYTES' not in rows[0].read_text()
    assert json.loads(rows[0].read_text())['data']['subtype']=='capture_gap'
    assert ns['_send_to_redlog']({'_identity':{'engagementId':'A','operatorId':'op-A'},'data':{}}) is False
    assert not pending
    for f in rows:f.unlink()
    for code in (400,401,403,409,413,422,429):
        ns['_send_to_redlog']({'agent_type':'scanner','data':{}})
        with patch('urllib.request.urlopen',side_effect=urllib.error.HTTPError('http://local',code,'refused',{},None)):pending.pop()()
        assert not list(ns['SPOOL_DIR'].glob('*.json')), f'refused {code} was spooled'
        with patch('urllib.request.urlopen',side_effect=urllib.error.HTTPError('http://local',code,'refused',{},None)):
            assert ns['_send_to_redlog_and_get_id']({'agent_type':'dns','data':{}}) is None
        assert not list(ns['SPOOL_DIR'].glob('*.json')), f'sync refused {code} was spooled'
    # A temporary service outage remains retryable, still pinned to its owner.
    with patch('urllib.request.urlopen',side_effect=urllib.error.HTTPError('http://local',503,'unavailable',{},None)):
        assert ns['_send_to_redlog_and_get_id']({'agent_type':'dns','data':{}}) is None
    rows=list(ns['SPOOL_DIR'].glob('*.json'))
    assert len(rows)==1 and json.loads(rows[0].read_text())['_identity']['engagementId']=='B'
    ns['ctx'] = types.SimpleNamespace(log=types.SimpleNamespace(warn=lambda _: None))
    for _ in range(64):
        assert ns['_send_to_redlog']({'agent_type':'scanner','data':{}}) is True
    assert ns['_send_to_redlog']({'agent_type':'scanner','data':{}}) is False
    assert len(pending)==64
    with patch('urllib.request.urlopen',return_value=None):
        while pending: pending.pop(0)()
    assert ns['_send_to_redlog']({'agent_type':'scanner','data':{}}) is True
print('transport identity and refusal checks passed')
