"""Capture and package explicitly consented private NVR diagnostic evidence.

The owner runs a pinned research harness locally. This utility owns temporary
instrumentation, bounded capture and an exclusive ZIP. Offline inspection reads
only data, never vendor code. No credentials or session files are collected.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import io
import json
import math
import os
from pathlib import Path
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile


HARNESS_SHA256 = "96591655bcdfed19f3f711a55a82a014c3fcdaa11be2c8a5182bb943f6bef1b5"
MAX_BYTES = 64 * 1024 * 1024
MAX_RECORD = 4 * 1024 * 1024
MAX_RECORDS = 200_000
EMAIL_BYTES = 20_000_000
MAGIC = b"EUFYNVR1"
RECORD = struct.Struct("<IdBBH")
MEMBERS = {"manifest.json", "stream-records.bin", "ptcs-capture.bin", "oracle-frames.bin"}
STATES = {b"new", b"connecting", b"connected", b"disconnected", b"failed", b"closed",
          b"checking", b"completed", b"gathering", b"complete"}


class DiagnosticError(Exception):
    """Carry only fixed, non-sensitive errors across the CLI boundary."""


def private_path(path: Path) -> Path:
    """Reject existing files, symlinks and common publicly served directories."""
    target = Path(os.path.abspath(path))
    if (target.exists() or target.is_symlink()
            or any(parent.is_symlink() for parent in target.parents)
            or any(part.lower() in {"www", "public", "static"} for part in target.parts)):
        raise DiagnosticError("Choose a new private output path outside public directories.")
    if not target.parent.is_dir():
        raise DiagnosticError("The private output directory must already exist.")
    return target


def read_private(path: Path, maximum: int = MAX_BYTES) -> bytes:
    """Read a regular non-symlink input within its explicit size limit."""
    if path.is_symlink() or any(parent.is_symlink() for parent in path.absolute().parents):
        raise DiagnosticError("Evidence paths must not contain symlinks.")
    original = path.lstat()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(original.st_mode) or not stat.S_ISREG(info.st_mode)
                or (original.st_dev, original.st_ino) != (info.st_dev, info.st_ino)
                or info.st_size > maximum):
            raise DiagnosticError("Evidence input is not a regular file within the size limit.")
        body = stream.read(maximum + 1)
    if len(body) > maximum:
        raise DiagnosticError("Evidence input exceeded the size limit.")
    return body


def summarize_records(body: bytes) -> dict:
    """Validate the replay format and expose counters without payload or identity text."""
    if len(body) > MAX_BYTES or not body.startswith(MAGIC):
        raise DiagnosticError("The stream record file has an invalid header or size.")
    offset, previous, count = len(MAGIC), 0.0, 0
    kinds, commands, channels = Counter(), Counter(), Counter()
    packet_types, fragments = Counter(), Counter()
    groups: dict[tuple, dict] = {}
    while offset < len(body):
        if len(body) - offset < RECORD.size:
            raise DiagnosticError("The stream record file is truncated.")
        length, elapsed, kind, channel, reserved = RECORD.unpack_from(body, offset)
        offset += RECORD.size
        if (length > MAX_RECORD or offset + length > len(body) or reserved != 0
                or kind not in range(4) or not math.isfinite(elapsed)
                or elapsed < previous or elapsed >= 60_000
                or (kind in (0, 1) and channel > 5)
                or (kind == 3 and channel not in (0, 1))):
            raise DiagnosticError("The stream record file contains an invalid record.")
        payload = memoryview(body)[offset:offset + length]
        previous = elapsed
        offset += length
        count += 1
        if count > MAX_RECORDS:
            raise DiagnosticError("The stream record count exceeded its limit.")
        kinds[("received", "sent", "frame", "state")[kind]] += 1
        channels[f"{kind}:{channel}"] += 1
        if kind == 3 and bytes(payload) not in STATES:
            raise DiagnosticError("The stream state record is invalid.")
        if kind in (0, 1) and length >= 5 and payload[:4] == b"PTCS":
            packet_types[str(payload[4])] += 1
            if length >= 28 and payload[4] == 3:
                fragment, flags = struct.unpack_from("<HH", payload, 16)
                sequence, timestamp, declared = struct.unpack_from("<HII", payload, 6)
                key = (kind, channel, payload[5], sequence, timestamp)
                group = groups.setdefault(key, {"seen": set(), "final": None, "last": -1})
                if fragment in group["seen"]:
                    fragments["duplicate"] += 1
                elif fragment < group["last"]:
                    fragments["out_of_order"] += 1
                group["seen"].add(fragment)
                group["last"] = fragment
                if flags & 0x0400:
                    group["final"] = fragment
                fragments["data"] += 1
                fragments["final"] += bool(flags & 0x0400)
                if (flags & 0x03ff) > length - 28:
                    fragments["invalid_length"] += 1
                if fragment == 0:
                    fragments["first"] += 1
                if declared > MAX_RECORD:
                    fragments["oversize_declaration"] += 1
        if kind == 2 and length >= 6 and payload[:4] == b"XZYH":
            command = struct.unpack_from("<H", payload, 4)[0]
            commands[str(command)] += 1
    for group in groups.values():
        final = group["final"]
        complete = final is not None and len(group["seen"]) == final + 1 and max(group["seen"]) == final
        fragments["complete_groups" if complete else "incomplete_groups"] += 1
    return {"records": count, "counts": dict(kinds), "channels": dict(channels),
            "elapsedMilliseconds": previous, "packetTypes": dict(packet_types),
            "fragmentCounts": dict(fragments), "frameCommands": dict(commands),
            "audioFrames": commands["1301"], "videoFrames": commands["1300"] + commands["1303"]}


def summarize_legacy(body: bytes, frames: bool) -> dict:
    """Check legacy harness record boundaries without inventing missing timestamps."""
    offset, count = 0, 0
    header = struct.Struct("<II" if frames else "<IB")
    while offset < len(body):
        if len(body) - offset < header.size:
            raise DiagnosticError("The legacy capture is truncated.")
        length, channel = header.unpack_from(body, offset)
        offset += header.size
        if (length > MAX_RECORD or offset + length > len(body)
                or channel > (255 if frames else 5)):
            raise DiagnosticError("The legacy capture contains an invalid record.")
        offset += length
        count += 1
        if count > MAX_RECORDS:
            raise DiagnosticError("The legacy capture record count exceeded its limit.")
    return {"records": count, "arrivalTimesAvailable": False, "outgoingPacketsAvailable": False}


def write_bundle(target: Path, files: dict[str, bytes], details: dict) -> dict:
    """Write a private allowlisted archive with checksums and no recursive collection."""
    target = private_path(target)
    if not files or sum(map(len, files.values())) > MAX_BYTES:
        raise DiagnosticError("The bundle is empty or exceeded its 64 MiB limit.")
    summaries = {}
    for name, data in files.items():
        if name not in MEMBERS - {"manifest.json"}:
            raise DiagnosticError("The requested evidence file is not allowed.")
        summaries[name] = (summarize_records(data) if name == "stream-records.bin"
                           else summarize_legacy(data, name == "oracle-frames.bin"))
    if not any(summary["records"] for summary in summaries.values()):
        raise DiagnosticError("No stream records were captured. No bundle was created.")
    manifest = {"schemaVersion": 1, "privateMedia": True, **details,
                "files": [{"name": name, "length": len(data),
                           "sha256": hashlib.sha256(data).hexdigest()}
                          for name, data in files.items()], "summary": summaries}
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                archive.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
                for name, data in files.items():
                    archive.writestr(name, data)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    size = target.stat().st_size
    return {"status": "saved", "bytes": size, "sharing": "private_cloud_link" if size > EMAIL_BYTES else "email_attachment",
            "privateMedia": True, "summary": summaries}


def inspect_bundle(path: Path) -> dict:
    """Inspect bounded ZIP data without extracting, following links or executing code."""
    body = read_private(path, MAX_BYTES + 1024 * 1024)
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if (len(names) != len(set(names)) or not 2 <= len(names) <= 4
                or "manifest.json" not in names or not set(names) <= MEMBERS
                or sum(entry.file_size for entry in entries) > MAX_BYTES + 64 * 1024
                or any(entry.file_size < 0 or entry.flag_bits & 1
                       or stat.S_ISLNK(entry.external_attr >> 16) for entry in entries)
                or archive.getinfo("manifest.json").file_size > 64 * 1024):
            raise DiagnosticError("The private bundle has invalid archive members.")
        manifest = json.loads(archive.read("manifest.json"))
        if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 or manifest.get("privateMedia") is not True:
            raise DiagnosticError("The bundle manifest is invalid.")
        expected = manifest.get("files")
        if (not isinstance(expected, list) or len(expected) != len(names) - 1
                or {item["name"] for item in expected} != set(names) - {"manifest.json"}):
            raise DiagnosticError("The bundle manifest does not match its files.")
        summaries = {}
        for item in expected:
            data = archive.read(item["name"])
            if item["length"] != len(data) or item["sha256"] != hashlib.sha256(data).hexdigest():
                raise DiagnosticError("The private bundle failed its checksum check.")
            summaries[item["name"]] = (summarize_records(data) if item["name"] == "stream-records.bin"
                                       else summarize_legacy(data, item["name"] == "oracle-frames.bin"))
    return {"status": "verified", "privateMedia": True, "summary": summaries}


def instrument_harness(source: str, scratch: Path, recorder: Path, seconds: int, sensor: int = 1) -> str:
    """Instrument exact known boundaries without changing authentication or commands.

    The source is Oliver Nixon's MIT research harness. The wrapper retains its
    original files and license, and never accepts a different source hash.
    """
    def replace(old: str, new: str) -> None:
        nonlocal source
        if source.count(old) != 1:
            raise DiagnosticError("The research harness does not match the supported source.")
        source = source.replace(old, new, 1)

    replace('const SCRATCH = new URL(".", import.meta.url).pathname;',
            f'import {{ NvrDiagnosticRecorder }} from {json.dumps(recorder.as_uri())};\n'
            f'const SCRATCH = {json.dumps(str(scratch) + os.sep)};\n'
            f'const evidence = new NvrDiagnosticRecorder(`${{SCRATCH}}stream-records.bin`, {seconds});\n'
            'process.once("exit", () => { writeFileSync(`${SCRATCH}capture-status.json`, JSON.stringify(evidence.close())); });')
    replace('function attach(dc: any): void {', 'function attach(dc: any): void {\n'
            '  const originalSend = dc.send.bind(dc);\n'
            '  dc.send = (data: any) => { evidence.packet("sent", dc.label, Buffer.from(data)); return originalSend(data); };')
    replace('const b = Buffer.from(ev.data as ArrayBuffer | Buffer);',
            'const b = Buffer.from(ev.data as ArrayBuffer | Buffer);\n  evidence.packet("received", dc.label, b);')
    replace('  framesSeen++;', '  framesSeen++;\n  evidence.frame(ch, frame);')
    replace('pc.connectionStateChange.subscribe((s: string) => log("pc_state", { s }));',
            'pc.connectionStateChange.subscribe((s: string) => { evidence.state("peer", s); log("pc_state", { s }); });')
    replace('pc.iceConnectionStateChange.subscribe((s: string) => log("ice_state", { s }));',
            'pc.iceConnectionStateChange.subscribe((s: string) => { evidence.state("ice", s); log("ice_state", { s }); });')
    replace('const dir = `${SCRATCH}../libsctp/`;',
            'const dir = new URL("../libsctp/", import.meta.url).pathname;')
    replace('chn: LIVE_CH, sensor: 1', f'chn: LIVE_CH, sensor: {sensor}')

    # Legacy media outputs are excluded, including the extractor that conflates audio with video.
    replace('appendFileSync(videoOut, nal);', 'void nal;')
    replace('appendFileSync(`${SCRATCH}oracle-frames.bin`, Buffer.concat([h, frame]));', 'void h;')
    replace('appendFileSync(`${SCRATCH}ptcs-capture.bin`, Buffer.concat([rec, b]));', 'void rec;')
    replace('  appendFileSync(LOG, line + "\\n");', '  void line;')
    replace('setTimeout(async () => {\n  if (liveStarted)',
            'let finishing = false;\nasync function finishCapture() {\n  if (finishing) return;\n  finishing = true;\n  if (liveStarted)')
    replace('}, runSeconds * 1000);', '}\nsetTimeout(() => void finishCapture(), runSeconds * 1000);\n'
            'process.once("SIGTERM", () => void finishCapture());\n'
            'process.once("SIGINT", () => void finishCapture());')
    return source


def stop_child(child: subprocess.Popen) -> None:
    """Allow stream-stop cleanup, then terminate only this run's process group."""
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=5)


