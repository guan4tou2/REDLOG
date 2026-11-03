import ast, json, os, sys, tempfile, pathlib, threading, time, types, urllib.request
# #507: the addon's spool write raced the app's drain, which unlinks files as it
# replays them, so a gap record that could have been written read as "spool
# full"; and a gap that could not be written left a line the app recognised for
# one reason in four. This runs the production functions without mitmproxy and
# prints what they did as JSON, for the test to judge. One mode per argument.
tree = ast.parse(pathlib.Path('hooks/mitmproxy-addon.py').read_text(encoding='utf-8'))
functions = {'_identity_matches_active', '_embed_identity', '_spool_payload', '_send_to_redlog', '_send_to_redlog_and_get_id',
             '_write_spool_record', '_note_refusal', '_note_switch_refusal', '_flush_gaps', '_declared_body_bytes', '_gap_record', '_save_gaps',
             '_inflight_key', '_write_inflight_marker', '_inflight_admit', '_inflight_begin', '_inflight_end'}
assigns = {'_GAP_FLUSH_MS', '_GAP_WINDOWS', '_GAP_LOCK', '_GAP_TEXT',
           '_INFLIGHT', '_INFLIGHT_LOCK', '_INFLIGHT_STATE', '_INFLIGHT_STEP', '_INFLIGHT_INSTANCE', '_INFLIGHT_STARTED_MS'}
body = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in functions)
        or (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in assigns for t in n.targets))
        or (isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.target.id in assigns)]
found = {n.name for n in body if isinstance(n, ast.FunctionDef)} | {t.id for n in body if isinstance(n, ast.Assign) for t in n.targets} | {n.target.id for n in body if isinstance(n, ast.AnnAssign)}
assert found >= functions | assigns, f'missing from the addon: {sorted((functions | assigns) - found)}'

A = {'engagementId': 'A', 'operatorId': 'op-A'}
B = {'engagementId': 'B', 'operatorId': 'op-B'}
MIB = 1024 * 1024


TICK_NS = 15_625_000  # Windows' clock tick on Python before 3.13, which CI runs


def load(root, warnings, clock=None, time_ns=None):
    pending = []
    t = types.SimpleNamespace(time=(lambda: clock[0]) if clock else time.time, time_ns=time_ns or time.time_ns) if (clock or time_ns) else time
    ns = dict(json=json, urllib=urllib, VERBOSE=False, threading=threading, time=t, os=os,
              ctx=types.SimpleNamespace(log=types.SimpleNamespace(warn=warnings.append)),
              _SPOOL_LOCK=threading.Lock(), _SEND_SLOTS=threading.BoundedSemaphore(64),
              _SEND_QUEUE=types.SimpleNamespace(put=pending.append),
              _IDENTITY_PATH=root / 'identity', SPOOL_DIR=root / 'pending', INFLIGHT_DIR=root / 'inflight',
              _get_redlog_connection=lambda: ('1234', 'token'))
    exec(compile(ast.Module(body=body, type_ignores=[]), '<production-transport>', 'exec'), ns)
    return ns


def record(i=0):
    return {'agent_type': 'scanner', '_identity': A, 'data': {'subtype': 'capture_gap', 'pad': 'x' * 200, 'i': i}}


class DrainWinsTheRace:
    """The spool directory, with the app's drain unlinking a file between the
    addon listing it and looking at it."""
    def __init__(self, real):
        self.real = real
        self.drained = 0

    def mkdir(self, *args, **kwargs):
        self.real.mkdir(*args, **kwargs)

    def glob(self, pattern):
        listed = list(self.real.glob(pattern))
        for f in listed[:2]:
            f.unlink()
            self.drained += 1
        return iter(listed)

    def __truediv__(self, name):
        return self.real / name

    def __fspath__(self):
        return str(self.real)


