"""Validate private bundle inspection and output without real accounts or media.

Synthetic gzip archives and temporary paths own all evidence. The product tool
consumes only bytes and never extracts or executes content during inspection.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


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


if __name__ == "__main__":
    unittest.main()
