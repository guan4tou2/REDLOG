"""
RedLog × mitmproxy Addon
Captures HTTP requests + DNS queries flowing through mitmproxy and sends
them to RedLog's timeline.

Usage — HTTP capture (default proxy mode):
    mitmproxy -s /path/to/redlog/hooks/mitmproxy-addon.py
    mitmweb  -s /path/to/redlog/hooks/mitmproxy-addon.py
    mitmdump -s /path/to/redlog/hooks/mitmproxy-addon.py

Usage — DNS capture (mitmproxy's DNS mode, v0.6.92):
    mitmproxy --mode dns@53 -s /path/to/redlog/hooks/mitmproxy-addon.py
    mitmdump  --mode dns@5353 -s /path/to/redlog/hooks/mitmproxy-addon.py

    Port 53 requires root/sudo on Unix. Non-privileged ports (e.g. 5353) work
    for lab traffic — point the target at 127.0.0.1:5353 with `dig @127.0.0.1
    -p 5353 example.com` or configure a system resolver override.

    The HTTP `request/response/error` handlers and the DNS `dns_message`
    handler coexist in the same addon; mitmproxy dispatches whichever fires
    for the active mode. Running two mitmproxy instances (one HTTP, one DNS)
    with the same addon is the recommended setup for full coverage.

What gets logged:
    - HTTP request: method, URL, headers, query params, body (truncated)
    - HTTP response: status code, content type, size, duration_ms
    - DNS query:     question name/type/id, transport, source_addr
    - DNS response:  response_code, answers, duration_ms, _causes ← query event

Environment variables:
    REDLOG_MAX_BODY    Max request/response body bytes to capture (default 16384)
    REDLOG_SKIP_STATIC Skip static assets like .css/.js/.png/.woff (default true)
    REDLOG_VERBOSE     Log every request/DNS message to stderr (default false)
"""

import json
import os
import time
import threading
from pathlib import Path
from urllib.parse import urlparse, parse_qs

try:
    import urllib.request
except ImportError:
    pass

from mitmproxy import http, ctx


REDLOG_PORT_FILE = Path.home() / ".redlog" / "api-port"
REDLOG_TOKEN_FILE = Path.home() / ".redlog" / "api-token"

# 16 KB by default (was 2 KB) — enough to review a typical JSON/form request or
# response body without truncation. Bodies still live inline on the event (no
# sidecar yet), so this trades a little DB size for actually-reviewable payloads.
MAX_BODY = int(os.environ.get("REDLOG_MAX_BODY", "16384"))
SKIP_STATIC = os.environ.get("REDLOG_SKIP_STATIC", "true").lower() in ("true", "1", "yes")
VERBOSE = os.environ.get("REDLOG_VERBOSE", "false").lower() in ("true", "1", "yes")

STATIC_EXTENSIONS = {
    ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
    ".woff", ".woff2", ".ttf", ".eot", ".map", ".webp", ".avif",
}

SENSITIVE_HEADERS = {
    "cookie", "set-cookie", "authorization", "x-api-key",
    "x-csrf-token", "x-xsrf-token",
}


def _get_redlog_connection():
    if not REDLOG_PORT_FILE.exists() or not REDLOG_TOKEN_FILE.exists():
        return None, None
    port = REDLOG_PORT_FILE.read_text().strip()
    token = REDLOG_TOKEN_FILE.read_text().strip()
    return port, token


def _send_to_redlog(payload: dict):
    port, token = _get_redlog_connection()
    if not port:
        return

    def _do_send():
        try:
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/events",
                data=data,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            urllib.request.urlopen(req, timeout=2)
        except Exception:
            pass

    threading.Thread(target=_do_send, daemon=True).start()


def _send_to_redlog_and_get_id(payload: dict):
    """Synchronous variant returning the inserted event id.

    Used by the DNS-query path so the response event can point its `_causes`
    at the exact query event. Blocks briefly (≤2s) on the RedLog API — the
    DNS response typically arrives 10-100ms later so we still want the id.
    Returns None on any error; the response then emits an empty _causes list
    rather than dropping the row.
    """
    port, token = _get_redlog_connection()
    if not port:
        return None
    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/events",
            data=data,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        obj = json.loads(body)
        return obj.get("id") or (obj.get("event") or {}).get("id")
    except Exception:
        return None


