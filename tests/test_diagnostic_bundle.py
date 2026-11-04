"""Validate private bundle inspection and output without real accounts or media.

Synthetic gzip archives and temporary paths own all evidence. The product tool
consumes only bytes and never extracts or executes content during inspection.
"""

from __future__ import annotations

import base64
from contextlib import redirect_stderr, redirect_stdout
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError


SOURCE = Path(__file__).parents[1] / "eufy_event_gateway/scripts/diagnostic-bundle.py"
SPEC = importlib.util.spec_from_file_location("diagnostic_bundle", SOURCE)
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)


def evidence() -> dict:
    """Build one native AAC chunk with a verifiable byte count and checksum."""
    data = b"synthetic-audio"
    return {"schema": "eufy-diagnostics-1", "summary": {}, "capture": {"mediaBytes": len(data)},
            "stages": {}, "records": [{"offsetMs": 1, "event": "fixture"}],
            "media": [{"offsetMs": 2, "device": "device-1", "kind": "audio", "codec": "aac",
                       "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                       "base64": base64.b64encode(data).decode()}]}


def encoded(value: dict) -> bytes:
    """Compress one synthetic gateway-shaped archive."""
    return gzip.compress(json.dumps(value).encode())


class DiagnosticBundleTests(unittest.TestCase):
    """Exercise integrity, resource and private-file boundaries offline."""

    def test_valid_and_corrupt_media(self):
        """Reject checksum or manifest drift instead of accepting plausible JSON."""
        value = evidence()
        result = TOOL.inspect_archive(encoded(value))
        self.assertEqual(result["kinds"], {"audio": 1})
        self.assertNotIn("synthetic", json.dumps(result))
        value["media"][0]["base64"] = base64.b64encode(b"changed").decode()
        with self.assertRaises(TOOL.DiagnosticError):
            TOOL.inspect_archive(encoded(value))
        value = evidence()
        value["capture"]["mediaBytes"] = 0
        with self.assertRaises(TOOL.DiagnosticError):
            TOOL.inspect_archive(encoded(value))

    def test_limits_truncation_and_unapproved_members(self):
        """Reject concatenated gzip, truncated data, excessive expansion and bad timing."""
        body = encoded(evidence())
        for invalid in [body[:-1], body + body]:
            with self.assertRaises(TOOL.DiagnosticError):
                TOOL.inspect_archive(invalid)
        prior = TOOL.MAX_JSON
        try:
            TOOL.MAX_JSON = 16
            with self.assertRaises(TOOL.DiagnosticError):
                TOOL.inspect_archive(body)
        finally:
            TOOL.MAX_JSON = prior
        for offset in [-1, float("nan"), 60001, True]:
            value = evidence()
            value["media"][0]["offsetMs"] = offset
            with self.assertRaises(TOOL.DiagnosticError):
                TOOL.inspect_archive(encoded(value))
        value = evidence()
        value["credentials"] = "never"
        with self.assertRaises(TOOL.DiagnosticError):
            TOOL.inspect_archive(encoded(value))

    def test_private_file_permissions_and_preservation(self):
        """Save exclusively and refuse symlinks, public directories and existing files."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            config = root / ".storage/core.config_entries"
            target = root / "bundle.json.gz"
            body = encoded(evidence())
            TOOL.save_archive(config, target, body)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(TOOL.read_archive(target), body)
            with self.assertRaises(Exception):
                TOOL.save_archive(config, target, body)
            self.assertEqual(target.read_bytes(), body)
            link = root / "link"
            link.symlink_to(target)
            with self.assertRaises(OSError):
                TOOL.read_archive(link)
            for name in ["www", "public", "static"]:
                folder = root / name
                folder.mkdir()
                with self.assertRaises(Exception):
                    TOOL.save_archive(config, folder / "bundle.gz", body)
                self.assertFalse((folder / "bundle.gz").exists())

    def test_home_assistant_config_alias_is_supported_without_following_nested_links(self):
        """Allow the standard /config alias while keeping descendant links refused."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            real = root / "real"
            real.mkdir()
            alias = root / "config"
            alias.symlink_to(real, target_is_directory=True)
            config = alias / ".storage/core.config_entries"
            TOOL.save_archive(config, alias / "bundle.gz", encoded(evidence()))
            self.assertTrue((real / "bundle.gz").is_file())
            (real / "nested").symlink_to(root, target_is_directory=True)
            with self.assertRaises(TOOL.DiagnosticError):
                TOOL.private_output_path(config, alias / "nested/private.gz")
            with self.assertRaises(Exception):
                TOOL.private_output_path(config, alias / "www/private.gz")

    def test_movement_uses_saved_connection_and_closed_result(self):
        """Admit and send one direction without returning a serial or token."""
        calls = []

        def fake_request(url, token, method="GET", value=None):
            calls.append((url, token, method, value))
            if url.endswith("/targets"):
                return json.dumps({"devices": [{"serial": "private-camera", "model": "T8417",
                                                "streamSupported": True}]}).encode()
            if method == "GET":
                return json.dumps({"actions": ["motion", "ptz"], "experimental": True}).encode()
            return json.dumps({"outcome": "acknowledged", "physicalConfirmationRequired": True}).encode()

        original = TOOL.request
        TOOL.request = fake_request
        try:
            result = TOOL.movement_test("http://gateway.invalid", "private-token",
                                        [{"serial": "private-camera", "model": "T8417",
                                          "streamSupported": True}], 1, "left")
        finally:
            TOOL.request = original
        self.assertEqual(result["outcome"], "acknowledged")
        self.assertNotIn("private-camera", json.dumps(result))
        self.assertEqual(calls[-2][2:], ("GET", None))
        self.assertEqual(calls[-1][2:], ("POST", {"action": "ptz", "direction": "left"}))

    def test_movement_refuses_missing_admission_and_bad_selection(self):
        """Refuse a command unless the current gateway explicitly admits PTZ."""
        with self.assertRaises(TOOL.DiagnosticError):
            TOOL.selected_device([], 1)
        original = TOOL.request
        TOOL.request = lambda *_args, **_kwargs: json.dumps({"actions": ["motion"]}).encode()
        try:
            with self.assertRaises(TOOL.DiagnosticError):
                TOOL.movement_test("http://gateway.invalid", "private-token",
                                   [{"serial": "private-camera"}], 1, "left")
        finally:
            TOOL.request = original

    def test_movement_reports_closed_admission_reason_without_private_values(self):
        """Explain a pre-command refusal using only the gateway's allowlisted reason."""
        original = TOOL.request
        TOOL.request = lambda *_args, **_kwargs: json.dumps({
            "actions": [], "experimental": True, "unavailableReason": "owner_account_required",
            "private": "must-not-escape",
        }).encode()
        try:
            with self.assertRaisesRegex(TOOL.DiagnosticError, "configured account does not own") as failure:
                TOOL.movement_test("http://private.invalid", "private-token",
                                   [{"serial": "private-camera"}], 1, "left")
        finally:
            TOOL.request = original
        message = str(failure.exception)
        for private in ("private-camera", "private-token", "private.invalid", "must-not-escape"):
            self.assertNotIn(private, message)

    def test_movement_separates_admission_and_post_failures(self):
        """Tell a refusal before dispatch from a failure after movement admission."""
        original = TOOL.request

        def admission_failure(*_args, **_kwargs):
            raise TOOL.DiagnosticError("private admission detail")

        TOOL.request = admission_failure
        try:
            with self.assertRaisesRegex(TOOL.DiagnosticError, "before any command was sent"):
                TOOL.movement_test("http://private.invalid", "private-token",
                                   [{"serial": "private-camera"}], 1, "left")

            def post_failure(_url, _token, method="GET", value=None):
                if method == "GET":
                    return json.dumps({"actions": ["ptz"], "experimental": True}).encode()
                raise TOOL.DiagnosticError("private post detail")

            TOOL.request = post_failure
            with self.assertRaisesRegex(TOOL.DiagnosticError, "model_control_trial_failed"):
                TOOL.movement_test("http://private.invalid", "private-token",
                                   [{"serial": "private-camera"}], 1, "left")
        finally:
            TOOL.request = original

    def test_movement_admission_preserves_only_safe_http_status(self):
        """Distinguish rejected reads without leaking response bodies or URLs."""
        for status in (401, 403, 404, 409, 500, 503):
            with self.subTest(status=status):
                error = HTTPError("http://private.invalid/camera", status,
                                  "private reason", {}, io.BytesIO(b"private response"))
                with patch.object(TOOL, "build_opener") as opener:
                    opener.return_value.open.side_effect = error
                    with self.assertRaisesRegex(TOOL.DiagnosticError, f"HTTP {status}") as failure:
                        TOOL.movement_test("http://private.invalid", "private-token",
                                           [{"serial": "private-camera"}], 1, "left")
                message = str(failure.exception)
                self.assertIn("before any command was sent", message)
                for value in ("private.invalid", "private-token", "private-camera",
                              "private reason", "private response"):
                    self.assertNotIn(value, message)

    def test_movement_admission_distinguishes_invalid_json_and_connection(self):
        """Malformed successful replies differ from a missing HTTP response."""
        with patch.object(TOOL, "request", return_value=b"not json"):
            with self.assertRaisesRegex(TOOL.DiagnosticError, "invalid movement admission"):
                TOOL.movement_test("http://private.invalid", "private-token",
                                   [{"serial": "private-camera"}], 1, "left")
        with patch.object(TOOL, "build_opener") as opener:
            opener.return_value.open.side_effect = URLError("private connection")
            with self.assertRaisesRegex(TOOL.DiagnosticError, "connection failed") as failure:
                TOOL.movement_test("http://private.invalid", "private-token",
                                   [{"serial": "private-camera"}], 1, "left")
        self.assertNotIn("private connection", str(failure.exception))

    def test_read_only_movement_check_never_posts(self):
        """The CLI can inspect admission without consent or camera movement."""
        def respond(url, _token, method="GET", value=None):
            self.assertEqual(method, "GET")
            self.assertIsNone(value)
            if url.endswith("/targets"):
                return json.dumps({"devices": [{"serial": "private-camera"}]}).encode()
            return json.dumps({"actions": ["ptz"], "private": "must-not-escape"}).encode()

        output = io.StringIO()
        with patch.object(TOOL.HELPERS, "gateway_connection", return_value=("http://private.invalid", "private-token")), \
                patch.object(TOOL, "request", side_effect=respond) as request, redirect_stdout(output):
            self.assertEqual(TOOL.main(["movement-check", "--target-index", "1"]), 0)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(json.loads(output.getvalue()), {"movementAdmitted": True, "commandSent": False})

    def test_main_prints_safe_diagnostic_errors(self):
        """Show actionable fixed text while retaining the generic unexpected-error boundary."""
        original = TOOL.run
        TOOL.run = lambda _options: (_ for _ in ()).throw(TOOL.DiagnosticError("Safe fixed explanation."))
        output = io.StringIO()
        try:
            with redirect_stderr(output):
                self.assertEqual(TOOL.main(["list"]), 1)
        finally:
            TOOL.run = original
        self.assertEqual(output.getvalue(), "Safe fixed explanation.\n")


if __name__ == "__main__":
    unittest.main()
