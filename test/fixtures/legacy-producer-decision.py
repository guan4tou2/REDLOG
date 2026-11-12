# What a Python producer does with one /api/events answer, for
# test/legacy-producer-decisions.test.ts (Spec 071 T004).
#
#   python3 legacy-producer-decision.py <relay|mitm|pcap-agent> <home> <port|none>
#
# <home> holds .redlog/{api-port,api-token,active-identity.json}; <port> is the
# mock server's (or `none`: no api-port file). Prints one JSON object: what the
# producer kept (spooled files and their subtypes), counted or will retry.
#
# The producers' own functions run, unmodified. mitm and pcap-agent are loaded
# the way test/fixtures/mitm-spool-integrity-check.py loads the addon: the named
# top-level functions are lifted out of the file by `ast` and executed against
# stand-ins for what they would otherwise import at load (mitmproxy's ctx, the
# worker threads). The relay is imported as a module, as
# test/relay-late-output.test.ts does.
import ast
import importlib.util
import json
import os
import pathlib
import sys
import threading
import time
import types
import urllib.error
import urllib.request

HOOKS = pathlib.Path(__file__).resolve().parent.parent.parent / "hooks"
producer, home, port = sys.argv[1], pathlib.Path(sys.argv[2]), sys.argv[3]
redlog = home / ".redlog"
spool = redlog / "pending"
IDENTITY = {"engagementId": "eng-legacy", "operatorId": "op-legacy"}


def spooled():
    files = sorted(spool.glob("*.json")) if spool.exists() else []
    return [json.loads(p.read_text(encoding="utf-8")).get("data", {}).get("subtype") for p in files]


def lift(file, functions, assigns, extra):
    tree = ast.parse((HOOKS / file).read_text(encoding="utf-8"))
    body = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in functions)
            or (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in assigns for t in n.targets))
            or (isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.target.id in assigns)]
    found = {n.name for n in body if isinstance(n, ast.FunctionDef)} | {t.id for n in body if isinstance(n, ast.Assign) for t in n.targets} \
        | {n.target.id for n in body if isinstance(n, ast.AnnAssign)}
    missing = (set(functions) | set(assigns)) - found
    assert not missing, f"missing from {file}: {sorted(missing)}"
    ns = dict(json=json, os=os, sys=sys, time=time, urllib=urllib, threading=threading, Path=pathlib.Path, VERBOSE=False)
    ns.update(extra)
    exec(compile(ast.Module(body=body, type_ignores=[]), f"<{file}>", "exec"), ns)
    return ns


def connection():
    return (port, (redlog / "api-token").read_text().strip()) if port != "none" else (None, None)


def run_relay():
    sys.path.insert(0, str(HOOKS))
    os.environ["_REDLOG_DIR"] = str(redlog)
    spec = importlib.util.spec_from_file_location("relay", HOOKS / "redlog-relay.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    late = m.LateOutput({"command_id": "cmd-legacy", "source": "auto-relay", "captured_by": "auto-relay",
                         "max_bytes": 65536, "home": str(home)})
    payload = late._payload({"seq": 1, "stream": "stdout", "stdout": "hello\n", "bytes": 6})
    verdict = late._send(payload)
    late.pending.append(late._payload({"seq": 2, "stream": "stdout", "stdout": "hello\n", "bytes": 6}))
    late.retry()
    return {"verdict": verdict, "dropped_bytes": late.dropped, "pending": len(late.pending), "spooled": spooled()}


def run_mitm():
    warnings = []
    queued = []
    functions = {"_identity_matches_active", "_embed_identity", "_spool_payload", "_send_to_redlog",
                 "_write_spool_record", "_note_refusal", "_note_switch_refusal", "_flush_gaps", "_declared_body_bytes",
                 "_gap_record", "_save_gaps", "_inflight_key", "_write_inflight_marker", "_inflight_admit",
                 "_inflight_begin", "_inflight_end"}
    assigns = {"_GAP_FLUSH_MS", "_GAP_WINDOWS", "_GAP_LOCK", "_GAP_TEXT", "_INFLIGHT", "_INFLIGHT_LOCK",
               "_INFLIGHT_STATE", "_INFLIGHT_STEP", "_INFLIGHT_INSTANCE", "_INFLIGHT_STARTED_MS"}
    ns = lift("mitmproxy-addon.py", functions, assigns, dict(
        ctx=types.SimpleNamespace(log=types.SimpleNamespace(warn=warnings.append)),
        _SPOOL_LOCK=threading.Lock(), _SEND_SLOTS=threading.BoundedSemaphore(64),
        _SEND_QUEUE=types.SimpleNamespace(put=queued.append),
        _IDENTITY_PATH=redlog / "active-identity.json", SPOOL_DIR=spool, INFLIGHT_DIR=redlog / "inflight",
        _get_redlog_connection=connection))
    admitted = ns["_send_to_redlog"]({"agent_type": "scanner", "data": {"subtype": "http_request_start", "flow_id": "f-legacy",
                                                                       "method": "GET", "url": "http://h.test/"}})
    for deliver in queued:
        deliver()
    return {"admitted": admitted, "spooled": spooled(), "warnings": len(warnings)}


def run_pcap_agent():
    class SyncThread:
        def __init__(self, target, daemon=None):
            self.target = target

        def start(self):
            self.target()
    fake_threading = types.SimpleNamespace(Thread=SyncThread, Lock=threading.Lock)
    ns = lift("pcap-agent.py", {"_embed_identity", "_spool_payload", "_send_to_redlog"}, set(), dict(
        threading=fake_threading, _SPOOL_LOCK=threading.Lock(), _last_spool_ns=0,
        _IDENTITY_PATH=redlog / "active-identity.json", SPOOL_DIR=spool,
        _get_redlog_connection=connection))
    ns["_send_to_redlog"]({"agent_type": "pcap", "target_id": "10.0.0.9",
                           "data": {"subtype": "connection_attempt", "dst_ip": "10.0.0.9", "dst_port": 22}})
    return {"spooled": spooled()}


print(json.dumps({"relay": run_relay, "mitm": run_mitm, "pcap-agent": run_pcap_agent}[producer]()))
