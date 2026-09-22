#!/usr/bin/env python3
"""
redlog-verify — standalone RedLog evidence-bundle verifier.

Reads `manifest.json`, `events.jsonl`, and `operators.json` from a bundle
directory (or a .zip file) and validates:

  1. The SHA-256 hash chain across every event.
  2. Each event's Ed25519 signature (when present) against the operator's
     public key in operators.json. This step requires the optional
     `cryptography` package — run the verifier as
     `uv run --with cryptography redlog-verify.py <bundle>` to supply it
     without installing anything. Without it the verifier prints a warning
     and skips signature verification; the hash chain still catches most
     tampering.

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
# Chain replay — matches the canonical payload in chain-anchor.ts
# ---------------------------------------------------------------------------
def _sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _rebuild_shapes(row: Dict[str, Any]) -> Tuple[List[Tuple[str, str]], Dict[str, str]]:
    """Rebuild the single canonical payload used by the current writer."""
    data_field = row.get("data")
    if isinstance(data_field, str):
        try:
            parsed_data = json.loads(data_field)
        except Exception:
            parsed_data = data_field
    else:
        parsed_data = data_field

    payload = {
        "id": row.get("id"),
        "timestamp": row.get("timestamp"),
        "engagementId": row.get("engagement_id"),
        "sessionId": row.get("session_id"),
        "operatorId": row.get("operator_id"),
        "agentType": row.get("agent_type"),
        "hostname": row.get("hostname"),
        "sourceIP": row.get("source_ip"),
        "targetId": row.get("target_id"),
        "data": parsed_data,
        "prevHash": row.get("prev_hash"),
        "createdAt": row.get("created_at"),
        "monotonicNs": row.get("monotonic_ns"),
        "ntpOffsetMs": row.get("ntp_offset_ms"),
        "tier": "chained",
    }
    canonical = canonical_stringify(payload)
    return [("canonical", _sha256_hex(canonical))], {"canonical": canonical}


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
            "signature checks, rerun as: uv run --with cryptography "
            "redlog-verify.py <bundle>",
            file=sys.stderr,
        )

    walked = 0
    expected_prev: Optional[str] = None
    signed_ok = 0
    signed_no_pubkey = 0
    signed_skipped_no_dep = 0
    unsigned = 0
    bad_sig_at: Optional[str] = None
    last_hash: Optional[str] = None
    bundle_engagement = manifest.get("engagementId")

    for lineno, row in _iter_events(events_path):
        walked += 1
        rid = row.get("id", f"<line {lineno}>")

        row_prev = row.get("prev_hash")
        if row_prev != expected_prev:
            print(
                f"CHAIN BROKEN at event {rid}: prev_hash mismatch "
                f"(expected {expected_prev!r}, got {row_prev!r})",
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

        # Signature verification uses the same canonical payload.
        sig_b64 = row.get("signature")
        if sig_b64:
            if ed_verify is None:
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

    # `events_logged.jsonl` is supporting evidence: it is not hash-chained,
    # signed, or anchored. Report its row count but exclude it from chain
    # verification.
    bundle_version = manifest["bundleVersion"]
    logged_path = bundle_dir / "events_logged.jsonl"
    logged_rows: Optional[int] = None
    if logged_path.exists():
        try:
            with logged_path.open("r", encoding="utf-8") as f:
                logged_rows = sum(1 for line in f if line.strip())
        except Exception:
            logged_rows = None

    # ---------------------------------------------------------------------
    # Manifest file digests. `manifest["files"]` lists every artefact the
    # bundle ships (events.jsonl, screenshots/, casts/, chain_anchors.json,
    # operators.json, …) with a sha256. The chain protects the events; it says
    # nothing about a screenshot or a cast that a recipient was handed as
    # evidence. Re-hash each listed file and fail if any differs, is missing,
    # or was not actually covered — otherwise a swapped screenshot passes
    # "chain intact" while being a different image than the operator captured.
    # ---------------------------------------------------------------------
    file_entries = manifest.get("files") or []
    files_checked = 0
    files_bad: List[str] = []
    files_missing: List[str] = []
    # `manifest.json` cannot list its own digest (it would change the file),
    # and the two verifier scripts / manifest.sha256 / manifest.hmac are
    # signing wrappers around the manifest, not chain evidence — skip those.
    SELF = {"manifest.json", "manifest.sha256", "manifest.hmac", "redlog-verify.py", "verify.sh", "verify.cmd"}
    for entry in file_entries:
        rel = entry.get("path")
        want = entry.get("sha256")
        if not rel or not want or rel in SELF:
            continue
        target_file = bundle_dir / rel
        if not target_file.exists():
            files_missing.append(rel)
            continue
        h = hashlib.sha256()
        with target_file.open("rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
        files_checked += 1
        if h.hexdigest() != want:
            files_bad.append(rel)
    files_ok = not files_bad and not files_missing

    # ---------------------------------------------------------------------
    # Report
    # ---------------------------------------------------------------------
    print("")
    print("RedLog bundle verification report")
    print("=" * 40)
    print(f"Bundle dir       : {bundle_dir}")
    print(f"Bundle version   : {bundle_version}")
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
    if unsigned:
        print(f"Unsigned events  : {unsigned}")
    if bad_sig_at:
        print(f"BAD SIGNATURE    : {bad_sig_at}")
    if logged_rows is not None:
        # Supporting-evidence tier row count. The verifier deliberately does
        # NOT walk these rows for chain integrity — they carry no hash.
        # Report the count so the reader knows the bundle carries footprint
        # context (DNS lookups, HTTP flow bookkeeping, agent thinking).
        print(f"Logged tier      : {logged_rows} rows present in events_logged.jsonl")
        print(f"                   (not verified — supporting evidence, see README)")

    if file_entries:
        if files_ok:
            print(f"Manifest files   : {files_checked} verified (sha256 matches)")
        else:
            print(f"Manifest files   : MISMATCH")
            for rel in files_missing:
                print(f"  missing         : {rel}")
            for rel in files_bad:
                print(f"  sha256 differs  : {rel}")

    if head_ok is False or not files_ok:
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
