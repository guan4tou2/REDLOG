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
    - HTTP request:   method, URL, ALL headers, query params, FULL body,
                      timing breakdown (dns/connect/tls/ttfb), cookies,
                      HTTP version, HTTP/2 stream_id
    - HTTP response:  status code, ALL headers, FULL body, content type, size,
                      duration_ms, TLS version, server cert subject/issuer/SAN,
                      JA3 fingerprint, Set-Cookie details, HTTP/2 stream_id
    - WebSocket:      per-frame direction, text/binary, full payload
    - TCP stream:     raw bytes per message (text/binary), direction
    - TLS handshake:  SNI, TLS version, cipher, ALPN, cert subject/issuer/SAN,
                      JA3 hash + raw string
    - Cookie change:  session cookie rotation detection per domain
    - DNS query:      question name/type/id, transport, source_addr
    - DNS response:   response_code, answers, duration_ms, _causes ← query event

Environment variables:
    REDLOG_MAX_BODY       Max body bytes to capture (default 10485760 = 10 MB;
                          0 = unlimited). Bodies exceeding this are truncated
                          on the addon side. The API server may further extract
                          large bodies to sidecar files on disk.
    REDLOG_PREVIEW_BODY   Max body bytes for the inline preview field kept in
                          the event JSON for timeline display (default 4096).
    REDLOG_MAX_HEADERS    Max number of headers to capture per request/response
                          (default 200). Prevents pathological header sets from
                          bloating event JSON.
    REDLOG_SKIP_STATIC    Skip static assets like .css/.js/.png/.woff
                          (default false — Burp-like full capture by default)
    REDLOG_VERBOSE        Log every request/DNS message to stderr (default false)
"""

import base64
import hashlib
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

from mitmproxy import http, tcp, tls, ctx


REDLOG_PORT_FILE = Path.home() / ".redlog" / "api-port"
REDLOG_TOKEN_FILE = Path.home() / ".redlog" / "api-token"
SPOOL_DIR = Path.home() / ".redlog" / "pending"

MAX_BODY = int(os.environ.get("REDLOG_MAX_BODY", "10485760"))
PREVIEW_BODY = int(os.environ.get("REDLOG_PREVIEW_BODY", "4096"))
MAX_HEADERS = int(os.environ.get("REDLOG_MAX_HEADERS", "200"))
SKIP_STATIC = os.environ.get("REDLOG_SKIP_STATIC", "false").lower() in ("true", "1", "yes")
VERBOSE = os.environ.get("REDLOG_VERBOSE", "false").lower() in ("true", "1", "yes")

STATIC_EXTENSIONS = {
    ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
    ".woff", ".woff2", ".ttf", ".eot", ".map", ".webp", ".avif",
}

TEXT_CONTENT_TYPES = (
    "json", "html", "text", "xml", "javascript", "css", "csv",
    "yaml", "yml", "svg", "urlencoded", "form-data",
    "application/x-www-form-urlencoded",
)


def _get_redlog_connection():
    if not REDLOG_PORT_FILE.exists() or not REDLOG_TOKEN_FILE.exists():
        return None, None
    port = REDLOG_PORT_FILE.read_text().strip()
    token = REDLOG_TOKEN_FILE.read_text().strip()
    return port, token


def _spool_payload(payload: dict):
    """Write a payload to the spool directory for later replay."""
    try:
        SPOOL_DIR.mkdir(parents=True, exist_ok=True)
        filename = f"{int(time.time() * 1000)}-{id(payload)}.json"
        (SPOOL_DIR / filename).write_text(json.dumps(payload), encoding="utf-8")
    except Exception:
        pass


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
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            _spool_payload(payload)

    threading.Thread(target=_do_send, daemon=True).start()


def _send_to_redlog_and_get_id(payload: dict):
    """Synchronous variant returning the inserted event id.

    Used by the DNS-query path so the response event can point its `_causes`
    at the exact query event. Blocks briefly (≤5s) on the RedLog API — the
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
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        obj = json.loads(body)
        return obj.get("id") or (obj.get("event") or {}).get("id")
    except Exception:
        _spool_payload(payload)
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


