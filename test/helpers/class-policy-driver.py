"""Drives hooks/redlog-relay.py's class policy for test/command-class.test.ts.

usage: python3 class-policy-driver.py <redlog-relay.py> <input.json>

One process for every case, loaded the way test/relay-late-output.test.ts
loads the relay module. Each case is {"id", "file", "probes"}: `file` is the
exact text of ~/.redlog/command-class.json (null: no file), written into a
fresh temp home, and the answer is what the shell would get from
`load_policy(home)` and `classify_argv([probe], policy)`.

Prints {id: {"modes": {probe: mode}, "native": [...], "pty": [...]}}.
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
    home = tempfile.mkdtemp(prefix="redlog-class-")
    try:
        if case["file"] is not None:
            os.makedirs(os.path.join(home, ".redlog"))
            with open(os.path.join(home, ".redlog", "command-class.json"), "w") as fh:
                fh.write(case["file"])
        policy = relay.load_policy(home)
        out[case["id"]] = {
            "modes": {p: relay.classify_argv([p], policy) for p in case["probes"]},
            "native": policy["native"],
            "pty": policy["pty"],
        }
    finally:
        shutil.rmtree(home, ignore_errors=True)

sys.stdout.write(json.dumps(out))
