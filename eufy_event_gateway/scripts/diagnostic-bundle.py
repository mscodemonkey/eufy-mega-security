"""Create and inspect universal diagnostic bundles using our saved gateway connection.

This owner-run utility reads Home Assistant's existing local integration token
without displaying it. The gateway owns selection, consent and capture limits.
The utility owns bounded transfers, an optional live viewer and exclusive private
output files. Archive inspection never executes content or displays private media.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import math
import multiprocessing
import os
from pathlib import Path
import stat
import sys
import time
from urllib.parse import quote
from urllib.request import ProxyHandler, Request, build_opener
import zlib


SPEC = importlib.util.spec_from_file_location(
    "eufy_private_export", Path(__file__).with_name("export-event-image-capture.py")
)
assert SPEC and SPEC.loader
HELPERS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPERS)
MAX_WIRE = 96 * 1024 * 1024
MAX_JSON = 112 * 1024 * 1024
MAX_MEDIA = 64 * 1024 * 1024
MAX_RECORDS = 20_000


class DiagnosticError(Exception):
    """Carry fixed safe errors rather than credential-bearing network exceptions."""


def request(url: str, token: str, method: str = "GET", value=None) -> bytes:
    """Reject redirects and proxies, and limit response size and transfer time."""
    data = json.dumps(value).encode() if value is not None else None
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
    opener = build_opener(ProxyHandler({}), HELPERS.NoRedirect())
    deadline = time.monotonic() + 45
    try:
        with opener.open(Request(url, data=data, headers=headers, method=method), timeout=15) as response:
            body = bytearray()
            while True:
                if time.monotonic() >= deadline:
                    raise DiagnosticError("Diagnostic transfer timed out.")
                chunk = response.read(min(64 * 1024, MAX_WIRE + 1 - len(body)))
                if not chunk:
                    return bytes(body)
                body.extend(chunk)
                if len(body) > MAX_WIRE:
                    raise DiagnosticError("Diagnostic response exceeded its limit.")
    except DiagnosticError:
        raise
    except Exception:
        raise DiagnosticError("Gateway request failed. Check its connection and capture status.") from None


def inspect_archive(body: bytes) -> dict:
    """Validate gzip, record limits and every media checksum without executing data."""
    if len(body) > MAX_WIRE:
        raise DiagnosticError("Diagnostic file exceeded its limit.")
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    decoded = decoder.decompress(body, MAX_JSON + 1)
    if len(decoded) > MAX_JSON or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise DiagnosticError("Diagnostic compression is invalid or exceeds its limit.")
    archive = json.loads(decoded)
    if not isinstance(archive, dict) or archive.get("schema") != "eufy-diagnostics-1":
        raise DiagnosticError("Unrecognized diagnostic archive.")
    if set(archive) != {"schema", "summary", "capture", "stages", "records", "media"}:
        raise DiagnosticError("Unrecognized diagnostic members.")
    records, media = archive["records"], archive["media"]
    if not isinstance(records, list) or not isinstance(media, list) or len(records) + len(media) > MAX_RECORDS:
        raise DiagnosticError("Diagnostic record limit exceeded.")
    for section in (records, media):
        previous = -1
        for row in section:
            value = row.get("offsetMs") if isinstance(row, dict) else None
            if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 <= value <= 60_000 or value < previous:
                raise DiagnosticError("Invalid diagnostic timing.")
            previous = value
    total = 0
    kinds = {}
    for row in media:
        if set(row) != {"offsetMs", "device", "kind", "codec", "bytes", "sha256", "base64"}:
            raise DiagnosticError("Unrecognized media record.")
        if row["kind"] not in {"video", "audio", "snapshot", "event-image"} or row["codec"] not in {"h264", "h265", "unknown", "aac", "jpeg"}:
            raise DiagnosticError("Unrecognized media format.")
        raw = base64.b64decode(row["base64"], validate=True)
        total += len(raw)
        if total > MAX_MEDIA or len(raw) != row["bytes"] or hashlib.sha256(raw).hexdigest() != row["sha256"]:
            raise DiagnosticError("Diagnostic media failed its integrity check.")
        kinds[row["kind"]] = kinds.get(row["kind"], 0) + 1
    if not isinstance(archive["capture"], dict) or archive["capture"].get("mediaBytes") != total:
        raise DiagnosticError("Diagnostic manifest does not match its media.")
    return {"valid": True, "archiveBytes": len(body), "records": len(records),
            "mediaChunks": len(media), "mediaBytes": total, "kinds": kinds,
            "sharing": "private_cloud_link" if len(body) > 20_000_000 else "email_or_private_cloud_link"}


def read_archive(path: Path) -> bytes:
    """Read a regular, non-symlink input with a strict compressed size limit."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise DiagnosticError("Choose a regular diagnostic file.")
        body = stream.read(MAX_WIRE + 1)
    if len(body) > MAX_WIRE:
        raise DiagnosticError("Diagnostic file exceeded its limit.")
    return body



