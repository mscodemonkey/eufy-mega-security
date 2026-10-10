"""Export opt-in evidence through Home Assistant's saved gateway connection.

This local support utility owns one bounded HTTP transfer and an explicitly
requested private file. Credentials stay in memory. The gateway owns capture
lifetime, and the maintainer consumes the sensitive archive through a private
channel. Ordinary Home Assistant diagnostics never include these samples.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


MAX_BYTES = 10 * 1024 * 1024
DEADLINE_SECONDS = 30


class ExportError(Exception):
    """Carry a fixed non-sensitive error for local display."""


class NoRedirect(HTTPRedirectHandler):
    """Refuse credential-bearing redirects, including redirects to the same host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """Leave redirect handling to the generic failure boundary."""
        return None


def gateway_connection(config_path: Path, entry_id: str | None) -> tuple[str, str]:
    """Read the verified integration fields locally, rejecting ambiguous entries."""
    with config_path.open("rb") as stream:
        contents = stream.read(MAX_BYTES + 1)
    if len(contents) > MAX_BYTES:
        raise ExportError("Home Assistant configuration could not be read safely.")
    entries = json.loads(contents)["data"]["entries"]
    matches = [entry for entry in entries if entry.get("domain") == "eufy_event_gateway"
               and (entry_id is None or entry.get("entry_id") == entry_id)]
    if len(matches) != 1:
        raise ExportError("Select exactly one Eufy Mega Security integration entry.")
    data = matches[0]["data"]
    url, token = data["url"], data["api_token"]
    if not isinstance(url, str) or not isinstance(token, str) or not token:
        raise ExportError("The saved gateway connection is incomplete.")
    parsed = urlsplit(url)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment or parsed.path not in {"", "/"}
            or any(ord(char) < 33 or ord(char) > 126 for char in url)
            or any(ord(char) < 33 or ord(char) > 126 for char in token)):
        raise ExportError("The saved gateway URL is not supported by this tool.")
    parsed.port
    return url.rstrip("/"), token


def bounded_request(opener, url: str, token: str, method: str, deadline: float) -> bytes:
    """Read bounded responses without proxies, redirects or raw error reporting.

    A parent process enforces the total wall deadline even if a socket stalls.
    The monotonic checks additionally bound ordinary incremental transfers.
    """
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ExportError("The evidence export timed out.")
    request = Request(url, method=method, headers={"Authorization": "Bearer " + token})
    try:
        with opener.open(request, timeout=remaining) as response:
            declared = response.headers.get("content-length")
            if declared is not None and (not declared.isdigit() or int(declared) > MAX_BYTES):
                raise ExportError("The gateway returned an invalid evidence response.")
            body = bytearray()
            while True:
                if time.monotonic() >= deadline:
                    raise ExportError("The evidence export timed out.")
                chunk = response.read(min(64 * 1024, MAX_BYTES + 1 - len(body)))
                if not chunk:
                    break
                body.extend(chunk)
                if len(body) > MAX_BYTES:
                    raise ExportError("The evidence response exceeded its size limit.")
            if declared is not None and len(body) != int(declared):
                raise ExportError("The evidence response was incomplete.")
            return bytes(body)
    except HTTPError as error:
        error.close()
        if error.code == 409:
            raise ExportError("No failed event image has been captured yet.") from None
        if error.code == 410:
            raise ExportError("The capture session has ended. Restart with capture enabled to try again.") from None
        raise ExportError("The gateway refused the evidence request.") from None


def validate_archive(body: bytes) -> None:
    """Verify structure and exact body integrity before saving sensitive evidence."""
    archive = json.loads(body)
    samples = archive.get("samples")
    if archive.get("schemaVersion") != 1 or not isinstance(samples, list) or not 1 <= len(samples) <= 4:
        raise ExportError("The evidence archive is invalid.")
    total = 0
    for sample in samples:
        data = base64.b64decode(sample["bodyBase64"], validate=True)
        total += len(data)
        if (len(data) > 2 * 1024 * 1024 or sample["length"] != len(data)
                or sample["sha256"] != hashlib.sha256(data).hexdigest()
                or not isinstance(sample.get("metadata"), dict)):
            raise ExportError("The evidence archive failed its integrity check.")
    if total > 6 * 1024 * 1024:
        raise ExportError("The evidence archive exceeded its size limit.")