def mode_tick():
    """Records written inside one tick of the clock are all kept, in the order
    they were written. A name from the clock and `id(record)` repeats here: the
    clock does not move, and each record is freed before the next is made."""
    out = {}
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        ns = load(root, [], time_ns=lambda: 1_700_000_000_000_000_000)
        spool = ns['SPOOL_DIR']
        results = [ns['_write_spool_record'](record(i)) for i in range(50)]
        kept = [json.loads(p.read_text())['data']['i'] for p in sorted(spool.glob('*.json'))]
        out = {'written': all(results), 'kept': kept, 'leftovers': sorted(p.name for p in spool.iterdir() if not p.name.endswith('.json'))}
    print(json.dumps(out))


def mode_race():
    out = {}
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        # The clock ticks as it does on Windows under the Python CI runs: a
        # record written while the drain unlinks one is exactly where a name
        # that repeats is refused rather than overwritten.
        ns = load(root, [], time_ns=lambda: time.time_ns() // TICK_NS * TICK_NS)
        spool = ns['SPOOL_DIR']
        spool.mkdir()
        for n in range(6):
            (spool / f'old-{n}.json').write_text('{}')
        racing = DrainWinsTheRace(spool)
        ns['SPOOL_DIR'] = racing
        out['deterministic'] = {'written': ns['_write_spool_record'](record()), 'drained': racing.drained,
                                'json_files': len(list(spool.glob('*.json')))}

        # The drain as a thread, as the issue's repro has it.
        ns['SPOOL_DIR'] = spool
        stop = threading.Event()

        def drain():
            while not stop.is_set():
                for f in list(spool.glob('*.json')):
                    try:
                        f.unlink()
                    except OSError:
                        pass
        thread = threading.Thread(target=drain, daemon=True)
        thread.start()
        failed = sum(1 for i in range(1000) if not ns['_write_spool_record'](record(i)))
        stop.set()
        thread.join()
        out['threaded'] = {'writes': 1000, 'failed': failed}
    print(json.dumps(out))


def mode_caps():
    """A real over-cap is still refused, and writes nothing."""
    out = {}
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        ns = load(root, [])
        spool = ns['SPOOL_DIR']
        spool.mkdir()
        for n in range(5000):
            (spool / f'{n:05d}.json').write_text('{}')
        before = len(list(spool.iterdir()))
        out['count_cap'] = {'written': ns['_write_spool_record'](record()), 'unchanged': len(list(spool.iterdir())) == before}
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        ns = load(root, [])
        spool = ns['SPOOL_DIR']
        spool.mkdir()
        with (spool / 'big.json').open('wb') as big:
            big.write(b'\0' * (64 * MIB))
        out['size_cap'] = {'written': ns['_write_spool_record'](record()), 'files': sorted(p.name for p in spool.iterdir())}
    print(json.dumps(out))


def mode_atomic():
    """What the drain can see while a record is being written: only `.json`
    files, and only complete ones."""
    seen = {'visible_before_rename': None, 'complete_at_rename': None, 'leftovers': None}
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        ns = load(root, [])
        spool = ns['SPOOL_DIR']
        spool.mkdir()

        class Spy:
            def __init__(self, real):
                self.real = real

            def open(self, *args, **kwargs):
                return self.real.open(*args, **kwargs)

            def __fspath__(self):
                return str(self.real)

            def replace(self, target):
                # Everything the drain's `*.json` listing would see right now.
                seen['visible_before_rename'] = sorted(p.name for p in spool.glob('*.json'))
                try:
                    json.loads(self.real.read_bytes())
                    seen['complete_at_rename'] = True
                except Exception:
                    seen['complete_at_rename'] = False
                return self.real.replace(target)

            def unlink(self, *args, **kwargs):
                return self.real.unlink(*args, **kwargs)

        class Dir:
            def mkdir(self, *args, **kwargs):
                spool.mkdir(*args, **kwargs)

            def glob(self, pattern):
                return spool.glob(pattern)

            def __truediv__(self, name):
                return Spy(spool / name) if name.endswith('.tmp') else spool / name

        ns['SPOOL_DIR'] = Dir()
        seen['written'] = ns['_write_spool_record'](record())
        seen['leftovers'] = sorted(p.name for p in spool.iterdir() if not p.name.endswith('.json'))
        seen['json_files'] = len(list(spool.glob('*.json')))
    print(json.dumps(seen))


def mode_unsaved():
    """Every gap the addon cannot write, and the line each one leaves."""
    out = {}
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        clock = [1000.0]
        warnings = []
        ns = load(root, warnings, clock)
        blocked = root / 'blocked'
        blocked.write_text('not a directory')
        ns['SPOOL_DIR'] = blocked / 'pending'
        ns['_IDENTITY_PATH'].write_text(json.dumps(A))

        def payload(ident=A):
            p = {'agent_type': 'scanner', 'data': {'subtype': 'http_response', 'url': 'https://private.test/?t=SECRET',
                                                    'response_body': {'size': 10}}}
            if ident is not None:
                p['_identity'] = dict(ident)
            return p

        def capture(name, action):
            del warnings[:]
            action()
            out[name] = list(warnings)

        # queue-full: the send slots are all taken.
        def queue_full():
            for _ in range(64):
                ns['_SEND_SLOTS'].acquire(blocking=False)
            ns['_send_to_redlog'](payload())
            for _ in range(64):
                ns['_SEND_SLOTS'].release()
        capture('queue-full', queue_full)

        # project-switched: B is open, A's answer arrives.
        def switched():
            ns['_IDENTITY_PATH'].write_text(json.dumps(B))
            clock[0] += 5
            ns['_send_to_redlog'](payload())
        capture('project-switched', switched)

        # A window the proxy was holding when it stopped, and one it was sending.
        def stopped():
            ns['_save_gaps']([ns['_gap_record']({'reason': 'proxy-stopped', 'identity': A, 'started': 1_000_000, 'last': 1_002_000,
                                                 'units': 7, 'bytes': 0}, 1_003_000)])
        capture('proxy-stopped', stopped)

        def interrupted():
            ns['_save_gaps']([ns['_gap_record']({'reason': 'delivery-interrupted', 'identity': A, 'started': 1_000_000,
                                                 'last': 1_002_000, 'units': 3, 'bytes': 0}, 1_003_000)])
        capture('delivery-interrupted', interrupted)

        # POST failed: the record was written with no look at the result.
        capture('delivery-unconfirmed', lambda: ns['_spool_payload'](payload()))
    print(json.dumps(out))


def mode_cleared():
    """An event pinned to A arrives after the active identity is gone, and after
    it is B's."""
    out = {}
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        clock = [1000.0]
        ns = load(root, [], clock)
        spool = ns['SPOOL_DIR']

        def late():
            return {'agent_type': 'scanner', '_identity': dict(A), 'data': {
                'subtype': 'http_response', 'response_body': {'size': 10}}}

        def gaps():
            return [json.loads(p.read_text()) for p in sorted(spool.glob('*.json'))]

        # The project closed: the file is gone, no other project is open.
        ns['_IDENTITY_PATH'].write_text(json.dumps(A))
        ns['_IDENTITY_PATH'].unlink()
        ns['_send_to_redlog'](late())
        ns['_flush_gaps']()
        out['cleared'] = [{'reason': g['data']['reason'], 'identity': g['_identity'], 'units': g['data']['skipped_units']} for g in gaps()]

        for p in list(spool.glob('*.json')):
            p.unlink()
        clock[0] += 5
        # Another project opened.
        ns['_IDENTITY_PATH'].write_text(json.dumps(B))
        ns['_send_to_redlog'](late())
        ns['_flush_gaps']()
        out['switched'] = [{'reason': g['data']['reason'], 'identity': g['_identity'], 'units': g['data']['skipped_units']} for g in gaps()]
    print(json.dumps(out))


{'race': mode_race, 'tick': mode_tick, 'caps': mode_caps, 'atomic': mode_atomic, 'unsaved': mode_unsaved, 'cleared': mode_cleared}[sys.argv[1]]()
