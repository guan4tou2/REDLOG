#!/usr/bin/env python3
"""
redlog-verify — standalone RedLog evidence-bundle verifier.

Reads `manifest.json`, `events.jsonl`, and `operators.json` from a bundle
directory (or a .zip file) and validates:

  1. The SHA-256 hash chain across every event.
  2. Each event's Ed25519 signature (when present) against the operator's
     public key in operators.json. This step requires the optional
     `cryptography` package (`pip install cryptography`); the verifier
     prints a warning and skips signature verification if not installed —
     the hash chain still catches most tampering.

Exit code 0 = chain intact (signature verification may have been skipped).
Exit code 1 = chain broken or a signature verification failed.
Exit code 2 = bundle malformed / files missing / usage error.

No third-party dependencies required for hash-chain verification.
Python 3.8+.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# canonicalStringify — byte-for-byte port of src/core/db/events.ts
# ---------------------------------------------------------------------------
def _js_encode_scalar(v: Any) -> str:
    """Match JSON.stringify(v) for scalars (null / bool / number / string).

    Python's json.dumps with ensure_ascii=False + default separators produces
    the same output for these types (booleans lowercased, null lowercased,
    numbers via repr, strings JSON-escaped with the mandatory set).
    """
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def canonical_stringify(v: Any) -> str:
    """Port of canonicalStringify from src/core/db/events.ts.

    Rules:
      - null / non-object / non-array → JSON.stringify(v)
      - array → '[' + items.map(canonicalStringify).join(',') + ']'
      - object → keys sorted, values with `undefined` dropped, joined as
        `"key":value` with commas.

    Python note: parsed-JSON dicts never contain `undefined`; the drop-
    undefined rule is a no-op here. `null` is a real value and is kept.
    """
    if v is None or isinstance(v, bool) or isinstance(v, (int, float, str)):
        return _js_encode_scalar(v)
    if isinstance(v, list):
        return "[" + ",".join(canonical_stringify(x) for x in v) + "]"
    if isinstance(v, dict):
        parts = []
        for k in sorted(v.keys()):
            parts.append(json.dumps(k, ensure_ascii=False) + ":" + canonical_stringify(v[k]))
        return "{" + ",".join(parts) + "}"
    # Anything else (bytes, custom classes) — fall back to json.dumps.
    return _js_encode_scalar(v)


# ---------------------------------------------------------------------------
# Legacy shape stringify — parity with JS `JSON.stringify(obj)` for insertion
# ---------------------------------------------------------------------------
def js_stringify_ordered(pairs: List[Tuple[str, Any]]) -> str:
    """Emit `{"k1":v1,"k2":v2,...}` in the given order.

    Values that are None-valued and explicitly passed as such are emitted as
    `null`. Values passed as the sentinel `_UNDEFINED` are dropped (JS
    JSON.stringify drops object properties whose value is `undefined`).
    Nested objects/arrays use canonical_stringify since none of the legacy
    shapes cared about nested ordering (the `data` payload's keys are already
    fixed at write time).
    """
    parts = []
    for k, val in pairs:
        if val is _UNDEFINED:
            continue
        parts.append(json.dumps(k, ensure_ascii=False) + ":" + canonical_stringify(val))
    return "{" + ",".join(parts) + "}"


class _Sentinel:
    def __repr__(self) -> str:  # pragma: no cover
        return "<undefined>"


_UNDEFINED = _Sentinel()


# ---------------------------------------------------------------------------
# Ed25519 signature verification — optional
# ---------------------------------------------------------------------------
def _load_ed25519_verifier():
    """Return a verify(pub_b64, msg_bytes, sig_bytes) -> bool callable, or None."""
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        from cryptography.exceptions import InvalidSignature
    except Exception:
        return None

    import base64

    def verify(pub_b64: str, msg: bytes, sig: bytes) -> bool:
        try:
            raw = base64.b64decode(pub_b64)
            if len(raw) != 32 or len(sig) != 64:
                return False
            key = Ed25519PublicKey.from_public_bytes(raw)
            try:
                key.verify(sig, msg)
                return True
            except InvalidSignature:
                return False
        except Exception:
            return False

    return verify


# ---------------------------------------------------------------------------
# Chain replay — matches the 6 hash shapes in chain-anchor.ts:verifyChainFull
# ---------------------------------------------------------------------------
def _sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _rebuild_shapes(row: Dict[str, Any]) -> List[Tuple[str, str]]:
    """Return [(label, sha256_hex), ...] in newest-first order — same order
    as chain-anchor.ts:verifyChainFull attempts.

    Each shape reconstructs the object that was hashed at write time from
    the snake_case DB row columns.
    """
    # row['data'] arrives as a string (bundle-export.ts writes each SQL row
    # as JSON with the `data` column left as-is). Parse it into an object.
    data_field = row.get("data")
    if isinstance(data_field, str):
        try:
            parsed_data = json.loads(data_field)
        except Exception:
            parsed_data = data_field
    else:
        parsed_data = data_field

    rid = row.get("id")
    ts = row.get("timestamp")
    eng = row.get("engagement_id")
    sess = row.get("session_id")
    op = row.get("operator_id")
    at = row.get("agent_type")
    host = row.get("hostname")
    src_ip = row.get("source_ip")
    tgt = row.get("target_id")
    prev = row.get("prev_hash")
    created = row.get("created_at")
    mono = row.get("monotonic_ns")
    ntp = row.get("ntp_offset_ms")

    # v0.1 shape — no prevHash, no monotonicNs/ntpOffsetMs (in insertion order)
    shape_v01_pairs: List[Tuple[str, Any]] = [
        ("id", rid), ("timestamp", ts),
        ("engagementId", eng), ("sessionId", sess),
        ("operatorId", op), ("agentType", at),
        ("hostname", host), ("sourceIP", src_ip), ("targetId", tgt),
        ("data", parsed_data),
        ("hash", _UNDEFINED),
        ("createdAt", created),
    ]

    # v0.2 shape — same + prevHash between hash-undefined and createdAt.
    shape_v02_pairs: List[Tuple[str, Any]] = [
        ("id", rid), ("timestamp", ts),
        ("engagementId", eng), ("sessionId", sess),
        ("operatorId", op), ("agentType", at),
        ("hostname", host), ("sourceIP", src_ip), ("targetId", tgt),
        ("data", parsed_data),
        ("hash", _UNDEFINED),
        ("prevHash", prev),
        ("createdAt", created),
    ]

    # v0.6 shape — v0.2 + monotonicNs/ntpOffsetMs when non-null (matches
    # `if (row.monotonic_ns != null) shapeV06.monotonicNs = row.monotonic_ns`).
    shape_v06_pairs = list(shape_v02_pairs)
    if mono is not None:
        shape_v06_pairs.append(("monotonicNs", mono))
    if ntp is not None:
        shape_v06_pairs.append(("ntpOffsetMs", ntp))

    # v0.6+null — always includes monotonicNs/ntpOffsetMs, even as null.
    shape_v06_null_pairs = list(shape_v02_pairs)
    shape_v06_null_pairs.append(("monotonicNs", mono))
    shape_v06_null_pairs.append(("ntpOffsetMs", ntp))

    # Build the two "object shapes" for canonical hashing. Order irrelevant
    # for canonical (keys are sorted), so we can pass them as dicts.
    def pairs_to_dict(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
        # Drop _UNDEFINED entries — canonical_stringify never emits them anyway
        # since we filter here, but keep parity with the JS `hash: undefined`
        # drop rule.
        return {k: v for k, v in pairs if v is not _UNDEFINED}

    canonical_v06_null = canonical_stringify(pairs_to_dict(shape_v06_null_pairs))
    canonical_v06_strip = canonical_stringify(pairs_to_dict(shape_v06_pairs))

    legacy_v06 = js_stringify_ordered(shape_v06_pairs)
    legacy_v06_null = js_stringify_ordered(shape_v06_null_pairs)
    legacy_v02 = js_stringify_ordered(shape_v02_pairs)
    legacy_v01 = js_stringify_ordered(shape_v01_pairs)

    # Order: chain-anchor.ts tries canonical (v0.6.88) first, then strip
    # variant, then legacy shapes in newest-first order.
    return [
        ("v0.6.88", _sha256_hex(canonical_v06_null)),
        ("v0.6.88+strip", _sha256_hex(canonical_v06_strip)),
        ("v0.6", _sha256_hex(legacy_v06)),
        ("v0.6+null", _sha256_hex(legacy_v06_null)),
        ("v0.2", _sha256_hex(legacy_v02)),
        ("v0.1", _sha256_hex(legacy_v01)),
    ], {
        # Canonical JSON string per shape — needed if we go on to verify the
        # signature (only defined for v0.6.88 shapes).
        "v0.6.88": canonical_v06_null,
        "v0.6.88+strip": canonical_v06_strip,
    }


# ---------------------------------------------------------------------------
# Bundle walker
# ---------------------------------------------------------------------------
def _load_operators(bundle_dir: Path) -> Dict[str, Optional[str]]:
    """Return {operator_id: signerPubKey|None}. Missing file → empty dict."""
    p = bundle_dir / "operators.json"
    if not p.exists():
        return {}
    try:
        rows = json.loads(p.read_text(encoding="utf-8"))
        return {row["id"]: row.get("signerPubKey") for row in rows if "id" in row}
    except Exception:
        return {}


def _extract_io_refs(row: Dict[str, Any]) -> List[str]:
    """io_ref sidecar digests (SPEC-IO-SIDECAR.md) carried by an event, if any.
    The full HTTP bodies live in the bundle's io/ dir as <sha256>.bin; the event
    holds only the digest, so verify re-hashes the file against it (A4)."""
    data_field = row.get("data")
    if isinstance(data_field, str):
        try:
            data_field = json.loads(data_field)
        except Exception:
            return []
    if not isinstance(data_field, dict):
        return []
    io = data_field.get("io")
    if not isinstance(io, dict):
        return []
    refs: List[str] = []
    for slot in ("request", "response"):
        ref = io.get(slot)
        if isinstance(ref, dict) and isinstance(ref.get("ref"), str):
            refs.append(ref["ref"])
    return refs


def _extract_io_swaps(row: Dict[str, Any]) -> Dict[str, str]:
    """Scope-sanitize io digest swaps (SPEC-SCOPE-AWARE-LIFECYCLE.md Part B) from
    a system.sanitized event: {orig_sha: replacement_sha}. The bundle serves the
    redacted replacement under the ORIGINAL name, so verify must expect the
    replacement digest for those bodies — a match is *sanitized*, not tampered."""
    if row.get("agent_type") != "system":
        return {}
    data_field = row.get("data")
    if isinstance(data_field, str):
        try:
            data_field = json.loads(data_field)
        except Exception:
            return {}
    if not isinstance(data_field, dict) or data_field.get("subtype") != "sanitized":
        return {}
    swaps: Dict[str, str] = {}
    for r in (data_field.get("io_replacements") or []):
        if isinstance(r, dict) and isinstance(r.get("ref"), str) and isinstance(r.get("sha256"), str):
            swaps[r["ref"]] = r["sha256"]
    return swaps


def _iter_events(events_path: Path):
    with events_path.open("r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                yield lineno, json.loads(line)
            except json.JSONDecodeError as e:
                raise SystemExit(f"malformed events.jsonl at line {lineno}: {e}")


def verify_bundle(bundle_dir: Path, verbose: bool = False) -> int:
    manifest_path = bundle_dir / "manifest.json"
    events_path = bundle_dir / "events.jsonl"

    if not manifest_path.exists():
        print(f"ERROR: manifest.json missing from {bundle_dir}", file=sys.stderr)
        return 2
    if not events_path.exists():
        print(f"ERROR: events.jsonl missing from {bundle_dir}", file=sys.stderr)
        return 2

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"ERROR: manifest.json unreadable: {e}", file=sys.stderr)
        return 2

    operators = _load_operators(bundle_dir)
    ed_verify = _load_ed25519_verifier()
    if ed_verify is None:
        print(
            "NOTE: cryptography module not installed — signature verification "
            "will be skipped. Hash chain will still be validated. To enable "
            "signature checks: pip install cryptography",
            file=sys.stderr,
        )

    walked = 0
    expected_prev: Optional[str] = None
    seen_non_null_prev = False
    signed_ok = 0
    signed_no_pubkey = 0
    signed_skipped_no_dep = 0
    signed_wrong_shape = 0
    unsigned = 0
    bad_sig_at: Optional[str] = None
    last_hash: Optional[str] = None
    bundle_engagement = manifest.get("engagementId")
    io_refs: Dict[str, str] = {}   # ref -> first event id that carries it
    io_swaps: Dict[str, str] = {}  # orig sha -> replacement sha (scope sanitize)

    for lineno, row in _iter_events(events_path):
        walked += 1
        rid = row.get("id", f"<line {lineno}>")
        for ref in _extract_io_refs(row):
            io_refs.setdefault(ref, str(rid))
        for orig, repl in _extract_io_swaps(row).items():
            io_swaps[orig] = repl

        row_prev = row.get("prev_hash")
        if row_prev is not None:
            seen_non_null_prev = True
            if row_prev != expected_prev:
                print(
                    f"CHAIN BROKEN at event {rid}: prev_hash mismatch "
                    f"(expected {expected_prev!r}, got {row_prev!r})",
                    file=sys.stderr,
                )
                return 1
        elif seen_non_null_prev:
            # Same silent-forgery check as v0.6.93 P0-A.
            print(
                f"CHAIN BROKEN at event {rid}: NULL prev_hash after migration "
                f"boundary (silent-forgery vector, see v0.6.93 audit).",
                file=sys.stderr,
            )
            return 1

        stored_hash = row.get("hash")
        if not stored_hash:
            print(f"CHAIN BROKEN at event {rid}: row has no stored hash",
                  file=sys.stderr)
            return 1

        attempts, canonical_strings = _rebuild_shapes(row)
        matched_label: Optional[str] = None
        for label, h in attempts:
            if h == stored_hash:
                matched_label = label
                break

        if matched_label is None:
            tried = ", ".join(f"{a[0]}={a[1][:8]}" for a in attempts)
            print(
                f"CHAIN BROKEN at event {rid}: hash mismatch "
                f"(tried {tried}; stored {stored_hash[:16]}...)",
                file=sys.stderr,
            )
            return 1

        # Signature verification — only rows hashed under a v0.6.88 canonical
        # shape have a canonical JSON string we can verify against.
        sig_b64 = row.get("signature")
        if sig_b64:
            if not matched_label.startswith("v0.6.88"):
                # Older shape — no canonical string exists. Legacy rows never
                # carried signatures, so this is unexpected but non-fatal:
                # treat as unsigned so we don't break replay.
                signed_wrong_shape += 1
            elif ed_verify is None:
                signed_skipped_no_dep += 1
            else:
                op_id = row.get("operator_id", "")
                pub_b64 = operators.get(op_id)
                if not pub_b64:
                    signed_no_pubkey += 1
                else:
                    import base64
                    try:
                        sig_bytes = base64.b64decode(sig_b64)
                    except Exception:
                        sig_bytes = b""
                    canonical = canonical_strings.get(matched_label, "")
                    msg = canonical.encode("utf-8")
                    if ed_verify(pub_b64, msg, sig_bytes):
                        signed_ok += 1
                    else:
                        bad_sig_at = rid
                        print(
                            f"SIGNATURE INVALID at event {rid} "
                            f"(operator={op_id})",
                            file=sys.stderr,
                        )
                        return 1
        else:
            unsigned += 1

        expected_prev = stored_hash
        last_hash = stored_hash

        if verbose and walked % 500 == 0:
            print(f"... walked {walked} events", file=sys.stderr)

    # Optional: verify manifest.chainHead against the recomputed head. The
    # manifest's chainHead is `sha256(lastHash || walkedCount)` (see
    # computeChainHead in src/core/chain-anchor.ts:66-79).
    head_ok: Optional[bool] = None
    manifest_head = manifest.get("chainHead") or {}
    manifest_head_hash = manifest_head.get("hash")
    if last_hash and manifest_head_hash:
        recomputed = hashlib.sha256(
            last_hash.encode("utf-8") + str(walked).encode("utf-8")
        ).hexdigest()
        head_ok = recomputed == manifest_head_hash

    # io_ref sidecar bodies (SPEC-IO-SIDECAR.md A4). The chain attests each
    # body's sha256; the bytes live in io/<sha256>.bin. Re-hash every referenced
    # file: a match confirms the bytes are the ones attested; a MISSING file is
    # reported as *pruned* (retention removed it) not tampered; a mismatch is
    # tampering and fails the bundle.
    io_ok = 0
    io_pruned = 0
    io_sanitized = 0
    io_bad_at: Optional[str] = None
    io_dir = bundle_dir / "io"
    for ref, ev_id in io_refs.items():
        raw = io_dir / f"{ref}.bin"
        gz = io_dir / f"{ref}.bin.gz"
        # Warm (compressed) bodies keep the ORIGINAL sha256 as their stem, so we
        # decompress before hashing (SPEC-SCOPE-AWARE-LIFECYCLE.md A4). A missing
        # file (neither raw nor warm) is pruned, not tampered.
        if raw.exists():
            f, compressed = raw, False
        elif gz.exists():
            f, compressed = gz, True
        else:
            io_pruned += 1
            continue
        try:
            data = f.read_bytes()
            if compressed:
                import gzip as _gzip
                data = _gzip.decompress(data)
            actual = hashlib.sha256(data).hexdigest()
        except Exception:
            io_pruned += 1
            continue
        # Scope-sanitized body: the bundle serves the redacted replacement under
        # the original name, so its bytes must hash to the RECORDED replacement
        # digest. Match = sanitized (expected), mismatch = tampered.
        if ref in io_swaps:
            if actual == io_swaps[ref]:
                io_sanitized += 1
            else:
                io_bad_at = ev_id
                print(
                    f"IO SIDECAR TAMPERED: sanitized io/{ref}.bin does not match "
                    f"its recorded replacement digest (event {ev_id}); computed {actual[:16]}...",
                    file=sys.stderr,
                )
                break
            continue
        if actual == ref:
            io_ok += 1
        else:
            io_bad_at = ev_id
            print(
                f"IO SIDECAR TAMPERED: io/{ref}.bin does not match its chained "
                f"digest (event {ev_id}); computed {actual[:16]}...",
                file=sys.stderr,
            )
            break

    # ---------------------------------------------------------------------
    # Report
    # ---------------------------------------------------------------------
    print("")
    print("RedLog bundle verification report")
    print("=" * 40)
    print(f"Bundle dir       : {bundle_dir}")
    print(f"Engagement ID    : {bundle_engagement}")
    print(f"Events walked    : {walked}")
    print(f"Chain            : INTACT")
    if head_ok is True:
        print(f"Chain-head match : yes (recomputed matches manifest.chainHead)")
    elif head_ok is False:
        print(f"Chain-head match : NO — manifest.chainHead does not match recomputed head")
    else:
        print(f"Chain-head match : n/a (manifest has no chainHead)")
    if ed_verify is None:
        print(f"Signatures       : SKIPPED (install `cryptography` to verify)")
        print(f"  events skipped : {signed_skipped_no_dep}")
    else:
        print(f"Signatures       : {signed_ok} verified")
        if signed_no_pubkey:
            print(f"  no pubkey       : {signed_no_pubkey} (operator missing signerPubKey)")
        if signed_wrong_shape:
            print(f"  legacy shape    : {signed_wrong_shape}")
    if unsigned:
        print(f"Unsigned events  : {unsigned}")
    if bad_sig_at:
        print(f"BAD SIGNATURE    : {bad_sig_at}")
    if io_refs:
        summary = f"{io_ok} verified"
        if io_sanitized:
            summary += f", {io_sanitized} sanitized (scope — not tampered)"
        if io_pruned:
            summary += f", {io_pruned} pruned (retention — not tampered)"
        print(f"IO sidecars      : {summary}")
        if io_bad_at:
            print(f"IO SIDECAR BAD   : {io_bad_at}")

    if head_ok is False:
        return 1
    if io_bad_at:
        return 1
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(
        prog="redlog-verify",
        description="Verify a RedLog evidence bundle (hash chain + optional Ed25519 signatures).",
    )
    p.add_argument(
        "bundle",
        nargs="?",
        default=".",
        help="Path to a bundle directory or .zip file (default: current directory)",
    )
    p.add_argument("-v", "--verbose", action="store_true",
                   help="Print progress every 500 events")
    args = p.parse_args(argv)

    target = Path(args.bundle).resolve()
    if not target.exists():
        print(f"ERROR: {target} does not exist", file=sys.stderr)
        return 2

    if target.is_file() and target.suffix.lower() == ".zip":
        # Unzip to a temp dir so we can walk the manifest + events.
        with tempfile.TemporaryDirectory(prefix="redlog-verify-") as tmp:
            with zipfile.ZipFile(target, "r") as zf:
                zf.extractall(tmp)
            # The bundle may be nested inside a single top-level dir.
            entries = list(Path(tmp).iterdir())
            root = Path(tmp)
            if len(entries) == 1 and entries[0].is_dir():
                root = entries[0]
            return verify_bundle(root, verbose=args.verbose)

    if target.is_dir():
        return verify_bundle(target, verbose=args.verbose)

    print(f"ERROR: {target} is neither a directory nor a .zip", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
