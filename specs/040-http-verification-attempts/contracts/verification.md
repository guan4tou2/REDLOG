# Existing event contract
Only scanner/http_response with exact test URL and integer status 100..599 matches.
http_request_start, other agents, missing status, old token and other URL do not.
Existing httpCapture.status() must report running with the same PID/listener as
attempt creation before the UI accepts a match. Stale promises cannot revive slots.
Copy never executes a command or navigates to the test URL.
