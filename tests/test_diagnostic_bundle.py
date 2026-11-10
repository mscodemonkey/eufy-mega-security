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
    """Exercise local transfers and private-file boundaries with isolated fixtures."""

    def test_s220_settings_summary_reads_cached_state_without_commands(self):
        """Expose only closed availability facts, never serials, settings or tokens."""
        camera = {"serial": "private-camera", "model": "T8134", "streamingQualityControlSupported": False,
                  "motionSensitivityControlSupported": False, "reportedSettings": {}, "streamingQualityModes": [],
                  "name": "private-name", "private": "private-token"}
        target = {"serial": "private-camera", "model": "T8134"}
        for current in [None, 0, 1, 2, 3, True, 9]:
            camera["reportedSettings"] = {"streamingQualityTier": current}
            with patch.object(TOOL, "request", return_value=json.dumps({"cameras": [camera]}).encode()) as request:
                summary = TOOL.s220_settings_check("http://private.invalid", "private-token", target)
                self.assertEqual(summary["qualityCurrentKnown"], type(current) is int and 0 <= current <= 3)
                self.assertFalse(summary["commandSent"])
                self.assertFalse(summary["qualityControlAvailable"])
                self.assertNotIn("private", json.dumps(summary))
                request.assert_called_once_with("http://private.invalid/api/cameras", "private-token")
        camera.update({"streamingQualityControlSupported": True, "motionSensitivityControlSupported": True,
                       "reportedSettings": {"streamingQualityTier": 2, "motionSensitivityStep": 4},
                       "streamingQualityModes": [{"value": 0, "name": "Auto"}, {"value": 2, "name": "Medium"}]})
        with patch.object(TOOL, "request", return_value=json.dumps({"cameras": [camera]}).encode()):
            self.assertEqual(TOOL.s220_settings_check("http://private.invalid", "private-token", target),
                             {"model": "T8134", "qualityControlAvailable": True, "qualityCurrentKnown": True,
                              "qualityChoiceCount": 2, "sensitivityControlAvailable": True,
                              "sensitivityCurrentKnown": True, "commandSent": False})
        for rows in [[], [camera, camera], [{**camera, "model": "T8134X"}], [{**camera, "streamingQualityModes": "private"}]]:
            with patch.object(TOOL, "request", return_value=json.dumps({"cameras": rows}).encode()):
                with self.assertRaisesRegex(TOOL.DiagnosticError, "No camera command was sent"):
                    TOOL.s220_settings_check("http://private.invalid", "private-token", target)
        with patch.object(TOOL, "request") as request:
            with self.assertRaises(TOOL.DiagnosticError):
                TOOL.s220_settings_check("http://private.invalid", "private-token", {**target, "model": "T8134X"})
            request.assert_not_called()

    def test_spotlight_read_never_falls_back_to_a_write(self):
        """Use one exact read action and expose only a closed state observation."""
        target = {"model": "T8110", "serial": "private-camera"}
        for summary in ({"outcome": "reported", "readOnly": True, "spotlightEnabled": False},
                        {"outcome": "reported", "readOnly": True, "spotlightEnabled": True},
                        {"outcome": "unavailable", "readOnly": True, "reason": "no_reply"},
                        {"outcome": "unavailable", "readOnly": True, "reason": "protection_mismatch"},
                        {"outcome": "unavailable", "readOnly": True, "reason": "authentication_failed"}):
            with patch.object(TOOL, "request", return_value=json.dumps(summary).encode()) as request:
                self.assertEqual(TOOL.spotlight_read_check("http://private.invalid", "private-token", target),
                                 {"model": "T8110", **summary, "lightCommandSent": False})
                request.assert_called_once_with("http://private.invalid/api/cameras/private-camera/model-control-trial",
                    "private-token", "POST", {"action": "spotlightState", "enabled": False}, timeout=50, transfer_seconds=50)
        for status in (400, 409, 503):
            with patch.object(TOOL, "request", side_effect=TOOL.DiagnosticRequestError(status)) as request:
                with self.assertRaises(TOOL.DiagnosticError):
                    TOOL.spotlight_read_check("http://private.invalid", "private-token", target)
                self.assertEqual(request.call_count, 1)

    def test_spotlight_read_consent_selection_and_response_are_strict(self):
        """Missing consent cannot load secrets and malformed observations stay private."""
        with patch.object(TOOL.HELPERS, "gateway_connection") as connection, redirect_stderr(io.StringIO()):
            self.assertEqual(TOOL.main(["spotlight-read-check", "--target-index", "1"]), 1)
            connection.assert_not_called()
        with patch.object(TOOL, "request") as request:
            with self.assertRaises(TOOL.DiagnosticError):
                TOOL.spotlight_read_check("http://private.invalid", "private-token", {"model": "T8110S", "serial": "private"})
            request.assert_not_called()
        for summary in [[], {"outcome": "confirmed"},
                        {"outcome": "reported", "readOnly": True, "spotlightEnabled": 1},
                        {"outcome": "reported", "readOnly": True, "spotlightEnabled": False, "token": "private"},
                        {"outcome": "unavailable", "readOnly": True, "reason": "private"}]:
            with patch.object(TOOL, "request", return_value=json.dumps(summary).encode()):
                with self.assertRaisesRegex(TOOL.DiagnosticError, "invalid spotlight state-read summary"):
                    TOOL.spotlight_read_check("http://private.invalid", "private-token", {"model": "T8110", "serial": "private"})

    def test_recording_index_default_is_one_recent_read_and_partial_window_is_refused(self):
        """The ordinary check needs no timestamp, while historical input stays explicit."""
        summary = {"outcome": "empty", "windowMatches": True, "ownerMatches": True,
                   "valid": 0, "invalid": 0, "overlapping": 0}
        with patch.object(TOOL, "request", return_value=json.dumps(summary).encode()) as request:
            TOOL.recording_index_check("http://private.invalid", "private-token", {"model": "T817L", "serial": "private"})
            self.assertEqual(request.call_args.args[3], {"consentReadRecordingIndex": True})
            self.assertEqual(request.call_count, 1)
        with patch.object(TOOL.HELPERS, "gateway_connection") as connection, redirect_stderr(io.StringIO()):
            self.assertEqual(TOOL.main(["recording-index-check", "--target-index", "1", "--consent-read", "--begin-time", "1800000000"]), 1)
            connection.assert_not_called()

    def test_recording_index_check_uses_one_selected_window_and_only_returns_counts(self):
        """The helper keeps the selected historical interval out of terminal output."""
        now = 1800000000
        target = {"serial": "private-camera", "model": "T817L"}
        summary = {"outcome": "intervals", "windowMatches": True, "ownerMatches": True,
                   "valid": 1, "invalid": 0, "overlapping": 1}
        output = io.StringIO()
        with patch.object(TOOL.time, "time", return_value=now), \
                patch.object(TOOL.HELPERS, "gateway_connection", return_value=("http://private.invalid", "private-token")), \
                patch.object(TOOL, "devices", return_value=[target]), \
                patch.object(TOOL, "request", return_value=json.dumps(summary).encode()) as request, redirect_stdout(output):
            self.assertEqual(TOOL.main(["recording-index-check", "--target-index", "1", "--consent-read",
                                       "--begin-time", str(now - 7500), "--end-time", str(now - 7200)]), 0)
        self.assertEqual(json.loads(output.getvalue()), {"model": "T817L", **summary, "playbackConfirmed": False})
        request.assert_called_once_with("http://private.invalid/api/cameras/private-camera/recording-index-trial",
                                        "private-token", "POST", {"consentReadRecordingIndex": True,
                                        "beginTime": now - 7500, "endTime": now - 7200}, timeout=50, transfer_seconds=50)
        for value in ("private-camera", "private-token", "private.invalid", str(now - 7500)):
            self.assertNotIn(value, output.getvalue())

    def test_recording_index_consent_and_window_fail_before_credentials(self):
        """No omitted consent or invalid time range can contact the gateway."""
        now = 1800000000
        for consent, begin, end in [(False, now - 60, now), (True, now - 86401, now - 86400),
                                   (True, now - 1801, now), (True, now, now + 1)]:
            arguments = ["recording-index-check", "--target-index", "1", "--begin-time", str(begin), "--end-time", str(end)]
            if consent:
                arguments.append("--consent-read")
            with patch.object(TOOL.time, "time", return_value=now), \
                    patch.object(TOOL.HELPERS, "gateway_connection") as connection, \
                    patch.object(TOOL, "request") as request, redirect_stderr(io.StringIO()):
                self.assertEqual(TOOL.main(arguments), 1)
            connection.assert_not_called()
            request.assert_not_called()

    def test_recording_index_refusal_never_retries_or_changes_the_window(self):
        """An old server or refused query must not become a recent-window fallback."""
        now = 1800000000
        for status in (400, 409, 503):
            with patch.object(TOOL.time, "time", return_value=now), \
                    patch.object(TOOL, "request", side_effect=TOOL.DiagnosticRequestError(status)) as request:
                with self.assertRaisesRegex(TOOL.DiagnosticError, "HTTP " + str(status)):
                    TOOL.recording_index_check("http://private.invalid", "private-token",
                                               {"model": "T817L", "serial": "private-camera"}, now - 7500, now - 7200)
                self.assertEqual(request.call_count, 1)

    def test_recording_index_rejects_aliases_private_fields_and_inconsistent_counts(self):
        """Only a matched, closed structural summary can be displayed."""
        now = 1800000000
        valid = {"outcome": "intervals", "windowMatches": True, "ownerMatches": True,
                 "valid": 1, "invalid": 0, "overlapping": 1}
        with patch.object(TOOL.time, "time", return_value=now), patch.object(TOOL, "request") as request:
            with self.assertRaises(TOOL.DiagnosticError):
                TOOL.recording_index_check("http://private.invalid", "private-token", {"model": "T8171"}, now - 7500, now - 7200)
            request.assert_not_called()
        for result in [dict(valid, token="private-token"), dict(valid, valid=True),
                       dict(valid, outcome="empty"), dict(valid, overlapping=2), dict(valid, ownerMatches=False),
                       dict(valid, valid=512, invalid=1), []]:
            with patch.object(TOOL.time, "time", return_value=now), \
                    patch.object(TOOL, "request", return_value=json.dumps(result).encode()):
                with self.assertRaisesRegex(TOOL.DiagnosticError, "invalid recording-index summary"):
                    TOOL.recording_index_check("http://private.invalid", "private-token",
                                               {"model": "T817L", "serial": "private-camera"}, now - 7500, now - 7200)


    def test_e10_clip_uses_saved_token_once_and_keeps_media_private(self):
        """Persist only the explicit E10 clip and report no playback claim or identity."""
        clip = b"\x00\x00\x00\x18ftypisom" + b"private-synthetic-clip"
        target = {"serial": "private-e10", "model": "T8404", "streamSupported": False}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            config, output = root / ".storage/core.config_entries", root / "e10.mp4"
            def reply(url, token, method="GET", value=None, **kwargs):
                self.assertEqual(token, "private-token")
                if url.endswith("/targets"):
                    return json.dumps({"devices": [target]}).encode()
                self.assertEqual(url, "http://private.invalid/api/cameras/private-e10/nvr-live-trial")
                self.assertEqual((method, value), ("POST", {"consentPrivateMedia": True}))
                self.assertEqual(kwargs, {"timeout": 90, "transfer_seconds": 90})
                self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                return clip
            printed = io.StringIO()
            with patch.object(TOOL.HELPERS, "gateway_connection", return_value=("http://private.invalid", "private-token")), patch.object(TOOL, "request", side_effect=reply) as request, redirect_stdout(printed):
                self.assertEqual(TOOL.main(["--config", str(config), "e10-video-test", "--target-index", "1", "--consent-private-media", "--output", str(output)]), 0)
            self.assertEqual(request.call_count, 2)
            self.assertEqual(output.read_bytes(), clip)
            self.assertFalse(json.loads(printed.getvalue())["playbackConfirmed"])
            for private in ["private-token", "private-e10", "private.invalid", "synthetic-clip", str(root)]:
                self.assertNotIn(private, printed.getvalue())

    def test_e10_missing_consent_does_not_load_credentials_or_contact_gateway(self):
        """Keep a media trial impossible without an explicit consent flag."""
        with patch.object(TOOL.HELPERS, "gateway_connection") as connection, patch.object(TOOL, "request") as request, redirect_stderr(io.StringIO()):
            self.assertEqual(TOOL.main(["e10-video-test", "--target-index", "1", "--output", "/unused.mp4"]), 1)
        connection.assert_not_called()
        request.assert_not_called()

    def test_e10_refusal_or_bad_clip_is_not_retried_and_removes_owned_file(self):
        """Retain no partial file, upstream error text, private URL or media on failure."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            config, output = root / ".storage/core.config_entries", root / "e10.mp4"
            target = {"model": "T8404", "serial": "private-e10"}
            for result in [TOOL.DiagnosticRequestError(409), TOOL.DiagnosticError("private upstream body"), b'{"token":"private-token"}', KeyboardInterrupt()]:
                with patch.object(TOOL, "request", side_effect=result if isinstance(result, BaseException) else None,
                                  return_value=result) as request:
                    with self.assertRaises((TOOL.DiagnosticError, KeyboardInterrupt)) as raised:
                        TOOL.e10_video_test("http://private.invalid", "private-token", target, config, output)
                    self.assertNotIn("private upstream", str(raised.exception))
                    self.assertNotIn("private-token", str(raised.exception))
                    self.assertEqual(request.call_count, 1)
                self.assertFalse(output.exists())

    def test_e10_bad_selection_or_unsafe_output_cannot_start_a_trial(self):
        """Refuse wrong model, overwrite, symlinks and public output before POST."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            config, output = root / ".storage/core.config_entries", root / "e10.mp4"
            with patch.object(TOOL, "request") as request:
                with self.assertRaises(TOOL.DiagnosticError):
                    TOOL.e10_video_test("http://private.invalid", "private-token", {"model": "T8404X"}, config, output)
                output.write_bytes(b"keep")
                for path in [output, root / "www/e10.mp4"]:
                    with self.assertRaises(Exception):
                        TOOL.e10_video_test("http://private.invalid", "private-token", {"model": "T8404", "serial": "private-e10"}, config, path)
                link = root / "linked.mp4"
                link.symlink_to(output)
                with self.assertRaises(Exception):
                    TOOL.e10_video_test("http://private.invalid", "private-token", {"model": "T8404", "serial": "private-e10"}, config, link)
                request.assert_not_called()
                self.assertEqual(output.read_bytes(), b"keep")

    def test_motion_time_check_preserves_its_distinct_closed_vocabulary(self):
        """Support the T8910 probe without printing timestamps or accepting binary profiles."""
        target = {"model": "T8910", "serial": "private-motion"}
        for value in ["missing", "unset", "recent", "older", "future", "invalid", "conflicting"]:
            summary = {"model": "T8910", "profile": "motion_time_candidate", "observations": {"1605": value}}
            with patch.object(TOOL, "request", return_value=json.dumps(summary).encode()):
                self.assertEqual(TOOL.parameter_check("http://private.invalid", "private-token", target), summary)
        for value in ["one", "zero", "valid", 1790000000]:
            summary["observations"]["1605"] = value
            with patch.object(TOOL, "request", return_value=json.dumps(summary).encode()):
                with self.assertRaises(TOOL.DiagnosticError):
                    TOOL.parameter_check("http://private.invalid", "private-token", target)

    def test_device_list_comparison_is_explicit_and_keeps_only_closed_fields(self):
        """Select the shared-account list source without exposing either motion instant."""
        target = {"model": "T8910", "serial": "private-motion"}
        summary = {"model": "T8910", "profile": "motion_time_candidate", "observations": {"1605": "recent"},
                   "source": "device_list", "change": "advanced"}
        with patch.object(TOOL, "request", return_value=json.dumps(summary).encode()) as request:
            self.assertEqual(TOOL.parameter_check("http://private.invalid", "private-token", target, True), summary)
            self.assertEqual(request.call_args.args[3]["source"], "device_list")
        for change in ["private", 1790000000, None]:
            with patch.object(TOOL, "request", return_value=json.dumps({**summary, "change": change}).encode()):
                with self.assertRaises(TOOL.DiagnosticError):
                    TOOL.parameter_check("http://private.invalid", "private-token", target, True)
        with patch.object(TOOL, "request") as request:
            with self.assertRaises(TOOL.DiagnosticError):
                TOOL.parameter_check("http://private.invalid", "private-token", {"model": "T8410"}, True)
            request.assert_not_called()

    def test_state_check_uses_saved_connection_without_exposing_credentials(self):
        """Send one consented read and print only the closed model summary."""
        summary = {"model": "T8030", "profile": "alarm_volume_candidate", "observations": {"1235": "missing"}}
        target = {"serial": "private-station", "model": "T8030", "streamSupported": False}

        def reply(url, token, method="GET", value=None, **kwargs):
            if url.endswith("/targets"):
                return json.dumps({"devices": [target]}).encode()
            self.assertEqual((method, value, kwargs), ("POST", {"serial": "private-station", "consent": True}, {"timeout": 35}))
            return json.dumps(summary).encode()

        output = io.StringIO()
        with patch.object(TOOL.HELPERS, "gateway_connection", return_value=("http://private.invalid", "private-token")), patch.object(TOOL, "request", side_effect=reply) as request, redirect_stdout(output):
            self.assertEqual(TOOL.main(["state-check", "--target-index", "1", "--consent-read"]), 0)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(json.loads(output.getvalue()), summary)
        self.assertNotIn("private", output.getvalue())

    def test_state_check_requires_consent_before_loading_the_connection(self):
        """An omitted consent flag sends no read and accesses no stored credential."""
        with patch.object(TOOL.HELPERS, "gateway_connection") as connection, patch.object(TOOL, "request") as request, redirect_stderr(io.StringIO()):
            self.assertEqual(TOOL.main(["state-check", "--target-index", "1"]), 1)
        connection.assert_not_called()
        request.assert_not_called()

    def test_state_check_rejects_unselected_or_private_response_fields(self):
        """Unknown data and another device's result never reach terminal output."""
        valid = {"model": "T8417", "profile": "privacy_candidates", "observations": {"1035": "missing", "2001": "zero", "6250": "one", "6271": "conflicting"}}
        target = {"serial": "private-camera", "model": "T8417"}
        for result in [dict(valid, token="private-token"), dict(valid, model="T8410"), dict(valid, observations={"1035": "private-value"}), dict(valid, observations=[]), []]:
            with patch.object(TOOL, "request", return_value=json.dumps(result).encode()):
                with self.assertRaisesRegex(TOOL.DiagnosticError, "unsupported summary"):
                    TOOL.parameter_check("http://private.invalid", "private-token", target)
        with patch.object(TOOL, "request", return_value=json.dumps(valid).encode()):
            self.assertEqual(TOOL.parameter_check("http://private.invalid", "private-token", target), valid)
        with patch.object(TOOL, "request") as request:
            with self.assertRaises(TOOL.DiagnosticError):
                TOOL.parameter_check("http://private.invalid", "private-token", {"model": "T8134"})
            request.assert_not_called()

    def test_state_check_never_retries_a_refused_read(self):
        """Keep authorization failures fixed and leave the account untouched."""
        with patch.object(TOOL, "request", side_effect=TOOL.DiagnosticRequestError(409)) as request:
            with self.assertRaisesRegex(TOOL.DiagnosticError, "HTTP 409"):
                TOOL.parameter_check("http://private.invalid", "private-token", {"model": "T8030", "serial": "private-station"})
            self.assertEqual(request.call_count, 1)
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
            result = TOOL.save_archive(config, target, body)
            self.assertTrue(result["bundleSaved"])
            self.assertIn("--output", result["next"])
            self.assertNotIn(str(target), json.dumps(result))
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

    def test_movement_post_http_failure_never_retries_or_claims_no_write(self):
        """A lost write result must not imply the camera stayed still."""
        def respond(_url, _token, method="GET", value=None):
            if method == "GET":
                return b'{"actions":["ptz"]}'
            raise TOOL.DiagnosticRequestError(503)

        with patch.object(TOOL, "request", side_effect=respond) as request:
            with self.assertRaisesRegex(TOOL.DiagnosticError, "HTTP 503") as failure:
                TOOL.movement_test("http://private.invalid", "private-token",
                                   [{"serial": "private-camera"}], 1, "left")
        self.assertEqual(request.call_count, 2)
        self.assertNotIn("No command was sent", str(failure.exception))
        self.assertIn("Check the camera", str(failure.exception))

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
