"""Check private E10 producer input and failure handling without household I/O.

Tests own temporary connection files and HTTP/output doubles. The real go2rtc
consumer qualification is separate from these security and cleanup regressions.
"""
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import URLError

SOURCE = Path(__file__).parents[1] / "eufy_event_gateway/scripts/e10-go2rtc-source.py"
SPEC = importlib.util.spec_from_file_location("e10_go2rtc_source", SOURCE)
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)


class E10Go2rtcSourceTest(unittest.TestCase):
    """Keep credentials private and release one original response on consumer failure."""

    def test_private_file_and_exact_route_are_required(self):
        """Reject readable secrets, symlinks, malformed routes and header injection."""
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "connection.json"
            valid = {"schema": 1, "url": "http://gateway.invalid/api/cameras/synthetic-e10/live.h264", "token": "synthetic_saved_token_12345678"}
            path.write_text(json.dumps(valid))
            path.chmod(0o600)
            self.assertEqual(TOOL.read_connection(path), (valid["url"], valid["token"]))
            for change in [{"schema": True}, {"token": valid["token"] + "\r\nX: injected"},
                           {"url": valid["url"] + "?access_token=secret"},
                           {"url": "http://user:secret@gateway.invalid/api/cameras/synthetic-e10/live.h264"},
                           {"url": "http://gateway.invalid/api/cameras/other%2Fcamera/live.h264"}]:
                path.write_text(json.dumps({**valid, **change}))
                with self.assertRaises(TOOL.SourceError):
                    TOOL.read_connection(path)
            path.write_text(json.dumps(valid))
            path.chmod(0o644)
            with self.assertRaises(TOOL.SourceError):
                TOOL.read_connection(path)
            path.chmod(0o600)
            link = path.with_name("alias.json")
            link.symlink_to(path)
            with self.assertRaises(OSError):
                TOOL.read_connection(link)

    def test_consumer_failure_closes_response_without_retry(self):
        """A broken stdout releases the owning HTTP response and never opens another."""
        response = Mock(status=200)
        response.headers.get_content_type.return_value = "video/h264"
        response.read1.return_value = b"synthetic-video"
        context = Mock()
        context.__enter__ = Mock(return_value=response)
        context.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = context
        output = Mock()
        output.write.side_effect = BrokenPipeError()
        with patch.object(TOOL, "read_connection", return_value=("http://gateway.invalid/api/cameras/demo/live.h264", "synthetic-token")), patch.object(TOOL, "build_opener", return_value=opener):
            with self.assertRaises(BrokenPipeError):
                TOOL.stream_source(Path("unused"), output)
        opener.open.assert_called_once()
        context.__exit__.assert_called_once()

    def test_http_failure_never_prints_the_private_exception(self):
        """go2rtc receives fixed errors and no credential-bearing URL or payload."""
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(TOOL, "stream_source", side_effect=URLError("private-token-private-url")), patch.object(TOOL.signal, "signal"), redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(TOOL.main(["--connection", "unused"]), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn("private-token", stderr.getvalue())
        self.assertNotIn("private-url", stderr.getvalue())