# Numeric ↔ mnemonic maps for the DNS handler. Covers the codes any modern
# resolver actually returns; anything exotic falls through to str(n) so the
# event is still filterable in the Timeline instead of silently going blank.
_DNS_TYPES = {
    1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR", 13: "HINFO",
    15: "MX", 16: "TXT", 17: "RP", 18: "AFSDB", 24: "SIG", 25: "KEY",
    28: "AAAA", 29: "LOC", 33: "SRV", 35: "NAPTR", 36: "KX", 37: "CERT",
    39: "DNAME", 41: "OPT", 43: "DS", 44: "SSHFP", 45: "IPSECKEY",
    46: "RRSIG", 47: "NSEC", 48: "DNSKEY", 49: "DHCID", 50: "NSEC3",
    51: "NSEC3PARAM", 52: "TLSA", 53: "SMIMEA", 55: "HIP", 59: "CDS",
    60: "CDNSKEY", 61: "OPENPGPKEY", 62: "CSYNC", 63: "ZONEMD",
    64: "SVCB", 65: "HTTPS", 99: "SPF", 108: "EUI48", 109: "EUI64",
    249: "TKEY", 250: "TSIG", 251: "IXFR", 252: "AXFR",
    255: "ANY", 256: "URI", 257: "CAA",
}

_DNS_RCODES = {
    0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN",
    4: "NOTIMP", 5: "REFUSED", 6: "YXDOMAIN", 7: "YXRRSET",
    8: "NXRRSET", 9: "NOTAUTH", 10: "NOTZONE", 11: "DSOTYPENI",
    16: "BADVERS", 17: "BADKEY", 18: "BADTIME", 19: "BADMODE",
    20: "BADNAME", 21: "BADALG", 22: "BADTRUNC", 23: "BADCOOKIE",
}


def _dns_type_name(n) -> str:
    """Map a numeric DNS RR type to its mnemonic (A / AAAA / …). Also accepts
    already-mnemonic strings + enum-like objects with a `.name`."""
    if isinstance(n, str) and n:
        return n
    name = getattr(n, "name", None)
    if isinstance(name, str) and name:
        return name
    try:
        return _DNS_TYPES.get(int(n), str(n))
    except Exception:
        return str(n) if n is not None else ""


def _dns_rcode_name(n) -> str:
    """Map a numeric DNS response code (rcode) to its mnemonic."""
    if isinstance(n, str) and n:
        return n
    name = getattr(n, "name", None)
    if isinstance(name, str) and name:
        return name
    try:
        return _DNS_RCODES.get(int(n), str(n))
    except Exception:
        return str(n) if n is not None else ""


def _truncate(s: str, max_len: int = MAX_BODY) -> str:
    if len(s) <= max_len:
        return s
    return s[:max_len] + f"...[truncated, {len(s)} total]"


def _extract_params(flow: http.HTTPFlow) -> dict:
    params = {}
    parsed = urlparse(flow.request.pretty_url)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if query:
        params["query"] = {k: v[0] if len(v) == 1 else v for k, v in query.items()}

    content_type = flow.request.headers.get("content-type", "")

    if flow.request.content:
        body_text = flow.request.get_text(strict=False) or ""
        if "application/json" in content_type:
            try:
                params["body_json"] = json.loads(body_text)
            except (json.JSONDecodeError, ValueError):
                params["body_raw"] = _truncate(body_text)
        elif "application/x-www-form-urlencoded" in content_type:
            form_data = parse_qs(body_text, keep_blank_values=True)
            params["body_form"] = {
                k: v[0] if len(v) == 1 else v for k, v in form_data.items()
            }
        elif "multipart/form-data" in content_type:
            multipart = flow.request.multipart_form
            if multipart:
                params["body_multipart"] = {
                    k.decode("utf-8", errors="replace"): (
                        f"[file, {len(v)} bytes]" if len(v) > 256
                        else v.decode("utf-8", errors="replace")
                    )
                    for k, v in multipart.items()
                }
        else:
            if len(body_text) > 0:
                params["body_raw"] = _truncate(body_text)

    return params


