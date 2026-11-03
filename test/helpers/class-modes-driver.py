"""What one installed set of hook files says about a list of commands.

usage: python3 class-modes-driver.py <input.json>

Used by test/hook-update-mixed-version.test.ts. The input is
{"sets": [{"id", "dir"}], "probes": [[argv...]]}: `dir` holds a
redlog-relay.py and the command-class.json it reads, which is how the relay
finds its policy in production (beside itself). The relay is loaded as a
module, the way test/helpers/class-policy-driver.py loads it, and asked what
the shell asks: load_policy(home) and classify_argv, plus the two lists
`redlog-relay.py policy --field` prints.

Nothing here knows about tool profiles. The relay under test may be from
before they existed, and load_policy and classify_argv are the two names that
have been in every version.

Prints {id: {"modes": {"argv joined by a space": mode}, "native": [...], "pty": [...]}}.
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile

with open(sys.argv[1], "r") as fh:
    request = json.load(fh)

out = {}
for number, entry in enumerate(request["sets"]):
    spec = importlib.util.spec_from_file_location("relay_%d" % number, os.path.join(entry["dir"], "redlog-relay.py"))
    relay = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(relay)
    home = tempfile.mkdtemp(prefix="redlog-modes-")  # no operator overlay
    try:
        policy = relay.load_policy(home)
        out[entry["id"]] = {
            "modes": {" ".join(argv): relay.classify_argv(argv, policy) for argv in request["probes"]},
            "native": policy["native"],
            "pty": policy["pty"],
        }
    finally:
        shutil.rmtree(home, ignore_errors=True)

sys.stdout.write(json.dumps(out))
