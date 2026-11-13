#!/usr/bin/env python3
"""
redlog-verify — standalone RedLog evidence-bundle verifier.

Reads `manifest.json`, `events.jsonl`, `events_logged.jsonl` and
`operators.json` from a bundle directory (or a .zip file) and validates:

  1. Manifest checksum and the delivered files against declared SHA-256 digests.
  2. Complete chains: event links, hashes, head and available signatures.
     Projections: counts/identities and unchanged row hashes/signatures;
     omitted source rows and transformed source payloads cannot be verified.
  3. Attachments (screenshots, casts, HTTP bodies, artifacts, AI transcripts)
     against the sha256 the event that captured each one recorded — not
     against the manifest, which anyone holding the bundle can recompute.
  4. Bundle version 4: the export seal, a signed `system.export_sealed` row
     that is the last line of events.jsonl and commits to the rows before it
     and to the manifest (all of it except its `seal` block and the
     events.jsonl entry). A version 4 bundle without its seal FAILS. Earlier
     versions predate seals; they are reported "not sealed" and otherwise
     verify as they always did.

The rules are those of src/core/evidence-rules.ts and src/core/bundle-verify.ts
in the RedLog source; test/evidence-vectors.test.ts runs both over the same
tampered bundles and requires the same verdict.

Ed25519 checks require the optional `cryptography` module. Hashes alone prove
only that a bundle is self-consistent: anyone holding it can rewrite events,
re-hash them and strip the signatures. So once a bundle shows signing was in
use (any event carries a signature, or any operator in operators.json has a
signerPubKey), every event must be signed and every signature checkable;
otherwise verification FAILS. A bundle with no signatures at all gets a
distinct "NOT AUTHENTICATED" verdict. File checksums are not authenticated
source identities.
Exit code 0 = declared verification scope passed; inspect the report's limits.
Exit code 1 = integrity or signature verification failed (this includes an
              unsigned event, or a signature that could not be checked, in a
              bundle where signing was in use, and a logged tier that differs
              from its recorded digest).
Exit code 2 = bundle malformed / files missing / usage error, or a bundle this
              verifier does not understand (a newer version, an unknown
              manifest field or seal version in a version 4 bundle). Nothing
              is reported as verified in that case.
Exit code 3 = hash chain consistent but NOT AUTHENTICATED (nothing signed).
              Pass --hash-only to accept that and exit 0, with the same verdict.
              --hash-only also downgrades "unsigned events" and "signature
              cannot be checked" to that verdict; a signature that fails to
              verify, a broken chain or a file mismatch still exit 1.
Exit code 4 = an attachment differs from the sha256 its event recorded at
              capture, or is referenced and absent although the manifest
              lists it, or (version 4) is referenced, absent and not declared
              omitted by the export.
Exit code 5 = the bundle differs from what its export sealed, or a version 4
              bundle carries no seal (or --require-seal on an unsealed bundle).
When several apply: 2, then 1, then 4, then 5, then 3.
--hash-only never accepts 4 or 5.
The SHA-256 fingerprint of each signer public key is printed so it can be
compared out of band; OpenTimestamps receipts are not verified here.

No third-party dependencies required for SHA-256 verification.
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


_EXTENDED = "\\\\?\\"  # the four characters \\?\


def _extended_length(path: str, windows: bool = os.name == "nt") -> str:
    """Windows rejects paths past MAX_PATH (260) unless they carry the
    extended-length prefix, and without it `Path.exists()` answers False for a
    file that is there — so a bundle in a deep evidence folder reported every
    cast and screenshot as "missing" (#258). The path must already be
    absolute."""
    if not windows or path.startswith(_EXTENDED):
        return path
    if path.startswith("\\\\"):  # UNC: \\server\share -> \\?\UNC\server\share
        return _EXTENDED + "UNC\\" + path[2:]
    return _EXTENDED + path


# ---------------------------------------------------------------------------
# canonicalStringify — byte-for-byte port of src/core/db/events.ts
# ---------------------------------------------------------------------------
def _js_encode_scalar(v: Any) -> str:
    """Match JSON.stringify(v) for scalars (null / bool / number / string).

    Python's json.dumps with ensure_ascii=False + default separators produces
    the same output for these types (booleans lowercased, null lowercased,
    numbers via repr, strings JSON-escaped with the mandatory set).
    """
    out = json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    if isinstance(v, str):
        # JSON.stringify escapes a lone surrogate as \udXXX (a pair arrives
        # here already joined into one character), and the result must stay
        # encodable as UTF-8.
        out = "".join("\\u%04x" % ord(c) if 0xD800 <= ord(c) <= 0xDFFF else c for c in out)
    return out


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


def _parsed_data(row: Dict[str, Any]) -> Any:
    data_field = row.get("data")
    if isinstance(data_field, str):
        try:
            return json.loads(data_field)
        except Exception:
            return data_field
    return data_field


def _rebuild_shapes(row: Dict[str, Any]) -> Tuple[List[Tuple[str, str]], Dict[str, str]]:
    """Rebuild the single canonical payload used by the current writer."""
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
        "data": _parsed_data(row),
        "prevHash": row.get("prev_hash"),
        "createdAt": row.get("created_at"),
        "monotonicNs": row.get("monotonic_ns"),
        "ntpOffsetMs": row.get("ntp_offset_ms"),
        "tier": "chained",
    }
    canonical = canonical_stringify(payload)
    return [("canonical", _sha256_hex(canonical))], {"canonical": canonical}


# ---------------------------------------------------------------------------
# Shared rules — port of src/core/evidence-rules.ts
# ---------------------------------------------------------------------------
BUNDLE_VERSION = 4
SEAL_SUBTYPE = "export_sealed"
SEAL_VERSION = 1
ATTACHMENT_DIRS = ("screenshots/", "casts/", "http-bodies/", "artifacts/", "agent-transcripts/")
BODY_REF_KEYS = ("request_body_ref", "response_body_ref", "ws_body_ref", "tcp_body_ref",
                 "stdout_ref", "stderr_ref", "output_body_ref", "output_ref")
V4_MANIFEST_KEYS = {
    "evidence", "bundleVersion", "createdAt", "hostname", "engagementId", "signedBy", "chainHead", "lastAnchor",
    "sanitized", "sanitizedOutOfScope", "personalDropped", "doNotExportDropped", "exportPlan", "tiers", "attachments",
    "attachmentScopePolicy", "eventSourceBreakdown", "rawAgentTranscripts", "files", "seal", "omittedAttachments",
}
# The seal's own fields, plus `_ingest`: the receiver stamps every new row, this
# one included (Spec 071 FR-005). It is not a seal field and says nothing the
# seal check reads; refusing it would refuse every new seal.
SEAL_DATA_KEYS = {"subtype", "sealVersion", "exportId", "bundleVersion", "manifestSha256", "events", "description", "_ingest"}
SEAL_EVENTS_KEYS = {"count", "bytes", "sha256", "headHash"}


def _hex64(v: Any) -> bool:
    return isinstance(v, str) and len(v) == 64 and all(c in "0123456789abcdef" for c in v)


def _plain_name(v: Any) -> bool:
    return isinstance(v, str) and v not in ("", ".", "..") and not any(c in v for c in "\\/\0")


def _base_name(p: str) -> str:
    return p.replace("\\", "/").split("/")[-1]


def _size(v: Any) -> Optional[int]:
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 2 ** 53 - 1 else None


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def attachment_refs(agent_type: str, data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The attachment digests an event recorded when it was captured."""
    out: List[Dict[str, Any]] = []
    subtype = data.get("subtype")
    if agent_type == "screenshot" and _plain_name(data.get("filename")) and _hex64(data.get("sha256")):
        out.append({"path": "screenshots/" + data["filename"], "sha256": data["sha256"], "bytes": _size(data.get("size")), "prefix": False})
    if agent_type == "shell" and subtype == "session_end":
        segments = data.get("castSegments") if isinstance(data.get("castSegments"), list) else []
        if segments:
            for s in segments:
                name = _base_name(s["path"]) if isinstance(s, dict) and isinstance(s.get("path"), str) else ""
                if _plain_name(name) and _hex64(s.get("sha256")):
                    out.append({"path": "casts/" + name, "sha256": s["sha256"], "bytes": _size(s.get("bytes")), "prefix": False})
        elif isinstance(data.get("castPath"), str) and _hex64(data.get("castSha256")):
            name = _base_name(data["castPath"])
            if _plain_name(name):
                out.append({"path": "casts/" + name, "sha256": data["castSha256"], "bytes": _size(data.get("castBytes")), "prefix": False})
    if (agent_type == "file_transfer" and subtype == "artifact_added" and isinstance(data.get("stored"), str)
            and _hex64(data.get("sha256"))):
        parts = data["stored"].split("/")
        if len(parts) == 2 and parts[0] == "artifacts" and _plain_name(parts[1]):
            out.append({"path": data["stored"], "sha256": data["sha256"], "bytes": _size(data.get("size")), "prefix": False})
    if (agent_type == "agent" and subtype == "transcript_snapshot" and isinstance(data.get("snapshot_path"), str)
            and _hex64(data.get("cumulative_sha256"))):
        name = _base_name(data["snapshot_path"])
        nbytes = _size(data.get("cumulative_bytes"))
        if _plain_name(name) and nbytes is not None:
            out.append({"path": "agent-transcripts/" + name, "sha256": data["cumulative_sha256"], "bytes": nbytes, "prefix": True})
    for key in BODY_REF_KEYS:
        ref = data.get(key)
        if isinstance(ref, dict) and _hex64(ref.get("sha256")):
            out.append({"path": "http-bodies/" + ref["sha256"] + ".body", "sha256": ref["sha256"], "bytes": _size(ref.get("size")), "prefix": False})
    return out


def sealed_manifest_digest(manifest: Dict[str, Any]) -> str:
    """What a seal's manifestSha256 covers: the manifest without its `seal`
    block and without the events.jsonl file entry (both written after it)."""
    copy = {k: v for k, v in manifest.items() if k != "seal"}
    if isinstance(copy.get("files"), list):
        copy["files"] = [f for f in copy["files"] if not (isinstance(f, dict) and f.get("path") == "events.jsonl")]
    return _sha256_hex(canonical_stringify(copy))


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


def _pubkey_fingerprint(pub_b64: str) -> str:
    """SHA-256 of the raw public key bytes, for out-of-band comparison."""
    import base64
    try:
        raw = base64.b64decode(pub_b64)
    except Exception:
        raw = pub_b64.encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _iter_lines(path: Path):
    """(lineno, byte offset, row) for each non-blank line."""
    offset = 0
    with path.open("rb") as fh:
        for lineno, raw in enumerate(fh, start=1):
            start = offset
            offset += len(raw)
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            try:
                yield lineno, start, json.loads(line)
            except json.JSONDecodeError as e:
                raise SystemExit(f"malformed {path.name} at line {lineno}: {e}")


def _iter_events(events_path: Path):
    for lineno, _offset, row in _iter_lines(events_path):
        yield lineno, row


def _hash_file(path: Path, limit: Optional[int] = None) -> Tuple[str, int]:
    h = hashlib.sha256()
    n = 0
    with path.open("rb") as fh:
        while True:
            want = 65536 if limit is None else min(65536, limit - n)
            if want <= 0:
                break
            chunk = fh.read(want)
            if not chunk:
                break
            h.update(chunk)
            n += len(chunk)
    return h.hexdigest(), n


def verify_bundle(bundle_dir: Path, verbose: bool = False, hash_only: bool = False,
                  require_seal: bool = False) -> int:
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
        if not isinstance(manifest, dict):
            raise ValueError("not an object")
    except Exception as e:
        print(f"ERROR: manifest.json unreadable: {e}", file=sys.stderr)
        return 2

    checksum_path = bundle_dir / "manifest.sha256"
    try:
        declared = checksum_path.read_text(encoding="utf-8").split()[0]
        if declared != hashlib.sha256(manifest_path.read_bytes()).hexdigest():
            print("ERROR: manifest checksum mismatch", file=sys.stderr)
            return 1
    except (OSError, IndexError):
        print("ERROR: manifest checksum missing or malformed", file=sys.stderr)
        return 1

    # -- Version: refuse what this verifier does not understand -------------
    bundle_version = manifest.get("bundleVersion")
    if not _is_int(bundle_version):
        print("ERROR: bundleVersion missing or not an integer", file=sys.stderr)
        return 2
    if bundle_version > BUNDLE_VERSION:
        print(f"UNSUPPORTED: bundle version {bundle_version} is newer than this verifier "
              f"understands (up to {BUNDLE_VERSION}); nothing was verified", file=sys.stderr)
        return 2
    v4 = bundle_version >= 4
    seal_id: Optional[str] = None
    if v4:
        unknown = sorted(k for k in manifest if k not in V4_MANIFEST_KEYS)
        if unknown:
            print(f"UNSUPPORTED: manifest field(s) this verifier does not understand: "
                  f"{', '.join(unknown)}; nothing was verified", file=sys.stderr)
            return 2
        seal_block = manifest.get("seal")
        if not isinstance(seal_block, dict) or not (isinstance(seal_block.get("exportId"), str) or seal_block.get("exportId", 0) is None):
            print("ERROR: v4 manifest has no valid seal block", file=sys.stderr)
            return 2
        seal_id = seal_block.get("exportId")
        om = manifest.get("omittedAttachments")
        if not isinstance(om, list) or any(not isinstance(o, dict) or not isinstance(o.get("path"), str)
                                           or not isinstance(o.get("reason"), str) for o in om):
            print("ERROR: v4 manifest has no valid omittedAttachments list", file=sys.stderr)
            return 2

    evidence = manifest.get("evidence") or {}
    kind = evidence.get("kind", "complete-chain")
    if kind not in ("complete-chain", "projection"):
        print("ERROR: unknown evidence kind", file=sys.stderr)
        return 1
    projection = kind == "projection"
    transformed_list = evidence.get("transformedEventIds", [])
    if (not isinstance(transformed_list, list)
            or any(not isinstance(v, str) for v in transformed_list)
            or len(set(transformed_list)) != len(transformed_list)
            or (not projection and transformed_list)):
        print("ERROR: invalid transformed event identities", file=sys.stderr)
        return 1
    transformed = set(transformed_list)
    tiers = manifest.get("tiers") or {}
    if projection and any(type(tiers.get(t)) is not int or tiers[t] < 0
                          for t in ("chained", "logged")):
        print("ERROR: projection requires declared per-tier counts", file=sys.stderr)
        return 1
    seal_count = 1 if v4 and seal_id else 0
    source_chain = evidence.get("sourceChain") or {"eventCount": 0}
    if projection and (type(source_chain.get("eventCount")) is not int
                       or source_chain["eventCount"] < tiers["chained"] - seal_count):
        print("ERROR: invalid projection source boundary", file=sys.stderr)
        return 1
    seen_ids = set()

    # -- Locate this export's seal: the last row, naming the manifest's id --
    seal_offset: Optional[int] = None
    seal_row: Optional[Dict[str, Any]] = None
    last: Optional[Tuple[int, Dict[str, Any]]] = None
    for _lineno, offset, row in _iter_lines(events_path):
        last = (offset, row)
    if v4 and seal_id and last is not None:
        d = _parsed_data(last[1])
        if (last[1].get("agent_type") == "system" and isinstance(d, dict)
                and d.get("subtype") == SEAL_SUBTYPE and d.get("exportId") == seal_id):
            seal_offset, seal_row = last

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
    any_signature = False
    first_unsigned: Optional[str] = None
    signers: Dict[str, str] = {}
    last_hash: Optional[str] = None
    hash_before_seal: Optional[str] = None
    verified_rows: List[Tuple[Dict[str, Any], Any]] = []
    unverified_rows: List[Tuple[Dict[str, Any], Any]] = []
    bundle_engagement = manifest.get("engagementId")

    for lineno, offset, row in _iter_lines(events_path):
        walked += 1
        rid = row.get("id")

        if not isinstance(rid, str) or rid in seen_ids:
            print(f"ERROR: missing or duplicate event identity: {rid}", file=sys.stderr)
            return 1
        seen_ids.add(rid)
        is_seal = seal_offset is not None and offset == seal_offset
        if is_seal:
            hash_before_seal = last_hash
        # The seal is exempt from linking to the row before it: rows recorded
        # between the export boundary and the seal are not in the bundle. What
        # it follows is checked against its own `events` commitment instead.
        row_prev = row.get("prev_hash")
        if not projection and not is_seal and row_prev != expected_prev:
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

        if row.get("signature"):
            any_signature = True

        # Transformed projections prove the delivered bytes via file digests,
        # not their original payload hash/signature. Never call that a chain.
        if rid in transformed:
            unverified_rows.append((row, _parsed_data(row)))
            expected_prev = stored_hash
            last_hash = stored_hash
            continue

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
                        signers[op_id] = _pubkey_fingerprint(pub_b64)
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
            if first_unsigned is None:
                first_unsigned = rid

        verified_rows.append((row, _parsed_data(row)))
        expected_prev = stored_hash
        last_hash = stored_hash

        if verbose and walked % 500 == 0:
            print(f"... walked {walked} events", file=sys.stderr)

    # The delivered chain the manifest's chainHead describes: everything
    # before this export's seal. chainHead is `sha256(lastHash || count)`
    # (see chainHeadHash in src/core/chain-anchor.ts).
    before_seal = walked - 1 if seal_row is not None else walked
    head_last = hash_before_seal if seal_row is not None else last_hash
    head_ok: Optional[bool] = None
    manifest_head = manifest.get("chainHead") or {}
    manifest_head_hash = manifest_head.get("hash")
    if not projection and head_last and manifest_head_hash:
        recomputed = hashlib.sha256(
            head_last.encode("utf-8") + str(before_seal).encode("utf-8")
        ).hexdigest()
        head_ok = recomputed == manifest_head_hash

    if tiers.get("chained") is not None and tiers["chained"] != walked:
        print("ERROR: chained row count differs from manifest", file=sys.stderr)
        return 1
    if not projection and manifest_head.get("eventCount") is not None and manifest_head["eventCount"] != before_seal:
        print("CHAIN BROKEN: chain-head event count differs from delivered chain", file=sys.stderr)
        return 1

    # `events_logged.jsonl` is supporting evidence: it is not hash-chained,
    # signed, or anchored. Its rows are counted, compared with the digest the
    # export recorded, and read for attachment references.
    logged_path = bundle_dir / "events_logged.jsonl"
    logged_rows: Optional[int] = None
    logged_list: List[Tuple[Dict[str, Any], Any]] = []
    if logged_path.exists():
        try:
            logged_rows = 0
            for lineno, row in _iter_events(logged_path):
                rid = row.get("id")
                if not isinstance(rid, str) or rid in seen_ids:
                    print(f"ERROR: missing or duplicate event identity: {rid}", file=sys.stderr)
                    return 1
                seen_ids.add(rid)
                logged_list.append((row, _parsed_data(row)))
                logged_rows += 1
        except Exception as exc:
            print(f"ERROR: logged evidence unreadable: {exc}", file=sys.stderr)
            return 1
    if projection and (logged_rows or 0) != tiers["logged"]:
        print("ERROR: logged row count differs from manifest", file=sys.stderr)
        return 1
    if not transformed.issubset(seen_ids):
        print("ERROR: transformed event identity is not delivered", file=sys.stderr)
        return 1

    # ---------------------------------------------------------------------
    # Manifest file digests. `manifest["files"]` lists every artefact the
    # bundle ships with a sha256. Re-hash each listed file. For attachments
    # this is not the evidence check — the manifest is recomputable — that
    # comes below, against the digests the capturing events recorded.
    # ---------------------------------------------------------------------
    file_entries = manifest.get("files") or []
    if projection:
        covered = {entry.get("path") for entry in file_entries if entry.get("sha256")}
        required = {"events.jsonl"} | ({"events_logged.jsonl"} if logged_path.exists() else set())
        if not required.issubset(covered):
            print("ERROR: projection event files are not covered by manifest digests", file=sys.stderr)
            return 1
    if v4:
        paths = [e.get("path") if isinstance(e, dict) else None for e in file_entries]
        if (not isinstance(file_entries, list)
                or any(not isinstance(e, dict) or not isinstance(e.get("path"), str)
                       or not isinstance(e.get("sha256"), str) or not _is_int(e.get("bytes")) for e in file_entries)
                or len(set(paths)) != len(paths)):
            print("ERROR: v4 manifest file list is malformed (each path once, with sha256 and bytes)", file=sys.stderr)
            return 2
    files_checked = 0
    files_bad: List[str] = []
    files_missing: List[str] = []
    listed = set()
    actual: Dict[str, str] = {}
    # `manifest.json` cannot list its own digest (it would change the file),
    # and the two verifier scripts / manifest.sha256 / manifest.hmac are
    # signing wrappers around the manifest, not chain evidence — skip those.
    SELF = {"manifest.json", "manifest.sha256", "manifest.hmac", "redlog-verify.py", "verify.sh", "verify.cmd"}
    for entry in file_entries:
        rel = entry.get("path")
        want = entry.get("sha256")
        if isinstance(rel, str):
            listed.add(rel)
        if not rel or not want or rel in SELF:
            continue
        target_file = bundle_dir / rel
        if not target_file.exists():
            files_missing.append(rel)
            continue
        got, _n = _hash_file(target_file)
        actual[rel] = got
        files_checked += 1
        if got != want:
            files_bad.append(rel)

    failures: List[str] = []
    seal_failures: List[str] = []
    attachment_failures: List[str] = []

    # ---------------------------------------------------------------------
    # Seal (bundle version 4)
    # ---------------------------------------------------------------------
    seal_state = "not-sealed"
    if v4 and seal_id:
        if seal_row is None:
            seal_failures.append(f"the manifest names seal {seal_id}, but the last row of events.jsonl is not it")
        else:
            d = _parsed_data(seal_row)
            ev = d.get("events") if isinstance(d.get("events"), dict) else {}
            unknown = [k for k in d if k not in SEAL_DATA_KEYS]
            unknown_ev = [k for k in ev if k not in SEAL_EVENTS_KEYS]
            if d.get("sealVersion") != SEAL_VERSION or unknown or unknown_ev:
                extra = f" with field(s) {', '.join(unknown + unknown_ev)}" if unknown or unknown_ev else ""
                print(f"UNSUPPORTED: seal version {d.get('sealVersion')}{extra} is not one this verifier "
                      f"understands; the seal was not checked", file=sys.stderr)
                return 2
            if seal_row.get("id") in transformed:
                seal_failures.append("the seal row is declared transformed")
            if d.get("bundleVersion") != bundle_version:
                seal_failures.append("bundle version differs from the sealed one")
            if d.get("manifestSha256") != sealed_manifest_digest(manifest):
                seal_failures.append("manifest differs from the one the export sealed")
            prefix_sha, _n = _hash_file(events_path, seal_offset)
            if (ev.get("count") != before_seal or ev.get("bytes") != seal_offset
                    or ev.get("sha256") != prefix_sha or ev.get("headHash") != head_last):
                seal_failures.append("events.jsonl rows before the seal differ from the ones it sealed")
        seal_state = "mismatch" if seal_failures else "sealed"
    seal_ok = seal_state == "sealed"

    # ---------------------------------------------------------------------
    # Authentication. The chain is made of hashes anyone can recompute, so on
    # its own it cannot tell an untouched bundle from a rewritten one. If the
    # bundle shows signing was in use, a missing or uncheckable signature is
    # therefore a failure, not a counter.
    # ---------------------------------------------------------------------
    signing_declared = any(bool(v) for v in operators.values())
    signing_in_use = any_signature or signing_declared
    auth_failures: List[str] = []
    if signing_in_use:
        why = "an event carries a signature" if any_signature else "operators.json lists a signer public key"
        if unsigned:
            auth_failures.append(
                f"{unsigned} event(s) carry no signature although signing was in use "
                f"({why}); first: {first_unsigned}. This is not a bad signature: "
                f"--hash-only reports the chain without authentication")
        if signed_no_pubkey:
            auth_failures.append(
                f"{signed_no_pubkey} signed event(s) cannot be checked: their operator has "
                f"no signerPubKey in operators.json")
        if signed_skipped_no_dep:
            auth_failures.append(
                f"{signed_skipped_no_dep} signed event(s) cannot be checked: the "
                f"`cryptography` module is not installed")
    unauthenticated = not signing_in_use
    if hash_only and auth_failures:
        # Explicitly accepted: the chain is reported, nothing is authenticated.
        # A signature that FAILED to verify never reaches here (exit 1 above).
        unauthenticated = True
        auth_failures_shown = [f"NOT AUTHENTICATED (--hash-only): {m}" for m in auth_failures]
        auth_failures = []
    else:
        auth_failures_shown = [f"AUTHENTICATION FAILED: {m}" for m in auth_failures]

    if seal_state == "not-sealed":
        # Every bundle of version 4 or later is written with a seal, so one
        # without it has lost it. Earlier versions could not have one.
        if v4:
            seal_failures.append(f"a version {bundle_version} bundle carries no export seal")
        elif require_seal:
            seal_failures.append("the bundle is not sealed and --require-seal was given")

    # ---------------------------------------------------------------------
    # Logged-tier digest: recomputed when the delivered tier is the whole
    # digested tier, untransformed (same rows, same order, same columns).
    # ---------------------------------------------------------------------
    logged_digest_state = "n/a"
    declared_digest = tiers.get("loggedDigest")
    if isinstance(declared_digest, dict) and _is_int(declared_digest.get("count")) and isinstance(declared_digest.get("sha256"), str):
        if (logged_rows is not None and logged_rows == declared_digest["count"]
                and not any(r.get("id") in transformed for r, _d in logged_list)):
            h = hashlib.sha256()
            for r, _d in logged_list:
                h.update(canonical_stringify(r).encode("utf-8"))
                h.update(b"\n")
            # The JS writer's canonical form; must not rely on anything Python
            # serialises differently (see _js_encode_scalar).
            if h.hexdigest() == declared_digest["sha256"]:
                logged_digest_state = "matches"
            else:
                logged_digest_state = "MISMATCH"
                failures.append("logged tier differs from its recorded digest")
        else:
            logged_digest_state = "not comparable (the delivered logged tier is a subset or transformed)"

    # ---------------------------------------------------------------------
    # Attachments against the digests their events recorded at capture.
    # ---------------------------------------------------------------------
    refs_by_path: Dict[str, List[Dict[str, Any]]] = {}

    def add_refs(rows: List[Tuple[Dict[str, Any], Any]], verified: bool) -> None:
        for r, d in rows:
            if not isinstance(d, dict):
                continue
            for ref in attachment_refs(str(r.get("agent_type") or ""), d):
                ref["verified"] = verified or seal_ok
                refs_by_path.setdefault(ref["path"], []).append(ref)

    add_refs(verified_rows, True)
    add_refs(unverified_rows, False)
    add_refs(logged_list, False)
    declared_omissions: Dict[str, str] = {}
    if v4:
        for o in manifest["omittedAttachments"]:
            declared_omissions[o["path"]] = o["reason"]
    bound: List[str] = []
    bound_unverified: List[str] = []
    mismatched: List[str] = []
    omitted_declared: List[Tuple[str, str]] = []
    missing_undeclared: List[str] = []
    file_mismatch_paths = set()
    for rel in sorted(refs_by_path):
        refs = refs_by_path[rel]
        target_file = bundle_dir / rel
        if not target_file.is_file():
            if rel in declared_omissions:
                omitted_declared.append((rel, declared_omissions[rel]))
            else:
                missing_undeclared.append(rel)
                # Listed by the manifest and gone is removal after export in
                # any version. Unlisted and undeclared is only knowable from
                # v4, which declares every omission.
                if rel in listed or v4:
                    attachment_failures.append(
                        f"ATTACHMENT MISSING: {rel} is referenced by an event and absent"
                        + (" although the manifest lists it" if rel in listed
                           else ", and the export did not declare leaving it out"))
                if rel in listed:
                    file_mismatch_paths.add(rel)
            continue
        ok = True
        for ref in refs:
            if ref["prefix"]:
                got, n = _hash_file(target_file, ref["bytes"] or 0)
                if n != ref["bytes"]:
                    got = ""
            else:
                got = actual.get(rel) or _hash_file(target_file)[0]
            if got != ref["sha256"]:
                ok = False
        if not ok:
            mismatched.append(rel)
            file_mismatch_paths.add(rel)
        elif any(ref["verified"] for ref in refs):
            bound.append(rel)
        else:
            bound_unverified.append(rel)
    unbound = sorted(rel for rel in listed if rel.startswith(ATTACHMENT_DIRS) and rel not in refs_by_path)
    unlisted: List[str] = []
    for d in ATTACHMENT_DIRS:
        p = bundle_dir / d
        if p.is_dir():
            for name in sorted(os.listdir(p)):
                rel = d + name
                if rel not in listed and rel not in refs_by_path:
                    unlisted.append(rel)
    for rel in mismatched:
        attachment_failures.insert(0, f"ATTACHMENT MISMATCH: {rel} differs from the sha256 its event recorded")
    files_bad_other = [r for r in files_bad if r not in file_mismatch_paths]
    files_missing_other = [r for r in files_missing if r not in file_mismatch_paths]
    files_ok = not files_bad_other and not files_missing_other

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
    print("Manifest checksum: matches (not an authenticated source identity)")
    if projection:
        print("Evidence         : Projection (delivered subset)")
        print("Source chain     : NOT VERIFIED (omitted/transformed source records)")
        print(f"Omitted chained  : {source_chain['eventCount'] - before_seal}")
        print(f"Transformed rows : {len(transformed)} (source payload/signature not verified)")
        print("Projection limits: policy/transformation metadata is exporter-declared")
    elif auth_failures:
        print("Chain            : hashes consistent, but AUTHENTICATION FAILED (see below)")
    elif unauthenticated:
        print("Chain            : hash chain consistent, NOT AUTHENTICATED")
    else:
        print("Chain            : INTACT")
    if head_ok is True:
        print(f"Chain-head match : yes (recomputed matches manifest.chainHead)")
    elif head_ok is False:
        print(f"Chain-head match : NO — manifest.chainHead does not match recomputed head")
    elif projection:
        print("Chain-head match : n/a (source boundary, not delivered subset)")
    else:
        print(f"Chain-head match : n/a (manifest has no chainHead)")
    if seal_state == "sealed":
        follows = "directly" if seal_row.get("prev_hash") == head_last else (
            "after rows recorded past the export boundary, which are not in this bundle")
        print(f"Seal             : SEALED (export {seal_id}; it follows the delivered chain {follows})")
        print("                   rows before it and the manifest are as exported")
    elif seal_state == "mismatch" or (v4 and seal_failures):
        print("Seal             : FAILED (see below)")
    else:
        print(f"Seal             : NOT SEALED (bundle version {bundle_version} predates export seals)")
    if ed_verify is None:
        print(f"Signatures       : SKIPPED (install `cryptography` to verify)")
        print(f"  events skipped : {signed_skipped_no_dep}")
    else:
        print(f"Signatures       : {signed_ok} verified")
        if signed_no_pubkey:
            print(f"  no pubkey       : {signed_no_pubkey} (operator missing signerPubKey)")
    if unsigned:
        print(f"Unsigned events  : {unsigned}")
    for op_id, fp in sorted(signers.items()):
        print(f"Signer           : {op_id}  sha256:{fp}")
    if signers:
        print("  compare these fingerprints with the operator out of band;")
        print("  a key taken from this bundle only proves the bundle agrees with itself")
    for line in auth_failures_shown:
        print(line)
    if unauthenticated:
        print("Authentication   : NONE — the events cannot be tied to a signer.")
        print("                   Anyone holding this bundle could have rewritten its events")
        print("                   and re-hashed them; the hashes cannot tell.")
    if bad_sig_at:
        print(f"BAD SIGNATURE    : {bad_sig_at}")
    if logged_rows is not None:
        print(f"Logged tier      : {logged_rows} rows present in events_logged.jsonl")
        print(f"                   (not chained or signed; digest {logged_digest_state}"
              + ("; bytes sealed by the export)" if seal_ok else ")"))

    def show(label: str, items: List[str]) -> None:
        for rel in items[:20]:
            print(f"  {label:<15}: {rel}")
        if len(items) > 20:
            print(f"  {label:<15}: … and {len(items) - 20} more")

    print(f"Attachments      : {len(bound)} match the digest recorded at capture")
    if bound_unverified:
        print(f"                   {len(bound_unverified)} match only a logged or transformed row's digest"
              " (that row is not authenticated)")
    if unbound:
        print(f"                   {len(unbound)} unbound: in the bundle, referenced by no event in it —"
              " NOT verified against capture")
    if omitted_declared:
        print(f"                   {len(omitted_declared)} referenced and left out by the export (declared)")
        show("omitted", [f"{p} ({r})" for p, r in omitted_declared])
    if missing_undeclared:
        print(f"                   {len(missing_undeclared)} referenced and absent, not declared"
              + ("" if v4 else " (this bundle version cannot declare omissions)"))
        show("absent", missing_undeclared)
    if mismatched:
        print(f"                   {len(mismatched)} DIFFER from the digest recorded at capture")
        show("differs", mismatched)
    if unlisted:
        print(f"                   {len(unlisted)} present but in no manifest entry and no event (ignored)")

    if file_entries:
        if files_ok:
            print(f"Manifest files   : {files_checked} verified (sha256 matches)")
        else:
            print(f"Manifest files   : MISMATCH")
            for rel in files_missing_other:
                print(f"  missing         : {rel}")
            for rel in files_bad_other:
                print(f"  sha256 differs  : {rel}")
    for line in failures:
        print(f"FAILED           : {line}")
    for line in attachment_failures:
        print(line)
    for line in seal_failures:
        print(f"SEAL MISMATCH: {line}")

    if head_ok is False or not files_ok or auth_failures or failures:
        return 1
    if attachment_failures:
        print("Exit 4: an attachment does not match the evidence recorded for it.")
        return 4
    if seal_failures:
        print("Exit 5: the bundle is not what its export sealed.")
        return 5
    if unauthenticated and not hash_only:
        print("Exit 3: not authenticated. Re-run with --hash-only to accept a hash-chain-only check.")
        return 3
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
    p.add_argument("--hash-only", action="store_true",
                   help="Report the hash chain without authentication: exit 0 with "
                        "the 'NOT AUTHENTICATED' verdict instead of exit 3 (no "
                        "signatures) or 1 (unsigned/uncheckable events). A signature "
                        "that fails to verify is still a failure")
    p.add_argument("--require-seal", action="store_true",
                   help="Fail (exit 5) a bundle that carries no export seal, including "
                        "one of a version that predates seals")
    args = p.parse_args(argv)

    target = Path(_extended_length(str(Path(args.bundle).resolve())))
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
            return verify_bundle(root, verbose=args.verbose, hash_only=args.hash_only,
                                 require_seal=args.require_seal)

    if target.is_dir():
        return verify_bundle(target, verbose=args.verbose, hash_only=args.hash_only,
                             require_seal=args.require_seal)

    print(f"ERROR: {target} is neither a directory nor a .zip", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