def output_path(config_path: Path, destination: Path) -> Path:
    """Reject symlinks, existing files and Home Assistant's public www directory."""
    target = Path(os.path.abspath(destination))
    public = config_path.resolve().parent.parent / "www"
    if (target.exists() or target.is_symlink()
            or any(parent.is_symlink() for parent in target.parents)
            or target.resolve() == public or public in target.resolve().parents):
        raise ExportError("Choose a new private output file outside Home Assistant www.")
    return target


def export_evidence(config_path: Path, destination: Path, entry_id: str | None, clear: bool,
                    created_path: Path) -> None:
    """Export once; explicit clearing runs only after a validated durable write.

    The owner process supplies a unique marker so timeout cleanup removes only
    the file created by this worker, never a pre-existing destination.
    """
    target = output_path(config_path, destination)
    url, token = gateway_connection(config_path, entry_id)
    opener = build_opener(ProxyHandler({}), NoRedirect())
    deadline = time.monotonic() + DEADLINE_SECONDS
    endpoint = url + "/api/diagnostics/event-images"
    status = json.loads(bounded_request(opener, endpoint, token, "GET", deadline))
    if status.get("state") != "active":
        raise ExportError("The capture session has ended. Restart with capture enabled to try again.")
    body = bounded_request(opener, endpoint + "/export", token, "POST", deadline)
    validate_archive(body)
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            details = os.fstat(stream.fileno())
            identity = {"device": details.st_dev, "inode": details.st_ino, "complete": False}
            created_path.write_text(json.dumps(identity))
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
            identity["complete"] = True
            replacement = created_path.with_suffix(".complete")
            replacement.write_text(json.dumps(identity))
            replacement.replace(created_path)
    except BaseException:
        cleanup_output(target, created_path)
        raise
    if clear:
        try:
            bounded_request(opener, endpoint, token, "DELETE", deadline)
        except Exception:
            raise ExportError("Archive saved, but capture could not be cleared. Disable capture in the app settings.") from None


def cleanup_output(destination: Path, marker: Path) -> None:
    """Remove only the worker-created inode after an incomplete write or timeout."""
    try:
        expected = json.loads(marker.read_text())
        current = destination.lstat()
        if not expected.get("complete") and current.st_dev == expected["device"] and current.st_ino == expected["inode"]:
            destination.unlink()
    except (OSError, ValueError, KeyError):
        pass


def worker(options, marker: str, result) -> None:
    """Keep credential-bearing exceptions inside the isolated transfer process."""
    try:
        export_evidence(options.config, options.output, options.entry_id, options.clear, Path(marker))
    except ExportError as error:
        result.send((False, str(error)))
    except Exception:
        result.send((False, "Evidence export failed. Check the integration connection and private output path."))
    else:
        result.send((True, "Private evidence archive saved. Do not attach it to a public issue."))
    finally:
        result.close()


def main(arguments: list[str] | None = None) -> int:
    """Run a hard-deadline transfer without displaying credentials or payloads."""
    import tempfile

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("/config/.storage/core.config_entries"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--entry-id")
    parser.add_argument("--clear", action="store_true", help="End capture only after the archive is saved.")
    options = parser.parse_args(arguments)
    context = multiprocessing.get_context("spawn")
    with tempfile.TemporaryDirectory(prefix="eufy-image-export-") as temporary:
        marker = Path(temporary) / "created.json"
        receiver, sender = context.Pipe(duplex=False)
        process = context.Process(target=worker, args=(options, str(marker), sender))
        process.start()
        sender.close()
        try:
            process.join(DEADLINE_SECONDS)
        except KeyboardInterrupt:
            process.terminate()
            process.join(1)
            if process.is_alive():
                process.kill()
                process.join()
            cleanup_output(options.output, marker)
            receiver.close()
            print("Evidence export cancelled.", file=sys.stderr)
            return 130
        if process.is_alive():
            process.terminate()
            process.join(1)
            if process.is_alive():
                process.kill()
                process.join()
            cleanup_output(options.output, marker)
            print("The evidence export timed out. A complete private archive may already be saved.", file=sys.stderr)
            receiver.close()
            return 1
        if receiver.poll():
            try:
                success, message = receiver.recv()
            except EOFError:
                success, message = False, "Evidence export failed."
        else:
            success, message = False, "Evidence export failed."
        receiver.close()
        print(message, file=sys.stdout if success else sys.stderr)
        return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
