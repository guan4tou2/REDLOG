"""Drives hooks/redlog-relay.py's class policy for test/command-class.test.ts.

usage: python3 class-policy-driver.py <redlog-relay.py> <input.json>

One process for every case, loaded the way test/relay-late-output.test.ts
loads the relay module. Each case is {"id", "file", "probes", "shipped"}:
`file` is the exact text of ~/.redlog/command-class.json (null: no file),
`contributed` the exact text of ~/.redlog/terminal-profiles.json (null or
absent: no file) and `shipped` is a synthetic stand-in for
hooks/command-class.json (null: the real one).

With the real policy the files are written into a fresh temp home and read the
way the shell reads them, through load_policy(home). With a synthetic one the
text is parsed here (unparseable: no overlay, and False for the snapshot) and
handed to build_policy, because load_policy only ever reads the file beside the
relay.

Prints {id: {"modes": {probe: mode}, "native", "pty", "entries", "problems"}}:
the modes classify_argv gives each probe, and the compiled policy as it is.
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile

spec = importlib.util.spec_from_file_location("relay", sys.argv[1])
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)

with open(sys.argv[2], "r") as fh:
    cases = json.load(fh)["cases"]

out = {}
for case in cases:
    shipped = case.get("shipped")
    contributed = case.get("contributed")
    home = tempfile.mkdtemp(prefix="redlog-class-")
    try:
        if shipped is None:
            os.makedirs(os.path.join(home, ".redlog"))
            for name, text in (("command-class.json", case["file"]), ("terminal-profiles.json", contributed)):
                if text is not None:
                    with open(os.path.join(home, ".redlog", name), "w") as fh:
                        fh.write(text)
            policy = relay.load_policy(home)
        else:
            try:
                overlay = None if case["file"] is None else json.loads(case["file"])
            except ValueError:
                overlay = None
            # What read_contributed_file hands over: None for no file, False for
            # one that cannot be parsed, else what it parsed to.
            try:
                snapshot = None if contributed is None else json.loads(contributed)
            except ValueError:
                snapshot = False
            policy = relay.build_policy(shipped, overlay, snapshot)
        out[case["id"]] = {
            "modes": {p: relay.classify_argv([p], policy) for p in case.get("probes", [])},
            "native": policy["native"],
            "pty": policy["pty"],
            "entries": policy["entries"],
            "problems": policy["problems"],
        }
    finally:
        shutil.rmtree(home, ignore_errors=True)

sys.stdout.write(json.dumps(out))