def private_output_path(config: Path, output: Path) -> Path:
    """Allow HA's trusted config mount alias, rejecting symlinks beneath that root."""
    target = Path(os.path.abspath(output))
    root = Path(os.path.abspath(config)).parent.parent
    try:
        relative = target.relative_to(root)
    except ValueError:
        pass
    else:
        current = root
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise DiagnosticError("Choose a non-symlink private output path.")
        target = root.resolve() / relative
    target = HELPERS.output_path(config, target)
    if any(part.lower() in {"www", "public", "static"} for part in target.parts):
        raise DiagnosticError("Choose a private output folder.")
    return target

def save_archive(config: Path, output: Path, body: bytes) -> dict:
    """Validate before creating a private file, refusing overwrite and public paths."""
    report = inspect_archive(body)
    target = private_output_path(config, output)
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    identity = os.fstat(descriptor)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        current = target.lstat()
        if current.st_ino == identity.st_ino and current.st_dev == identity.st_dev:
            target.unlink()
        raise
    return report


def live_view(url: str, token: str) -> None:
    """Hold an existing camera viewer in an owned child, discarding HTTP media copies."""
    try:
        opener = build_opener(ProxyHandler({}), HELPERS.NoRedirect())
        with opener.open(Request(url, headers={"Authorization": "Bearer " + token}), timeout=45) as response:
            while response.read(64 * 1024):
                pass
    except Exception:
        pass


def run(options) -> dict:
    """Perform the selected owner-requested workflow, retaining tokens only in memory."""
    if options.command == "inspect":
        return inspect_archive(read_archive(options.input))
    url, token = HELPERS.gateway_connection(options.config, options.entry_id)
    endpoint = url + "/api/diagnostics/bundle"
    if options.command == "list":
        devices = json.loads(request(endpoint + "/targets", token))["devices"]
        return {"devices": [{"index": i + 1, "model": row["model"], "streamSupported": row["streamSupported"]}
                            for i, row in enumerate(devices)]}
    if options.command in {"status", "clear"}:
        return json.loads(request(endpoint, token, "DELETE" if options.command == "clear" else "GET"))
    if options.command == "export":
        return save_archive(options.config, options.output, request(endpoint + "/export", token, "POST"))
    if options.media and not options.consent_private_media:
        raise DiagnosticError("Private media capture requires explicit consent.")
    private_output_path(options.config, options.output)
    target = None
    devices = json.loads(request(endpoint + "/targets", token))["devices"]
    if options.target_index is not None:
        if not 1 <= options.target_index <= len(devices):
            raise DiagnosticError("Choose a device index from the current list.")
        target = devices[options.target_index - 1]
    if options.open_live and (not options.media or not target or not target["streamSupported"]):
        raise DiagnosticError("Live capture requires media consent and one supported camera.")
    request(endpoint, token, "POST", {"target": target["serial"] if target else None,
            "seconds": options.seconds, "media": options.media, "consentPrivateMedia": options.consent_private_media})
    viewer = None
    try:
        if options.open_live:
            viewer = multiprocessing.get_context("spawn").Process(target=live_view,
                args=(url + "/api/cameras/" + quote(target["serial"], safe="") + "/live.h264", token))
            viewer.start()
        time.sleep(options.seconds)
    finally:
        if viewer:
            viewer.terminate()
            viewer.join(2)
            if viewer.is_alive():
                viewer.kill()
                viewer.join()
        request(endpoint + "/stop", token, "POST")
    return save_archive(options.config, options.output, request(endpoint + "/export", token, "POST"))


def main(arguments=None) -> int:
    """Run a capture or data-only inspection and print only a compact safe result."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("/config/.storage/core.config_entries"))
    parser.add_argument("--entry-id")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "status", "clear"):
        sub.add_parser(name)
    capture = sub.add_parser("capture")
    capture.add_argument("--output", type=Path, required=True)
    capture.add_argument("--target-index", type=int)
    capture.add_argument("--seconds", type=int, choices=(30, 60), default=30)
    capture.add_argument("--media", action="store_true")
    capture.add_argument("--consent-private-media", action="store_true")
    capture.add_argument("--open-live", action="store_true")
    export = sub.add_parser("export")
    export.add_argument("--output", type=Path, required=True)
    inspect = sub.add_parser("inspect")
    inspect.add_argument("--input", type=Path, required=True)
    options = parser.parse_args(arguments)
    try:
        print(json.dumps(run(options), sort_keys=True))
        return 0
    except KeyboardInterrupt:
        print("Diagnostic capture cancelled. Stopped evidence may still be exported.", file=sys.stderr)
        return 130
    except Exception:
        print("Diagnostic action failed. Check selection, consent, gateway connection and private file path.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