def _extract_interesting_headers(headers, direction: str = "request") -> dict:
    result = {}
    for name, value in headers.items(multi=True):
        lower = name.lower()
        if lower in SENSITIVE_HEADERS:
            result[name] = _truncate(value, 200)
        elif direction == "response" and lower in (
            "content-type", "x-powered-by", "server",
            "x-frame-options", "content-security-policy",
            "access-control-allow-origin", "location",
            "www-authenticate",
        ):
            result[name] = _truncate(value, 200)
        elif direction == "request" and lower in (
            "content-type", "origin", "referer", "user-agent",
            "x-forwarded-for", "x-real-ip",
        ):
            result[name] = _truncate(value, 200)
    return result


def _is_static(url: str) -> bool:
    parsed = urlparse(url)
    path = parsed.path.lower()
    return any(path.endswith(ext) for ext in STATIC_EXTENSIONS)


# A pending request whose response/error never arrived is orphaned in
# `_request_times` and would leak forever. When more than this many seconds
# have elapsed since the request went out, sweep it and emit a
# `http_request_dropped` marker so the audit log still reflects that we sent
# it. Sweeping happens inline at the top of `request`/`response` (both run in
# mitmproxy's event loop), so no background thread is needed.
PENDING_TTL_SEC = 300


REQUEST_BODY_CONTENT_TYPES = (
    "application/json",
    "application/xml",
    "application/x-www-form-urlencoded",
    "text/",
    "html",
    "xml",
)