def _truncate(s: str, max_len: int) -> str:
    if len(s) <= max_len:
        return s
    return s[:max_len] + f"...[truncated, {len(s)} total]"


def _is_text_content(content_type: str) -> bool:
    ct = content_type.lower()
    return any(t in ct for t in TEXT_CONTENT_TYPES)


def _capture_body(content: bytes | None, content_type: str, max_bytes: int) -> dict | None:
    """Capture a request or response body. Returns a dict with the body data,
    encoding info, and sha256, or None if no body.

    Shape: {
        "data": str,           # text content or base64-encoded binary
        "encoding": str,       # "text" or "base64"
        "size": int,           # original byte count
        "sha256": str,         # hex digest of the stored bytes (post-truncation)
        "truncated": bool,     # whether data was cut short
        "content_type": str,   # as reported by the server/client
    }
    """
    if not content or len(content) == 0:
        return None

    raw_size = len(content)
    truncated = False

    if max_bytes > 0 and raw_size > max_bytes:
        content = content[:max_bytes]
        truncated = True

    sha256 = hashlib.sha256(content).hexdigest()

    is_text = _is_text_content(content_type)

    if is_text:
        try:
            text = content.decode("utf-8", errors="replace")
            return {
                "data": text,
                "encoding": "text",
                "size": raw_size,
                "sha256": sha256,
                "truncated": truncated,
                "content_type": content_type,
            }
        except Exception:
            pass

    b64 = base64.b64encode(content).decode("ascii")
    return {
        "data": b64,
        "encoding": "base64",
        "size": raw_size,
        "sha256": sha256,
        "truncated": truncated,
        "content_type": content_type,
    }


def _extract_all_headers(headers) -> list[list[str]]:
    """Capture ALL headers as an ordered list of [name, value] pairs.
    Preserves duplicate headers (e.g. multiple Set-Cookie) and original
    casing — exactly what Burp shows. Capped at MAX_HEADERS."""
    result = []
    for name, value in headers.items(multi=True):
        if len(result) >= MAX_HEADERS:
            result.append(["X-RedLog-Truncated", f"{len(list(headers.items(multi=True)))} total, showing {MAX_HEADERS}"])
            break
        result.append([name, value])
    return result


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
                params["body_raw"] = _truncate(body_text, PREVIEW_BODY)
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
                params["body_raw"] = _truncate(body_text, PREVIEW_BODY)

    return params


def _is_static(url: str) -> bool:
    parsed = urlparse(url)
    path = parsed.path.lower()
    return any(path.endswith(ext) for ext in STATIC_EXTENSIONS)


def _compute_ja3(client_hello: tls.ClientHelloData) -> dict | None:
    """Compute JA3 fingerprint from a TLS ClientHello.

    JA3 format: TLSVersion,Ciphers,Extensions,EllipticCurves,ECPointFormats
    Each field is a dash-separated list of decimal values.
    The JA3 hash is the MD5 of the resulting string.
    """
    try:
        ch = client_hello.context
        if not ch:
            return None

        tls_version = getattr(ch, 'tls_version', None)
        cipher_suites = getattr(ch, 'cipher_suites', None) or []
        extensions = getattr(ch, 'extensions', None) or {}
        ec_curves = getattr(ch, 'elliptic_curves', None) or []
        ec_point_formats = getattr(ch, 'ec_point_formats', None) or []

        grease_values = {
            0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a, 0x5a5a,
            0x6a6a, 0x7a7a, 0x8a8a, 0x9a9a, 0xaaaa, 0xbaba,
            0xcaca, 0xdada, 0xeaea, 0xfafa,
        }

        ciphers_clean = [c for c in cipher_suites if c not in grease_values]
        ext_clean = sorted(e for e in extensions if e not in grease_values)
        curves_clean = [c for c in ec_curves if c not in grease_values]
        points_clean = list(ec_point_formats)

        ver_str = str(tls_version) if tls_version else "0"
        ja3_raw = ",".join([
            ver_str,
            "-".join(str(c) for c in ciphers_clean),
            "-".join(str(e) for e in ext_clean),
            "-".join(str(c) for c in curves_clean),
            "-".join(str(p) for p in points_clean),
        ])

        ja3_hash = hashlib.md5(ja3_raw.encode()).hexdigest()
        return {
            "ja3": ja3_hash,
            "ja3_raw": ja3_raw[:500],
        }
    except Exception:
        return None


