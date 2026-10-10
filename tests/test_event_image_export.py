"""Check the private export tool without Home Assistant or vendor services.

Synthetic config files and HTTP responses own all credentials and payloads.
These cases protect private-file handling, bounded requests and explicit clear.
"""

from __future__ import annotations

import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import py_compile
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError


SOURCE = Path(__file__).parents[1] / "eufy_event_gateway/scripts/export-event-image-capture.py"
SPEC = importlib.util.spec_from_file_location("event_image_export", SOURCE)
EXPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXPORT)


def archive() -> bytes:
    """Return a synthetic archive with a verifiable original body."""
    body = b"synthetic-private-body"
    return json.dumps({"schemaVersion": 1, "samples": [{
        "bodyBase64": base64.b64encode(body).decode(), "length": len(body),
        "sha256": hashlib.sha256(body).hexdigest(), "metadata": {},
    }]}).encode()


class Response(io.BytesIO):
    """Supply the response boundary consumed by the bounded reader."""

    def __init__(self, body: bytes, headers=None):
        super().__init__(body)
        self.headers = headers or {}


class EventImageExportTests(unittest.TestCase):
    """Verify exports stay private and failures preserve prior user files."""

    def setUp(self):
        """Create an isolated Home Assistant-shaped configuration root."""
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        storage = self.root / ".storage"
        storage.mkdir()
        self.config = storage / "core.config_entries"
        self.entry = {"domain": "eufy_event_gateway", "entry_id": "fixture", "data": {
            "url": "http://gateway.invalid:3218", "api_token": "synthetic-private-secret",
        }}
        self.write_entries([self.entry])
        self.destination = self.root / "private.json"
        self.marker = self.root / "created.json"

    def write_entries(self, entries):
        """Write only synthetic local entries for one selection test."""
        self.config.write_text(json.dumps({"data": {"entries": entries}}))

    def test_entry_selection_and_url_rejection(self):
        """Fail closed on ambiguous entries and credential-forwarding URLs."""
        self.assertEqual(EXPORT.gateway_connection(self.config, None), (
            "http://gateway.invalid:3218", "synthetic-private-secret"))
        self.write_entries([self.entry, {**self.entry, "entry_id": "second"}])
        with self.assertRaises(EXPORT.ExportError):
            EXPORT.gateway_connection(self.config, None)
        self.assertEqual(EXPORT.gateway_connection(self.config, "fixture")[0], "http://gateway.invalid:3218")
        self.write_entries([])
        with self.assertRaises(EXPORT.ExportError):
            EXPORT.gateway_connection(self.config, None)
        for url in ["file:///private", "http://user:pass@host", "http://host/?private=1", "http://host/#private", "http://host/api", "http://host\nprivate"]:
            self.entry["data"]["url"] = url
            self.write_entries([self.entry])
            with self.assertRaises(EXPORT.ExportError):
                EXPORT.gateway_connection(self.config, None)

    def test_export_is_private_validated_and_never_cleared_implicitly(self):
        """Save exact bounded bytes with mode 0600 and no default DELETE."""
        methods = []

        def request(opener, url, token, method, deadline):
            methods.append(method)
            return b'{"state":"active"}' if method == "GET" else archive()

        with patch.object(EXPORT, "bounded_request", request):
            EXPORT.export_evidence(self.config, self.destination, None, False, self.marker)
        self.assertEqual(methods, ["GET", "POST"])
        self.assertEqual(self.destination.read_bytes(), archive())
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o600)
        EXPORT.cleanup_output(self.destination, self.marker)
        self.assertTrue(self.destination.exists())
        with self.assertRaises(EXPORT.ExportError):
            EXPORT.output_path(self.config, self.destination)

    def test_clear_runs_only_after_durable_file_and_failure_preserves_export(self):
        """A clear failure must not delete the successfully exported evidence."""
        methods = []

        def request(opener, url, token, method, deadline):
            methods.append(method)
            if method == "GET":
                return b'{"state":"active"}'
            if method == "DELETE":
                self.assertEqual(self.destination.read_bytes(), archive())
                raise OSError("synthetic-private-secret")
            return archive()

        with patch.object(EXPORT, "bounded_request", request):
            with self.assertRaisesRegex(EXPORT.ExportError, "Archive saved"):
                EXPORT.export_evidence(self.config, self.destination, None, True, self.marker)
        self.assertEqual(methods, ["GET", "POST", "DELETE"])
        EXPORT.cleanup_output(self.destination, self.marker)
        self.assertTrue(self.destination.exists())

    def test_rejects_public_paths_symlinks_and_prior_files(self):
        """Protect www and existing files, including paths with symlink parents."""
        public = self.root / "www"
        public.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(public, target_is_directory=True)
        prior = self.root / "prior.json"
        prior.write_bytes(b"prior")
        link = self.root / "link.json"
        link.symlink_to(prior)
        for destination in [public / "new.json", alias / "new.json", prior, link]:
            with self.assertRaises(EXPORT.ExportError):
                EXPORT.output_path(self.config, destination)
        self.assertEqual(prior.read_bytes(), b"prior")
        self.assertEqual(EXPORT.output_path(self.config, self.destination), self.destination)

    def test_bounded_reader_rejects_lengths_timeout_and_redirect_errors(self):
        """Keep raw transport exceptions and untrusted URLs out of diagnostics."""
        class Opener:
            """Return a chosen fixture response or error."""

            def __init__(self, result):
                self.result = result

            def open(self, request, timeout):
                """Expose only the urllib response protocol to the reader."""
                if isinstance(self.result, Exception):
                    raise self.result
                return self.result

        deadline = time.monotonic() + 30
        for response in [Response(b"x", {"content-length": "999999999"}),
                         Response(b"x", {"content-length": "2"}),
                         Response(b"x", {"content-length": "invalid"}),
                         Response(b"x" * (EXPORT.MAX_BYTES + 1))]:
            with self.assertRaises(EXPORT.ExportError):
                EXPORT.bounded_request(Opener(response), "http://fixture.invalid", "fixture", "POST", deadline)
        with self.assertRaises(EXPORT.ExportError):
            EXPORT.bounded_request(Opener(Response(b"x")), "http://fixture.invalid", "fixture", "POST", time.monotonic() - 1)
        error = HTTPError("http://private.invalid/secret", 302, "private", {}, io.BytesIO())
        with self.assertRaises(EXPORT.ExportError) as caught:
            EXPORT.bounded_request(Opener(error), "http://fixture.invalid", "fixture", "POST", deadline)
        self.assertNotIn("secret", str(caught.exception))
        self.assertIsNone(EXPORT.NoRedirect().redirect_request(None, None, 302, "", {}, "http://private.invalid"))

    def test_opener_disables_environment_proxies(self):
        """Never send the gateway credential through configured proxy services."""
        with patch.object(EXPORT, "build_opener", side_effect=RuntimeError) as build:
            with self.assertRaises(RuntimeError):
                EXPORT.export_evidence(self.config, self.destination, None, False, self.marker)
        handlers = build.call_args.args
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsInstance(handlers[1], EXPORT.NoRedirect)

    def test_invalid_archive_never_creates_file_or_clears(self):
        """Reject body corruption before making any persistent artifact."""
        for body in [b"{}", b'{"schemaVersion":1,"samples":[]}', archive().replace(b'"length": 22', b'"length": 1')]:
            with self.assertRaises((EXPORT.ExportError, ValueError, KeyError)):
                EXPORT.validate_archive(body)
        methods = []

        def request(opener, url, token, method, deadline):
            methods.append(method)
            return b'{"state":"active"}' if method == "GET" else b"{}"

        with patch.object(EXPORT, "bounded_request", request):
            with self.assertRaises(EXPORT.ExportError):
                EXPORT.export_evidence(self.config, self.destination, None, True, self.marker)
        self.assertEqual(methods, ["GET", "POST"])
        self.assertFalse(self.destination.exists())

    def test_partial_cleanup_only_removes_owned_incomplete_inode(self):
        """Timeout cleanup preserves pre-existing or fully written archives."""
        self.destination.write_bytes(b"partial")
        details = self.destination.stat()
        self.marker.write_text(json.dumps({"device": details.st_dev, "inode": details.st_ino + 1}))
        EXPORT.cleanup_output(self.destination, self.marker)
        self.assertTrue(self.destination.exists())
        self.marker.write_text(json.dumps({"device": details.st_dev, "inode": details.st_ino, "complete": False}))
        EXPORT.cleanup_output(self.destination, self.marker)
        self.assertFalse(self.destination.exists())

    def test_cli_and_compile_errors_do_not_print_private_configuration(self):
        """Exercise the spawned entry point and generic credential-safe errors."""
        py_compile.compile(str(SOURCE), cfile=str(self.root / "tool.pyc"), doraise=True)
        self.entry["data"]["url"] = "file:///synthetic-private-secret"
        self.write_entries([self.entry])
        result = subprocess.run([sys.executable, str(SOURCE), "--config", str(self.config),
                                 "--output", str(self.destination)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("synthetic-private-secret", result.stdout + result.stderr)
        self.assertFalse(self.destination.exists())

    def test_total_deadline_stops_a_slow_continuous_transfer(self):
        """A stream of small chunks cannot extend the process-wide deadline."""
        class SlowHandler(BaseHTTPRequestHandler):
            """Hold a local response open while supplying small timely chunks."""

            def do_GET(self):
                """Keep each socket read active past the total export deadline."""
                self.send_response(200)
                self.end_headers()
                try:
                    for _ in range(100):
                        self.wfile.write(b" ")
                        self.wfile.flush()
                        time.sleep(0.05)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, format, *args):
                """Keep local test traffic out of output."""

        server = ThreadingHTTPServer(("127.0.0.1", 0), SlowHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        tool = self.root / "bounded_export.py"
        tool.write_text(SOURCE.read_text().replace("DEADLINE_SECONDS = 30", "DEADLINE_SECONDS = 0.5"))
        self.entry["data"]["url"] = "http://127.0.0.1:" + str(server.server_port)
        self.write_entries([self.entry])
        try:
            started = time.monotonic()
            result = subprocess.run([sys.executable, str(tool), "--config", str(self.config),
                                     "--output", str(self.destination)], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 1)
            self.assertIn("timed out", result.stderr)
            self.assertLess(time.monotonic() - started, 3)
            self.assertFalse(self.destination.exists())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)

    def test_spawned_cli_exports_and_explicitly_clears_over_authenticated_http(self):
        """Exercise the complete credential-to-private-file workflow locally."""
        methods = []
        destination = self.destination

        class GatewayHandler(BaseHTTPRequestHandler):
            """Serve the private gateway protocol with only synthetic content."""

            def respond(self, method, body):
                """Require the saved credential and return one bounded response."""
                methods.append((method, self.headers.get("Authorization")))
                self.send_response(200)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                """Return a capture with an available sample."""
                self.respond("GET", b'{"state":"active","sampleCount":1}')

            def do_POST(self):
                """Return the integrity-checkable private archive."""
                self.respond("POST", archive())

            def do_DELETE(self):
                """Confirm the archive exists before the clear request arrives."""
                if not destination.exists():
                    self.send_error(500)
                    return
                self.respond("DELETE", b'{"state":"cleared"}')

            def log_message(self, format, *args):
                """Keep synthetic request headers out of test output."""

        server = ThreadingHTTPServer(("127.0.0.1", 0), GatewayHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.entry["data"]["url"] = "http://127.0.0.1:" + str(server.server_port)
        self.write_entries([self.entry])
        try:
            result = subprocess.run([sys.executable, str(SOURCE), "--config", str(self.config),
                                     "--output", str(self.destination), "--clear"],
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.destination.read_bytes(), archive())
            self.assertEqual(methods, [(method, "Bearer synthetic-private-secret") for method in ["GET", "POST", "DELETE"]])
            self.assertNotIn("synthetic-private-secret", result.stdout + result.stderr)
            self.assertEqual(self.destination.stat().st_mode & 0o777, 0o600)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)


if __name__ == "__main__":
    unittest.main()