class RedLogAddon:
    def __init__(self):
        # flow.id -> {'at': float, 'method': str, 'url': str}
        # `at` is the wall-clock time we saw the request; `method`/`url` are
        # stashed so a TTL sweep can emit a meaningful dropped-marker without
        # having the original flow object anymore.
        self._request_times: dict[str, dict] = {}
        # DNS query flow.id -> {'at': float, 'event_id': str|None}
        # Analogous to _request_times but for DNS mode. `event_id` is stashed
        # after the query POST so the response can name it in `_causes`.
        self._dns_query_events: dict[str, dict] = {}

    def _sweep_stale(self):
        """Emit dropped-markers for pending requests older than PENDING_TTL_SEC.

        Called inline at the top of `request` and `response` — no background
        thread. Cheap: dict.items() over what should normally be a small map.
        """
        now = time.time()
        stale_ids = [
            fid for fid, meta in self._request_times.items()
            if now - meta["at"] > PENDING_TTL_SEC
        ]
        for fid in stale_ids:
            meta = self._request_times.pop(fid, None)
            if not meta:
                continue
            age_sec = int(now - meta["at"])
            url = meta.get("url", "")
            parsed = urlparse(url)
            payload = {
                "agent_type": "scanner",
                "data": {
                    "subtype": "http_request_dropped",
                    "flow_id": fid,
                    "method": meta.get("method", ""),
                    "url": url,
                    "age_sec": age_sec,
                },
                "target_id": parsed.hostname or "",
            }
            _send_to_redlog(payload)
            if VERBOSE:
                ctx.log.info(
                    f"[redlog] dropped {meta.get('method', '')} {url} "
                    f"(age {age_sec}s, no response/error)"
                )

    def request(self, flow: http.HTTPFlow):
        self._sweep_stale()

        url = flow.request.pretty_url
        method = flow.request.method

        # Track the flow so response/error can compute duration and so the TTL
        # sweep can identify the request by method+url if it's orphaned.
        self._request_times[flow.id] = {
            "at": time.time(),
            "method": method,
            "url": url,
        }

        if SKIP_STATIC and _is_static(url):
            return

        parsed = urlparse(url)
        target = parsed.hostname or ""
        path = parsed.path

        params = _extract_params(flow)
        req_headers = _extract_interesting_headers(flow.request.headers, "request")

        request_body_preview = ""
        content_type = flow.request.headers.get("content-type", "")
        if flow.request.content and any(t in content_type for t in REQUEST_BODY_CONTENT_TYPES):
            req_text = flow.request.get_text(strict=False) or ""
            request_body_preview = _truncate(req_text, MAX_BODY)

        event_data = {
            "subtype": "http_request_start",
            "flow_id": flow.id,
            "method": method,
            "url": url,
            "path": path,
            "host": target,
            "port": parsed.port or (443 if parsed.scheme == "https" else 80),
            "scheme": parsed.scheme,
        }

        if params:
            event_data["params"] = params
        if req_headers:
            event_data["request_headers"] = req_headers
        if request_body_preview:
            event_data["request_body_preview"] = request_body_preview

        payload = {
            "agent_type": "scanner",
            "data": event_data,
            "target_id": target,
        }

        _send_to_redlog(payload)

        if VERBOSE:
            ctx.log.info(f"[redlog] → {method} {url}")

    def response(self, flow: http.HTTPFlow):
        self._sweep_stale()

        url = flow.request.pretty_url

        if SKIP_STATIC and _is_static(url):
            # Still pop the map entry so it doesn't count as a leak.
            self._request_times.pop(flow.id, None)
            return

        parsed = urlparse(url)
        target = parsed.hostname or ""
        method = flow.request.method
        status = flow.response.status_code if flow.response else 0

        meta = self._request_times.pop(flow.id, None)
        start_time = meta["at"] if meta else None
        duration_ms = int((time.time() - start_time) * 1000) if start_time else None

        resp_headers = _extract_interesting_headers(flow.response.headers, "response") if flow.response else {}

        response_body_preview = ""
        if flow.response and flow.response.content:
            content_type = flow.response.headers.get("content-type", "")
            if any(t in content_type for t in ("json", "html", "text", "xml", "javascript")):
                resp_text = flow.response.get_text(strict=False) or ""
                response_body_preview = _truncate(resp_text, MAX_BODY)

        content_length = 0
        if flow.response and flow.response.content:
            content_length = len(flow.response.content)

        event_data = {
            "subtype": "http_response",
            "flow_id": flow.id,
            # method + url are duplicated on the response so an orphan (start
            # event dropped/filtered) is still human-readable. Request-side
            # headers/params/body are NOT re-sent — they live on the start event.
            "method": method,
            "url": url,
            "status": status,
            "content_length": content_length,
            "content_type": (flow.response.headers.get("content-type", "") if flow.response else ""),
        }

        if resp_headers:
            event_data["response_headers"] = resp_headers
        if response_body_preview:
            event_data["response_preview"] = response_body_preview
        if duration_ms is not None:
            event_data["duration_ms"] = duration_ms

        payload = {
            "agent_type": "scanner",
            "data": event_data,
            "target_id": target,
        }

        _send_to_redlog(payload)

        if VERBOSE:
            ctx.log.info(
                f"[redlog] ← {method} {status} {url} "
                f"({content_length}B, {duration_ms}ms)"
            )

    # ─── DNS mode (mitmproxy --mode dns) ────────────────────────────────────
    #
    # `dns_message` fires for BOTH the incoming query and the outgoing
    # response — mitmproxy just gives us a DNSFlow whose `.request` is the
    # query and `.response` may be None (query phase) or the resolved answer.
    # We split into two RedLog events (query, response) so the audit trail
    # shows the roundtrip explicitly + a `_causes` link ties the response
    # back to its query event for causal-chain rendering (v0.6.89).
    #
    # `_query_events[flow.id]` = { 'at': float, 'event_id': str|None } mirrors
    # the HTTP `_request_times` map. The RedLog HTTP endpoint returns the
    # inserted event id in its JSON body so responses can point their
    # `_causes` at the exact query event; if the POST failed for any reason,
    # we still emit the response with an empty `_causes` list rather than
    # dropping the row.

    def dns_message(self, flow):  # type: (Any) -> None  (mitmproxy.dns.DNSFlow)
        try:
            request = flow.request
        except AttributeError:
            return
        # Distinguishing query from response: on first fire flow.response is
        # None; on the second, it's populated. mitmproxy calls this hook
        # once per direction so we mirror the two-event model.
        if getattr(flow, 'response', None) is None:
            self._dns_query(flow)
        else:
            self._dns_response(flow)

    def _dns_query(self, flow):
        try:
            question = flow.request.questions[0] if flow.request.questions else None
        except Exception:
            question = None
        query_name = getattr(question, 'name', '') if question else ''
        query_type = _dns_type_name(getattr(question, 'type', 0) if question else 0)
        source_addr = ''
        try:
            src = flow.client_conn.peername if flow.client_conn else None
            if src: source_addr = f"{src[0]}:{src[1]}"
        except Exception:
            pass
        transport = 'udp'
        try:
            # DoT / DoH surface as tcp/tls; mitmproxy's DNS mode only exposes
            # UDP + TCP today, but the field is here for forward-compat.
            if getattr(flow, 'client_conn', None) and getattr(flow.client_conn, 'transport_protocol', None):
                transport = str(flow.client_conn.transport_protocol)
        except Exception:
            pass
        event_data = {
            'subtype': 'dns_query',
            'query_name': query_name,
            'query_type': query_type,
            'query_id': getattr(flow.request, 'id', None),
            'transport': transport,
            'source_addr': source_addr,
            'flow_id': flow.id,
        }
        payload = {
            'agent_type': 'dns',
            'data': event_data,
            'target_id': query_name,
        }
        self._dns_query_events[flow.id] = {'at': time.time(), 'event_id': None}
        event_id = _send_to_redlog_and_get_id(payload)
        # store the id so the response can name it in _causes
        entry = self._dns_query_events.get(flow.id)
        if entry is not None:
            entry['event_id'] = event_id
        if VERBOSE:
            ctx.log.info(f"[redlog] DNS ⇒ {query_name} {query_type}")

    def _dns_response(self, flow):
        try:
            question = flow.request.questions[0] if flow.request.questions else None
        except Exception:
            question = None
        query_name = getattr(question, 'name', '') if question else ''
        query_type = _dns_type_name(getattr(question, 'type', 0) if question else 0)
        # response_code: mitmproxy exposes .response_code as int; helper maps
        # to human names (NOERROR, NXDOMAIN, SERVFAIL, …). Numeric fallback
        # if the map misses a rarer code (e.g. YXRRSET).
        rcode = getattr(flow.response, 'response_code', None)
        response_code = _dns_rcode_name(rcode) if rcode is not None else 'UNKNOWN'
        answers = []
        try:
            for ans in (flow.response.answers or []):
                answers.append({
                    'name': getattr(ans, 'name', ''),
                    'type': _dns_type_name(getattr(ans, 'type', 0)),
                    'ttl': getattr(ans, 'ttl', 0),
                    'data': str(getattr(ans, 'data', '') or ''),
                })
        except Exception:
            pass
        entry = self._dns_query_events.pop(flow.id, None)
        duration_ms = int((time.time() - entry['at']) * 1000) if entry else None
        causes = [entry['event_id']] if entry and entry.get('event_id') else []
        event_data = {
            'subtype': 'dns_response',
            'query_name': query_name,
            'query_type': query_type,
            'response_code': response_code,
            'answers': answers,
            'flow_id': flow.id,
        }
        if duration_ms is not None:
            event_data['duration_ms'] = duration_ms
        if causes:
            event_data['_causes'] = causes
        payload = {
            'agent_type': 'dns',
            'data': event_data,
            'target_id': query_name,
        }
        _send_to_redlog(payload)
        if VERBOSE:
            ans_preview = ', '.join(f"{a['type']} {a['data']}" for a in answers[:3]) or '(no answers)'
            ctx.log.info(
                f"[redlog] DNS ⇐ {query_name} {query_type} → {response_code} "
                f"[{ans_preview}] ({duration_ms}ms)"
            )

    def error(self, flow: http.HTTPFlow):
        url = flow.request.pretty_url
        parsed = urlparse(url)

        meta = self._request_times.pop(flow.id, None)
        start_time = meta["at"] if meta else None
        duration_ms = int((time.time() - start_time) * 1000) if start_time else None

        event_data = {
            "subtype": "http_error",
            "flow_id": flow.id,
            "method": flow.request.method,
            "url": url,
            "host": parsed.hostname or "",
            "error": str(flow.error) if flow.error else "unknown",
        }
        if duration_ms is not None:
            event_data["duration_ms"] = duration_ms

        payload = {
            "agent_type": "scanner",
            "data": event_data,
            "target_id": parsed.hostname or "",
        }
        _send_to_redlog(payload)

        if VERBOSE:
            ctx.log.info(
                f"[redlog] ✗ {flow.request.method} {url} "
                f"({event_data['error']}, {duration_ms}ms)"
            )


addons = [RedLogAddon()]