def _extract_tls_info(flow: http.HTTPFlow) -> dict | None:
    """Extract TLS handshake details from a completed flow."""
    try:
        conn = flow.server_conn
        if not conn or not getattr(conn, 'tls_version', None):
            return None
        info: dict = {
            "tls_version": conn.tls_version,
        }
        if hasattr(conn, 'alpn') and conn.alpn:
            info["alpn"] = conn.alpn.decode("ascii", errors="replace") if isinstance(conn.alpn, bytes) else str(conn.alpn)
        if hasattr(conn, 'cipher') and conn.cipher:
            info["cipher"] = conn.cipher
        cert_list = getattr(conn, 'certificate_list', None)
        if cert_list and len(cert_list) > 0:
            leaf = cert_list[0]
            info["cert_subject"] = str(getattr(leaf, 'subject', ''))
            info["cert_issuer"] = str(getattr(leaf, 'issuer', ''))
            san = getattr(leaf, 'altnames', None) or getattr(leaf, 'san', None)
            if san:
                info["cert_san"] = list(san)[:20]
            serial = getattr(leaf, 'serial', None)
            if serial is not None:
                info["cert_serial"] = str(serial)
        return info
    except Exception:
        return None


def _extract_timing(flow: http.HTTPFlow) -> dict | None:
    """Extract timing breakdown from a completed flow (ms precision)."""
    try:
        sc = flow.server_conn
        if not sc:
            return None
        timing: dict = {}
        ts_start = getattr(sc, 'timestamp_start', None)
        ts_tcp = getattr(sc, 'timestamp_tcp_setup', None)
        ts_tls = getattr(sc, 'timestamp_tls_setup', None)
        req_start = getattr(flow.request, 'timestamp_start', None)
        req_end = getattr(flow.request, 'timestamp_end', None)
        resp_start = getattr(flow.response, 'timestamp_start', None) if flow.response else None
        resp_end = getattr(flow.response, 'timestamp_end', None) if flow.response else None
        if ts_start and ts_tcp:
            timing["connect_ms"] = round((ts_tcp - ts_start) * 1000)
        if ts_tcp and ts_tls:
            timing["tls_ms"] = round((ts_tls - ts_tcp) * 1000)
        if req_start and req_end:
            timing["send_ms"] = round((req_end - req_start) * 1000)
        if req_end and resp_start:
            timing["wait_ms"] = round((resp_start - req_end) * 1000)
        if resp_start and resp_end:
            timing["receive_ms"] = round((resp_end - resp_start) * 1000)
        if ts_start and resp_end:
            timing["total_ms"] = round((resp_end - ts_start) * 1000)
        return timing if timing else None
    except Exception:
        return None


def _extract_request_cookies(flow: http.HTTPFlow) -> list[dict] | None:
    """Extract cookies sent in the request's Cookie header."""
    try:
        cookie_header = flow.request.headers.get("cookie", "")
        if not cookie_header:
            return None
        cookies = []
        for pair in cookie_header.split(";"):
            pair = pair.strip()
            if "=" in pair:
                name, _, value = pair.partition("=")
                cookies.append({"name": name.strip(), "value": value.strip()[:200]})
        return cookies[:50] if cookies else None
    except Exception:
        return None


def _extract_set_cookies(flow: http.HTTPFlow) -> list[dict] | None:
    """Extract Set-Cookie headers from the response."""
    try:
        if not flow.response:
            return None
        set_cookies = []
        for value in flow.response.headers.get_all("set-cookie"):
            parts = value.split(";")
            main = parts[0].strip()
            name, _, val = main.partition("=")
            attrs: dict = {"name": name.strip(), "value": val.strip()[:200]}
            for attr in parts[1:]:
                attr = attr.strip().lower()
                if attr.startswith("path="):
                    attrs["path"] = attr[5:]
                elif attr.startswith("domain="):
                    attrs["domain"] = attr[7:]
                elif attr.startswith("expires="):
                    attrs["expires"] = attr[8:]
                elif attr.startswith("max-age="):
                    attrs["max_age"] = attr[8:]
                elif attr == "secure":
                    attrs["secure"] = True
                elif attr == "httponly":
                    attrs["httponly"] = True
                elif attr.startswith("samesite="):
                    attrs["samesite"] = attr[9:]
            set_cookies.append(attrs)
        return set_cookies[:50] if set_cookies else None
    except Exception:
        return None


