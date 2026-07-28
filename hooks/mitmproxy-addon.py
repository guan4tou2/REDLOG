"""
RedLog × mitmproxy Addon
Captures all HTTP requests flowing through mitmproxy and sends them to RedLog's timeline.

Usage:
    mitmproxy -s /path/to/redlog/hooks/mitmproxy-addon.py
    mitmweb  -s /path/to/redlog/hooks/mitmproxy-addon.py
    mitmdump -s /path/to/redlog/hooks/mitmproxy-addon.py

What gets logged:
    - Every request: method, URL, headers, query params, body (truncated)
    - Every response: status code, content type, size
    - Timing: request start → response end duration

Environment variables:
    REDLOG_MAX_BODY    Max request/response body bytes to capture (default 2048)
    REDLOG_SKIP_STATIC Skip static assets like .css/.js/.png/.woff (default true)
    REDLOG_VERBOSE     Log every request to stderr (default false)
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

MAX_BODY = int(os.environ.get("REDLOG_MAX_BODY", "2048"))
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


class RedLogAddon:
    def __init__(self):
        self._request_times: dict[str, float] = {}

    def request(self, flow: http.HTTPFlow):
        self._request_times[flow.id] = time.time()

    def response(self, flow: http.HTTPFlow):
        url = flow.request.pretty_url

        if SKIP_STATIC and _is_static(url):
            return

        parsed = urlparse(url)
        target = parsed.hostname or ""
        method = flow.request.method
        status = flow.response.status_code if flow.response else 0
        path = parsed.path

        start_time = self._request_times.pop(flow.id, None)
        duration_ms = int((time.time() - start_time) * 1000) if start_time else None

        params = _extract_params(flow)
        req_headers = _extract_interesting_headers(flow.request.headers, "request")
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
            "subtype": "http_request",
            "method": method,
            "url": url,
            "path": path,
            "host": target,
            "port": parsed.port or (443 if parsed.scheme == "https" else 80),
            "scheme": parsed.scheme,
            "status": status,
            "content_length": content_length,
            "content_type": (flow.response.headers.get("content-type", "") if flow.response else ""),
        }

        if params:
            event_data["params"] = params
        if req_headers:
            event_data["request_headers"] = req_headers
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
                f"[redlog] {method} {status} {url} "
                f"({content_length}B, {duration_ms}ms)"
            )

    def error(self, flow: http.HTTPFlow):
        url = flow.request.pretty_url
        parsed = urlparse(url)

        self._request_times.pop(flow.id, None)

        payload = {
            "agent_type": "scanner",
            "data": {
                "subtype": "http_error",
                "method": flow.request.method,
                "url": url,
                "host": parsed.hostname or "",
                "error": str(flow.error) if flow.error else "unknown",
            },
            "target_id": parsed.hostname or "",
        }
        _send_to_redlog(payload)


addons = [RedLogAddon()]
