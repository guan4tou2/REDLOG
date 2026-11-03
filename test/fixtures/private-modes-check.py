import ast, importlib.util, json, os, pathlib, sys, threading, time, types
# Runs the production spool writers under the umask the test sets, without
# mitmproxy or a network, and prints the mode bits of what they created.
# Usage: private-modes-check.py <home>
home = pathlib.Path(sys.argv[1])
os.environ['HOME'] = str(home)
os.environ['USERPROFILE'] = str(home)
# A parent directory created by the caller with the umask's mode must not decide
# what the spool directory below it is.
(home / '.redlog').mkdir(exist_ok=True)


def mode(path):
    return oct(os.stat(path).st_mode & 0o777)


tree = ast.parse(pathlib.Path('hooks/mitmproxy-addon.py').read_text(encoding='utf-8'))
functions = {'_write_spool_record', '_write_inflight_marker'}
assigns = {'_SPOOL_LOCK', '_INFLIGHT', '_INFLIGHT_STATE', '_INFLIGHT_INSTANCE', '_INFLIGHT_STARTED_MS'}
body = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in functions)
        or (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in assigns for t in n.targets))
        or (isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.target.id in assigns)]
ns = dict(json=json, os=os, time=time, threading=threading,
          SPOOL_DIR=home / '.redlog' / 'pending', INFLIGHT_DIR=home / '.redlog' / 'inflight',
          _INFLIGHT_LOCK=threading.Lock())
exec(compile(ast.Module(body=body, type_ignores=[]), '<production-addon>', 'exec'), ns)

out = {}
assert ns['_write_spool_record']({'agent_type': 'scanner', '_identity': {'engagementId': 'e', 'operatorId': 'o'}, 'data': {}})
out['addon_spool_dir'] = mode(ns['SPOOL_DIR'])
out['addon_spool_files'] = sorted({mode(f) for f in ns['SPOOL_DIR'].glob('*.json')})
ns['_INFLIGHT']['k'] = {'identity': {'engagementId': 'e'}, 'bound': 8, 'since': 1, 'last': 1}
assert ns['_write_inflight_marker']()
out['addon_inflight_dir'] = mode(ns['INFLIGHT_DIR'])
out['addon_inflight_files'] = sorted({mode(f) for f in ns['INFLIGHT_DIR'].glob('*.json')})

# pcap-agent keeps scapy behind a lazy import, so the module loads as is.
sys.argv = ['pcap-agent.py']
spec = importlib.util.spec_from_file_location('pcap_agent', 'hooks/pcap-agent.py')
pcap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pcap)
pcap.SPOOL_DIR = home / '.redlog' / 'pcap-pending'
pcap._spool_payload({'agent_type': 'scanner', 'data': {}})
out['pcap_spool_dir'] = mode(pcap.SPOOL_DIR)
out['pcap_spool_files'] = sorted({mode(f) for f in pcap.SPOOL_DIR.glob('*.json')})
print(json.dumps(out))
