import importlib.util, json, os, pathlib, sys
# Runs the production pcap-agent _emit with the network send replaced, and
# prints the payloads it would have sent or spooled.
# Usage: pcap-source-time-check.py <home>
home = pathlib.Path(sys.argv[1])
os.environ['HOME'] = str(home)
os.environ['USERPROFILE'] = str(home)

sys.argv = ['pcap-agent.py']
spec = importlib.util.spec_from_file_location('pcap_agent', 'hooks/pcap-agent.py')
pcap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pcap)

sent = []
pcap._send_to_redlog = sent.append
pcap._now_ms = lambda: 1_790_000_000_000

pcap._emit('connection_attempt', '10.0.0.1', {'dst_port': 22, 'proto': 'tcp', 'at': 1_780_000_000_001})
agg = pcap.SynAggregator(emit=pcap._emit)
for port in range(20):
    agg.add_syn('10.0.0.2', 1000 + port, 1_780_000_000_100 + port)
agg.flush()
pcap._emit('udp_flow', '10.0.0.3', {'dst_port': 53, 'proto': 'udp'})

print(json.dumps([{'subtype': p['data']['subtype'], 'source_timestamp': p['data'].get('source_timestamp')} for p in sent]))
