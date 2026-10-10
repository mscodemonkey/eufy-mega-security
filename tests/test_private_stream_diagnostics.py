"""Verify private archive integrity and bounded NVR evidence handling.

Synthetic packet and frame records exercise the public offline tool. Tests own
their temporary files and processes and require no account or vendor binaries.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys
import os
import tempfile
import unittest
import zipfile


SCRIPTS = Path(__file__).parents[1] / "eufy_event_gateway/scripts"
SPEC = importlib.util.spec_from_file_location("private_stream_diagnostics", SCRIPTS / "private-stream-diagnostics.py")
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)


def record(payload: bytes, kind: int = 2, channel: int = 0, elapsed: float = 1) -> bytes:
    """Build one synthetic binary replay record."""
    return struct.pack("<IdBBH", len(payload), elapsed, kind, channel, 0) + payload


class PrivateStreamDiagnosticsTest(unittest.TestCase):
    """Keep consented media private and inspect imported evidence as data."""

    def test_packet_and_audio_video_counts_remain_separate(self) -> None:
        """Count source commands without assuming that audio contains video bytes."""
        frames = [b"XZYH" + struct.pack("<H", command) + b"private-media"
                  for command in (1300, 1301, 1301, 1303)]
        summary = TOOL.summarize_records(TOOL.MAGIC + b"".join(record(frame) for frame in frames))
        self.assertEqual(summary["audioFrames"], 2)
        self.assertEqual(summary["videoFrames"], 2)
        self.assertNotIn("private-media", json.dumps(summary))

    def test_fragment_repeats_gaps_and_reordering_are_reported(self) -> None:
        """Retain arrival evidence without claiming a gap proves network loss."""
        records = []
        for index in (2, 0, 0):
            packet = bytearray(29)
            packet[:4] = b"PTCS"
            packet[4] = 3
            struct.pack_into("<HIIHH", packet, 6, 4, 9, 2001, index,
                             0x4001 | (0x0400 if index == 2 else 0))
            records.append(record(bytes(packet), kind=0, channel=3))
        summary = TOOL.summarize_records(TOOL.MAGIC + b"".join(records))
        fragments = summary["fragmentCounts"]
        self.assertEqual(fragments["duplicate"], 1)
        self.assertEqual(fragments["out_of_order"], 1)
        self.assertEqual(fragments["incomplete_groups"], 1)

    def test_corrupt_records_are_rejected(self) -> None:
        """Reject incomplete framing, invalid kinds, channels and time values."""
        malformed = [b"", TOOL.MAGIC + b"short", TOOL.MAGIC + record(b"abc")[:-1],
                     TOOL.MAGIC + record(b"abc", kind=9),
                     TOOL.MAGIC + record(b"abc", kind=0, channel=255),
                     TOOL.MAGIC + record(b"connected", kind=3, channel=255),
                     TOOL.MAGIC + record(b"token", kind=3, channel=255),
                     TOOL.MAGIC + record(b"x", elapsed=float("nan")),
                     TOOL.MAGIC + record(b"x", elapsed=60_000),
                     TOOL.MAGIC + record(b"x", elapsed=5) + record(b"x", elapsed=1)]
        for body in malformed:
            with self.subTest(body_length=len(body)), self.assertRaises(TOOL.DiagnosticError):
                TOOL.summarize_records(body)

    def test_bundle_round_trip_permissions_and_checksum(self) -> None:
        """Preserve original bytes, verify their hashes and refuse overwrites."""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "evidence.zip"
            body = TOOL.MAGIC + record(b"XZYH\x15\x05private-audio")
            result = TOOL.write_bundle(path, {"stream-records.bin": body}, {"source": "synthetic"})
            self.assertEqual(result["sharing"], "email_attachment")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            inspected = TOOL.inspect_bundle(path)
            self.assertEqual(inspected["summary"]["stream-records.bin"]["audioFrames"], 1)
            with zipfile.ZipFile(path) as archive:
                self.assertEqual(set(archive.namelist()), {"manifest.json", "stream-records.bin"})
                self.assertEqual(archive.read("stream-records.bin"), body)
            with self.assertRaises(TOOL.DiagnosticError):
                TOOL.write_bundle(path, {"stream-records.bin": body}, {})

    def test_archive_members_and_modified_bodies_are_rejected(self) -> None:
        """Never extract paths or accept unexpected files and damaged evidence."""
        body = TOOL.MAGIC + record(b"private")
        manifest = {"schemaVersion": 1, "privateMedia": True, "files": [
            {"name": "stream-records.bin", "length": len(body), "sha256": hashlib.sha256(body).hexdigest()}]}
        with tempfile.TemporaryDirectory() as directory:
            for number, (extra, modified) in enumerate((("../session.json", False),
                                                        (".env", False), (None, True))):
                path = Path(directory).resolve() / f"bad-{number}.zip"
                with zipfile.ZipFile(path, "w") as archive:
                    archive.writestr("manifest.json", json.dumps(manifest))
                    archive.writestr("stream-records.bin", body + (b"changed" if modified else b""))
                    if extra:
                        archive.writestr(extra, "private")
                with self.assertRaises(TOOL.DiagnosticError):
                    TOOL.inspect_bundle(path)

    def test_legacy_input_has_explicit_timing_limitations(self) -> None:
        """Do not manufacture arrival times or sent packets for old recordings."""
        summary = TOOL.summarize_legacy(struct.pack("<IB", 4, 3) + b"PTCS", False)
        self.assertEqual(summary["records"], 1)
        self.assertFalse(summary["arrivalTimesAvailable"])
        self.assertFalse(summary["outgoingPacketsAvailable"])
        with self.assertRaises(TOOL.DiagnosticError):
            TOOL.summarize_legacy(struct.pack("<IB", 100, 3) + b"PTCS", False)

    def test_symlinks_public_paths_and_unapproved_files_are_rejected(self) -> None:
        """Refuse accidental public storage and folder-wide private file collection."""
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            (base / "www").mkdir()
            (base / "real").mkdir()
            (base / "link").symlink_to(base / "real", target_is_directory=True)
            for path in (base / "www/evidence.zip", base / "link/evidence.zip"):
                with self.assertRaises(TOOL.DiagnosticError):
                    TOOL.private_path(path)
            with self.assertRaises(TOOL.DiagnosticError):
                TOOL.write_bundle(base / "evidence.zip", {"session.json": b"secret"}, {})

    def test_recorder_expiry_size_and_closed_state(self) -> None:
        """Exercise the real Node recorder's bounds without a network peer."""
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            program = f'''
import {{ NvrDiagnosticRecorder }} from {json.dumps((SCRIPTS / "nvr-diagnostic-recorder.mjs").as_uri())};
let now = 0;
const r = new NvrDiagnosticRecorder({json.dumps(str(base / "records.bin"))}, 30, () => now);
r.packet("received", "video", Buffer.from("first"));
now = 29_999;
r.frame(1, Buffer.from("XZYH\\x15\\x05audio"));
now = 30_000;
r.packet("sent", "video", Buffer.from("late"));
console.log(JSON.stringify(r.close()));
const large = new NvrDiagnosticRecorder({json.dumps(str(base / "large.bin"))});
large.packet("received", "video", Buffer.alloc(4 * 1024 * 1024 + 1));
console.log(JSON.stringify(large.close()));
const total = new NvrDiagnosticRecorder({json.dumps(str(base / "total.bin"))});
for (let i = 0; i < 20; i++) total.packet("received", "video", Buffer.alloc(4 * 1024 * 1024));
console.log(JSON.stringify(total.close()));
'''
            result = subprocess.run(["node", "--input-type=module", "-e", program],
                                    capture_output=True, text=True, check=True, timeout=15)
            timed, oversized, total = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(timed["stopReason"], "duration_limit")
            self.assertEqual(timed["records"], 2)
            self.assertEqual(oversized["stopReason"], "size_limit")
            self.assertLessEqual(total["bytes"], TOOL.MAX_BYTES)
            self.assertEqual(total["stopReason"], "size_limit")
            summary = TOOL.summarize_records((base / "records.bin").read_bytes())
            self.assertEqual(summary["records"], 2)

    def test_cli_requires_explicit_media_consent(self) -> None:
        """Refuse capture before opening a harness when consent is absent."""
        result = subprocess.run([sys.executable, str(SCRIPTS / "private-stream-diagnostics.py"),
                                 "capture-nvr", "--harness", "missing.ts", "--channel", "0",
                                 "--sensor", "0",
                                 "--output", "missing.zip"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--consent-private-media", result.stderr)

    def test_unknown_harness_is_refused_without_execution(self) -> None:
        """Never execute an unrecognized script supplied as diagnostic evidence."""
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            harness = base / "unknown.ts"
            harness.write_text('throw new Error("PRIVATE FAILURE TEXT");')
            result = subprocess.run([sys.executable, str(SCRIPTS / "private-stream-diagnostics.py"),
                                     "capture-nvr", "--harness", str(harness), "--channel", "0",
                                     "--sensor", "0",
                                     "--output", str(base / "evidence.zip"), "--consent-private-media"],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("PRIVATE FAILURE TEXT", result.stdout + result.stderr)
            self.assertFalse((base / "evidence.zip").exists())

    @unittest.skipUnless(os.name == "posix", "Research capture uses process groups")
    def test_process_stop_allows_cleanup(self) -> None:
        """Signal the owned child and allow its explicit shutdown handler to run."""
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            program = '''import signal, sys, time
from pathlib import Path
def stop(signum, frame):
    Path(sys.argv[2]).write_text("closed")
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
Path(sys.argv[1]).write_text("ready")
while True:
    time.sleep(1)
'''
            ready, closed = base / "ready", base / "closed"
            child = subprocess.Popen([sys.executable, "-c", program, str(ready), str(closed)],
                                     start_new_session=True)
            try:
                import time
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(ready.exists())
                TOOL.stop_child(child)
                self.assertEqual(closed.read_text(), "closed")
                self.assertEqual(child.poll(), 0)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()


if __name__ == "__main__":
    unittest.main()