def capture_nvr(args: argparse.Namespace) -> dict:
    """Run the owner-installed pinned harness and package only approved evidence."""
    if os.name != "posix":
        raise DiagnosticError("Research capture requires macOS or Linux. Bundle inspection also works elsewhere.")
    target = private_path(args.output)
    harness = args.harness.absolute()
    if any(parent.is_symlink() for parent in harness.parents):
        raise DiagnosticError("The research harness path must not contain symlinks.")
    raw = read_private(harness, 512 * 1024)
    if hashlib.sha256(raw).hexdigest() != HARNESS_SHA256:
        raise DiagnosticError("This harness version is not supported. Ask the maintainer for the matching setup.")
    vendor_hashes = {
        "libsctp_0_0_4.js": "1cf0326ab7b14a986af654d704f2eadcd9edb5e1290ca3f1a53a819d2054ea6a",
        "libsctp_0_0_4.wasm": "f9b49bca7611956f75f6198d1d05f5132e72a1fd1002522c15db15114584b227",
    }
    for name, digest in vendor_hashes.items():
        module = read_private(harness.parent.parent / "libsctp" / name, 16 * 1024 * 1024)
        if hashlib.sha256(module).hexdigest() != digest:
            raise DiagnosticError("The locally installed research decoder does not match the supported setup.")
    recorder = Path(__file__).with_name("nvr-diagnostic-recorder.mjs").resolve()
    with tempfile.TemporaryDirectory(prefix="eufy-nvr-private-") as directory:
        scratch = Path(directory).resolve()
        patched = instrument_harness(raw.decode("utf-8"), scratch, recorder, args.seconds, args.sensor)
        fd, script = tempfile.mkstemp(prefix=".eufy-private-capture-", suffix=".ts", dir=harness.parent)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(patched)
            environment = {**os.environ, "SPIKE_SECONDS": str(args.seconds), "SPIKE_LIVE_CH": str(args.channel)}
            if environment.get("EUFY_RESEARCH_SESSION_ONLY") != "1":
                raise DiagnosticError("Sign in using the supplied research setup, then enable its session-only mode locally.")
            child = subprocess.Popen(["node", "--import", "tsx", script], cwd=harness.parent,
                                     env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, start_new_session=True)
            outcome = "completed"
            try:
                code = child.wait(timeout=args.seconds + 90)
                if code != 0:
                    outcome = "harness_failed"
            except subprocess.TimeoutExpired:
                outcome = "timeout"
            except KeyboardInterrupt:
                outcome = "interrupted"
            finally:
                stop_child(child)
            status_path = scratch / "capture-status.json"
            status = json.loads(read_private(status_path, 4096)) if status_path.exists() else {}
            reason = status.get("stopReason")
            reason = reason if reason in {"completed", "duration_limit", "size_limit", "write_failed"} else "not_reported"
            data = read_private(scratch / "stream-records.bin")
            result = write_bundle(target, {"stream-records.bin": data}, {
                "source": "nvr-research", "sourceSha256": HARNESS_SHA256,
                "model": "T8N00", "durationLimitSeconds": args.seconds,
                "selectedSensor": args.sensor,
                "runOutcome": outcome, "stopReason": reason,
            })
        finally:
            Path(script).unlink(missing_ok=True)
    return result


