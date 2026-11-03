import importlib.util, json, os, pathlib, sys, threading, time
# Runs the production pcap-agent spool writer with the clock frozen, as a
# coarse Windows tick makes it, and prints what ended up in the spool.
# Usage: pcap-spool-names-check.py <home>
home = pathlib.Path(sys.argv[1])
os.environ['HOME'] = str(home)
os.environ['USERPROFILE'] = str(home)
(home / '.redlog').mkdir(exist_ok=True)

# pcap-agent keeps scapy behind a lazy import, so the module loads as is.
sys.argv = ['pcap-agent.py']
spec = importlib.util.spec_from_file_location('pcap_agent', 'hooks/pcap-agent.py')
pcap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pcap)
pcap.SPOOL_DIR = home / '.redlog' / 'pcap-pending'

FROZEN = 1_700_000_000_000_000_000
pcap.time = type('FrozenTime', (), {'time_ns': staticmethod(lambda: FROZEN), 'time': staticmethod(lambda: FROZEN / 1e9)})

COUNT = 50
# In order, one thread: the names must sort in write order.
for i in range(COUNT):
    pcap._spool_payload({'agent_type': 'pcap', 'data': {'n': i}})
ordered = [json.loads(f.read_text(encoding='utf-8'))['data']['n'] for f in sorted(pcap.SPOOL_DIR.glob('*.json'))]

# Concurrent, as the send threads are: every payload must survive.
for f in pcap.SPOOL_DIR.glob('*'):
    f.unlink()
threads = [threading.Thread(target=pcap._spool_payload, args=({'agent_type': 'pcap', 'data': {'n': i}},)) for i in range(COUNT)]
for t in threads:
    t.start()
for t in threads:
    t.join()
kept = sorted(json.loads(f.read_text(encoding='utf-8'))['data']['n'] for f in pcap.SPOOL_DIR.glob('*.json'))

print(json.dumps({
    'written': COUNT,
    'ordered': ordered,
    'concurrent_kept': kept,
    'leftovers': sorted(f.name for f in pcap.SPOOL_DIR.iterdir() if not f.name.endswith('.json'))
}))