PENDING_TTL_SEC = 300


class RedLogAddon:
    def __init__(self):
        self._request_times: dict[str, dict] = {}
        self._dns_query_events: dict[str, dict] = {}
        self._ja3_cache: dict[str, dict] = {}
        self._cookie_jar: dict[str, dict[str, str]] = {}

    def _track_cookies(self, domain: str, set_cookies: list[dict]):
        """Track Set-Cookie headers in memory. When a session-like cookie
        changes value, emit a cookie_change event so the operator knows
        a session was established or rotated."""
        if domain not in self._cookie_jar:
            self._cookie_jar[domain] = {}

        session_names = {"session", "sessionid", "sid", "jsessionid", "phpsessid",
                         "connect.sid", "asp.net_sessionid", "laravel_session",
                         "token", "auth", "jwt", "access_token", "csrf", "_csrf_token"}

        for cookie in set_cookies:
            name = cookie.get("name", "")
            value = cookie.get("value", "")
            name_lower = name.lower()
            prev = self._cookie_jar[domain].get(name)
            self._cookie_jar[domain][name] = value

            if prev is not None and prev != value and name_lower in session_names:
                _send_to_redlog({
                    "agent_type": "scanner",
                    "data": {
                        "subtype": "cookie_change",
                        "domain": domain,
                        "cookie_name": name,
                        "old_hash": hashlib.sha256(prev.encode()).hexdigest()[:16],
                        "new_hash": hashlib.sha256(value.encode()).hexdigest()[:16],
                        "secure": cookie.get("secure", False),
                        "httponly": cookie.get("httponly", False),
                    },
                    "target_id": domain,
                })

        if len(self._cookie_jar) > 500:
            oldest_domains = list(self._cookie_jar.keys())[:100]
            for d in oldest_domains:
                self._cookie_jar.pop(d, None)

    def _sweep_stale(self):
        """Emit dropped-markers for pending requests older than PENDING_TTL_SEC."""
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

        stale_dns = [
            fid for fid, meta in self._dns_query_events.items()
            if now - meta["at"] > PENDING_TTL_SEC
        ]
        for fid in stale_dns:
            self._dns_query_events.pop(fid, None)

    def request(self, flow: http.HTTPFlow):
        self._sweep_stale()

        url = flow.request.pretty_url
        method = flow.request.method

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
        req_headers = _extract_all_headers(flow.request.headers)

        content_type = flow.request.headers.get("content-type", "")
        request_body = None
        request_body_preview = ""
        try:
            request_body = _capture_body(flow.request.content, content_type, MAX_BODY)
            if request_body and request_body["encoding"] == "text":
                request_body_preview = _truncate(request_body["data"], PREVIEW_BODY)
        except Exception as exc:
            if VERBOSE:
                ctx.log.warn(f"[redlog] req body decode failed for {url}: {exc}")

        event_data = {
            "subtype": "http_request_start",
            "flow_id": flow.id,
            "method": method,
            "url": url,
            "path": path,
            "host": target,
            "port": parsed.port or (443 if parsed.scheme == "https" else 80),
            "scheme": parsed.scheme,
            "request_headers": req_headers,
        }

        if params:
            event_data["params"] = params
        if request_body_preview:
            event_data["request_body_preview"] = request_body_preview
        if request_body:
            event_data["request_body"] = request_body

        http_version = getattr(flow.request, 'http_version', None)
        if http_version:
            event_data["http_version"] = http_version
        stream_id = getattr(flow.request, 'stream_id', None)
        if stream_id is not None:
            event_data["stream_id"] = stream_id

        req_cookies = _extract_request_cookies(flow)
        if req_cookies:
            event_data["cookies"] = req_cookies

        payload = {
            "agent_type": "scanner",
            "data": event_data,
            "target_id": target,
        }

        _send_to_redlog(payload)

        if VERBOSE:
            body_info = f" ({request_body['size']}B)" if request_body else ""
            ctx.log.info(f"[redlog] → {method} {url}{body_info}")

    def response(self, flow: http.HTTPFlow):
        self._sweep_stale()

        url = flow.request.pretty_url

        if SKIP_STATIC and _is_static(url):
            self._request_times.pop(flow.id, None)
            return

        parsed = urlparse(url)
        target = parsed.hostname or ""
        method = flow.request.method
        status = flow.response.status_code if flow.response else 0

        meta = self._request_times.pop(flow.id, None)
        start_time = meta["at"] if meta else None
        duration_ms = int((time.time() - start_time) * 1000) if start_time else None

        resp_headers = _extract_all_headers(flow.response.headers) if flow.response else []

        content_type = flow.response.headers.get("content-type", "") if flow.response else ""
        response_body = None
        response_body_preview = ""
        content_length = 0
        try:
            resp_content = flow.response.content if flow.response else None
            response_body = _capture_body(resp_content, content_type, MAX_BODY)
            if response_body and response_body["encoding"] == "text":
                response_body_preview = _truncate(response_body["data"], PREVIEW_BODY)
            if resp_content:
                content_length = len(resp_content)
        except Exception as exc:
            content_length = int(flow.response.headers.get("content-length", "0") or "0") if flow.response else 0
            if VERBOSE:
                ctx.log.warn(f"[redlog] body decode failed for {url}: {exc}")

        event_data = {
            "subtype": "http_response",
            "flow_id": flow.id,
            "method": method,
            "url": url,
            "status": status,
            "content_length": content_length,
            "content_type": content_type,
            "response_headers": resp_headers,
        }

        if response_body_preview:
            event_data["response_preview"] = response_body_preview
        if response_body:
            event_data["response_body"] = response_body
        if duration_ms is not None:
            event_data["duration_ms"] = duration_ms

        tls_info = _extract_tls_info(flow)
        if tls_info:
            event_data["tls"] = tls_info
        timing = _extract_timing(flow)
        if timing:
            event_data["timing"] = timing

        ja3 = self._get_ja3_for_flow(flow)
        if ja3:
            if "tls" not in event_data:
                event_data["tls"] = {}
            event_data["tls"]["ja3"] = ja3["ja3"]
            event_data["tls"]["ja3_raw"] = ja3["ja3_raw"]

        http_version = getattr(flow.request, 'http_version', None)
        if http_version:
            event_data["http_version"] = http_version
        stream_id = getattr(flow.request, 'stream_id', None)
        if stream_id is not None:
            event_data["stream_id"] = stream_id

        set_cookies = _extract_set_cookies(flow)
        if set_cookies:
            event_data["set_cookies"] = set_cookies
            self._track_cookies(target, set_cookies)

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

    def dns_message(self, flow):  # type: (Any) -> None  (mitmproxy.dns.DNSFlow)
        try:
            request = flow.request
        except AttributeError:
            return
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

    # ─── WebSocket capture ────────────────────────────────────────────────

    def websocket_message(self, flow: http.HTTPFlow):
        assert flow.websocket is not None
        msg = flow.websocket.messages[-1]

        url = flow.request.pretty_url
        parsed = urlparse(url)
        target = parsed.hostname or ""

        direction = "client" if msg.from_client else "server"
        is_text = msg.type == 1
        content = msg.content

        raw_size = len(content) if content else 0
        ws_body = None
        ws_preview = ""

        if content and raw_size > 0:
            ws_body = _capture_body(content, "text/plain" if is_text else "application/octet-stream", MAX_BODY)
            if ws_body and ws_body["encoding"] == "text":
                ws_preview = _truncate(ws_body["data"], PREVIEW_BODY)

        event_data = {
            "subtype": "ws_message",
            "flow_id": flow.id,
            "url": url,
            "host": target,
            "direction": direction,
            "message_type": "text" if is_text else "binary",
            "size": raw_size,
            "message_count": len(flow.websocket.messages),
        }

        if ws_preview:
            event_data["ws_preview"] = ws_preview
        if ws_body:
            event_data["ws_body"] = ws_body

        payload = {
            "agent_type": "scanner",
            "data": event_data,
            "target_id": target,
        }
        _send_to_redlog(payload)

        if VERBOSE:
            arrow = "▲" if msg.from_client else "▼"
            ctx.log.info(
                f"[redlog] WS {arrow} {url} "
                f"({raw_size}B {'text' if is_text else 'bin'}, "
                f"#{len(flow.websocket.messages)})"
            )

    # ─── TCP stream capture ───────────────────────────────────────────────

    def tcp_message(self, flow: tcp.TCPFlow):
        msg = flow.messages[-1]
        direction = "client" if msg.from_client else "server"
        content = msg.content
        raw_size = len(content) if content else 0

        target = ""
        port = 0
        try:
            addr = flow.server_conn.peername or flow.server_conn.address
            if addr:
                target = addr[0] if isinstance(addr, tuple) else str(addr)
                port = addr[1] if isinstance(addr, tuple) and len(addr) > 1 else 0
        except Exception:
            pass

        tcp_body = None
        tcp_preview = ""
        if content and raw_size > 0:
            tcp_body = _capture_body(content, "application/octet-stream", MAX_BODY)
            if tcp_body and tcp_body["encoding"] == "text":
                tcp_preview = _truncate(tcp_body["data"], PREVIEW_BODY)
            elif tcp_body:
                tcp_preview = f"[binary, {raw_size} bytes]"

        event_data = {
            "subtype": "tcp_message",
            "flow_id": flow.id,
            "direction": direction,
            "size": raw_size,
            "host": target,
            "port": port,
            "message_count": len(flow.messages),
        }

        if tcp_preview:
            event_data["tcp_preview"] = tcp_preview
        if tcp_body:
            event_data["tcp_body"] = tcp_body

        tls_version = getattr(flow.server_conn, 'tls_version', None)
        if tls_version:
            event_data["tls_version"] = tls_version

        payload = {
            "agent_type": "scanner",
            "data": event_data,
            "target_id": target,
        }
        _send_to_redlog(payload)

        if VERBOSE:
            arrow = "▲" if msg.from_client else "▼"
            ctx.log.info(f"[redlog] TCP {arrow} {target}:{port} ({raw_size}B, #{len(flow.messages)})")

    # ─── TLS ClientHello capture (JA3 fingerprint) ────────────────────────

    def tls_clienthello(self, data: tls.ClientHelloData):
        """Cache JA3 fingerprint from the TLS ClientHello for later attachment
        to the HTTP response event. The ClientHello fires before any HTTP
        hooks, so we stash by client address and look it up in response()."""
        try:
            ja3 = _compute_ja3(data)
            if ja3:
                conn = data.context.client
                key = f"{conn.peername[0]}:{conn.peername[1]}" if hasattr(conn, 'peername') and conn.peername else ""
                if key:
                    self._ja3_cache[key] = ja3
                    if len(self._ja3_cache) > 5000:
                        oldest = list(self._ja3_cache.keys())[:1000]
                        for k in oldest:
                            self._ja3_cache.pop(k, None)
        except Exception:
            pass

    def _get_ja3_for_flow(self, flow: http.HTTPFlow) -> dict | None:
        """Look up cached JA3 fingerprint for a flow's client connection."""
        try:
            client = flow.client_conn
            if client and hasattr(client, 'peername') and client.peername:
                key = f"{client.peername[0]}:{client.peername[1]}"
                return self._ja3_cache.get(key)
        except Exception:
            pass
        return None

    def error(self, flow: http.HTTPFlow):
        url = flow.request.pretty_url
        parsed = urlparse(url)

        meta = self._request_times.pop(flow.id, None)
        start_time = meta["at"] if meta else None
        duration_ms = int((time.time() - start_time) * 1000) if start_time else None

        req_headers = _extract_all_headers(flow.request.headers)

        event_data = {
            "subtype": "http_error",
            "flow_id": flow.id,
            "method": flow.request.method,
            "url": url,
            "host": parsed.hostname or "",
            "error": str(flow.error) if flow.error else "unknown",
            "request_headers": req_headers,
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