def main() -> int:
    """Expose explicit capture, legacy import and offline inspection commands."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    capture = commands.add_parser("capture-nvr", help="Use the maintainer-supplied compatible research setup")
    capture.add_argument("--harness", type=Path, required=True)
    capture.add_argument("--channel", type=int, choices=range(256), required=True)
    capture.add_argument("--sensor", type=int, choices=(0, 1), required=True)
    capture.add_argument("--seconds", type=int, choices=(30, 60), default=30)
    capture.add_argument("--output", type=Path, required=True)
    capture.add_argument("--consent-private-media", action="store_true", required=True)
    legacy = commands.add_parser("bundle-nvr", help="Package existing files from one research session")
    legacy.add_argument("--directory", type=Path, required=True)
    legacy.add_argument("--output", type=Path, required=True)
    legacy.add_argument("--consent-private-media", action="store_true", required=True)
    inspect = commands.add_parser("inspect", help="Verify evidence offline without extracting it")
    inspect.add_argument("bundle", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "capture-nvr":
            result = capture_nvr(args)
        elif args.command == "bundle-nvr":
            files = {name: read_private(args.directory / name)
                     for name in ("ptcs-capture.bin", "oracle-frames.bin")}
            result = write_bundle(args.output, files, {"source": "legacy-nvr-research", "model": "T8N00",
                                  "limitations": ["no arrival times", "no outgoing packets", "session pairing not independently verified"]})
        else:
            result = inspect_bundle(args.bundle)
        print(json.dumps(result, sort_keys=True))
        return 0
    except DiagnosticError as error:
        print(json.dumps({"status": "failed", "error": str(error)}))
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, RuntimeError, subprocess.SubprocessError):
        print(json.dumps({"status": "failed", "error": "Diagnostics could not complete. No private error details were printed."}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
