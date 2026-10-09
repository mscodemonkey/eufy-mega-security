"""Exercise the HA recording browser and proxy without importing HA in CI.

The test executes the real platform definitions against borrowed fake HA
boundaries. Synthetic clients own media responses, allowing authentication,
connection changes and error handling to be checked without private devices.
"""

from __future__ import annotations

import ast
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock
from urllib.parse import quote


SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/media_source.py"
DOMAIN = "eufy_event_gateway"


class MediaError(Exception):
    """Stand in for errors crossing the HA media platform boundary."""


class Container:
    """Retain media model fields supplied by the actual integration code."""

    def __init__(self, *args, **kwargs):
        """Accept HA model constructor shapes without changing their values."""
        self.__dict__.update(kwargs)
        if len(args) == 2:
            self.url, self.mime_type = args


class FakeMediaSource:
    """Stand in for the framework's media source base class."""

    def __init__(self, domain):
        """Retain the owning integration domain."""
        self.domain = domain


def load_platform():
    """Execute real definitions with fake imported framework boundaries."""
    tree = ast.parse(SOURCE.read_text())
    tree.body = [node for node in tree.body if not isinstance(node, (ast.Import, ast.ImportFrom))]
    tree.body.insert(0, ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0))
    ast.fix_missing_locations(tree)
    sign = Mock(return_value="/api/private-video.mp4?authSig=ha-owned-signature")
    namespace = {
        "date": date, "timedelta": timedelta, "re": re, "quote": quote, "DOMAIN": DOMAIN,
        "MediaSource": FakeMediaSource, "HomeAssistantView": object,
        "BrowseError": MediaError, "MediaSourceError": MediaError, "Unresolvable": MediaError,
        "GatewayClientError": MediaError, "BrowseMediaSource": Container, "PlayMedia": Container,
        "MediaClass": SimpleNamespace(VIDEO="video", DIRECTORY="directory"),
        "MediaType": SimpleNamespace(PLAYLIST="playlist"), "async_sign_path": sign,
        "dt_util": SimpleNamespace(now=lambda: datetime(2026, 10, 9, tzinfo=timezone.utc),
                                   parse_datetime=datetime.fromisoformat, as_local=lambda value: value),
        "web": SimpleNamespace(HTTPNotFound=MediaError, HTTPBadGateway=MediaError, Response=Container),
    }
    exec(compile(tree, str(SOURCE), "exec"), namespace)
    return namespace


class StoredRecordingTests(unittest.IsolatedAsyncioTestCase):
    """Check real browsing, signing and proxy behavior under entry lifecycle changes."""

    def setUp(self):
        """Create one loaded entry with a verified synthetic camera connection."""
        self.namespace = load_platform()
        self.record_id = "a" * 64
        self.client = SimpleNamespace(
            stored_recordings=AsyncMock(return_value=[{
                "id": self.record_id, "startTime": "2026-10-09T09:05:54+00:00",
            }]), prepare_recording=AsyncMock(),
            recording_media=AsyncMock(return_value=(206, b"345", {"Content-Range": "bytes 3-5/10"})),
        )
        self.coordinator = SimpleNamespace(client=self.client, cameras={
            "synthetic": {"name": "Synthetic camera", "storedRecordingsSupported": True},
        })
        self.entries = [SimpleNamespace(entry_id="entry", runtime_data=SimpleNamespace(coordinator=self.coordinator))]
        self.hass = SimpleNamespace(
            data={}, http=SimpleNamespace(register_view=Mock()),
            config_entries=SimpleNamespace(async_loaded_entries=lambda domain: self.entries),
        )
        self.source = self.namespace["EufyRecordingSource"](self.hass)

    async def test_browse_and_resolve_keep_gateway_credentials_out_of_playback(self):
        """Browse real folders and prepare one opaque clip before HA signs its URL."""
        root = await self.source.async_browse_media(SimpleNamespace(identifier=""))
        self.assertEqual(len(root.children), 1)
        days = await self.source.async_browse_media(SimpleNamespace(identifier="entry/synthetic"))
        self.assertEqual(len(days.children), 14)
        self.assertEqual(days.children[0].identifier, "entry/synthetic/2026-10-09")
        clips = await self.source.async_browse_media(SimpleNamespace(identifier="entry/synthetic/2026-10-09"))
        self.assertEqual(clips.children[0].title, "09:05:54")
        playable = await self.source.async_resolve_media(SimpleNamespace(identifier=clips.children[0].identifier))
        self.client.prepare_recording.assert_awaited_once_with("synthetic", self.record_id)
        self.assertEqual(playable.mime_type, "video/mp4")
        args = self.namespace["async_sign_path"].call_args.args
        self.assertEqual(args[1], f"/api/{DOMAIN}/recordings/entry/synthetic/{self.record_id}.mp4")
        self.assertEqual(args[2], timedelta(minutes=10))
        self.assertNotIn("gateway", playable.url)

    async def test_connection_change_and_unload_revoke_previously_browsed_clip(self):
        """Reject old references immediately after moving or unloading the camera."""
        item = SimpleNamespace(identifier=f"entry/synthetic/2026-10-09/{self.record_id}")
        self.coordinator.cameras["synthetic"]["storedRecordingsSupported"] = False
        with self.assertRaises(MediaError):
            await self.source.async_resolve_media(item)
        self.client.prepare_recording.assert_not_awaited()
        self.entries.clear()
        with self.assertRaises(MediaError):
            await self.source.async_browse_media(SimpleNamespace(identifier="entry/synthetic"))

    async def test_proxy_forwards_ranges_and_rechecks_current_connection(self):
        """Serve only cached bytes under HA authentication, including HEAD."""
        view = self.namespace["EufyRecordingView"](self.hass)
        self.assertTrue(view.requires_auth)
        request = SimpleNamespace(method="GET", headers={"Range": "bytes=3-5"})
        result = await view.get(request, "entry", "synthetic", self.record_id)
        self.assertEqual(result.body, b"345")
        self.assertEqual(result.status, 206)
        self.client.recording_media.assert_awaited_once_with("synthetic", self.record_id, "bytes=3-5", head=False)
        request.method = "HEAD"
        await view.head(request, "entry", "synthetic", self.record_id)
        self.assertTrue(self.client.recording_media.call_args.kwargs["head"])
        self.coordinator.cameras.clear()
        with self.assertRaises(MediaError):
            await view.get(request, "entry", "synthetic", self.record_id)

    async def test_invalid_references_never_reach_the_gateway(self):
        """Reject filesystem paths, malformed IDs and invalid days before I/O."""
        for value in ("entry/synthetic/2026-02-30", "../synthetic", "entry/synthetic/2026-10-09/path", "entry/synthetic/20261009"):
            with self.subTest(value=value), self.assertRaises(MediaError):
                await self.source.async_browse_media(SimpleNamespace(identifier=value))
        self.client.stored_recordings.assert_not_awaited()
        await self.namespace["async_get_media_source"](self.hass)
        await self.namespace["async_get_media_source"](self.hass)
        self.hass.http.register_view.assert_called_once()


class ClientRecordingTests(unittest.IsolatedAsyncioTestCase):
    """Verify gateway media remains bounded and bearer-authenticated inside HA."""

    def setUp(self):
        """Load the actual client with fake transport-only imports."""
        source = SOURCE.with_name("client.py")
        tree = ast.parse(source.read_text())
        tree.body = [node for node in tree.body if isinstance(node, ast.ClassDef)]
        tree.body.insert(0, ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0))
        ast.fix_missing_locations(tree)
        namespace = {
            "re": re, "quote": quote, "ClientTimeout": lambda **kwargs: kwargs,
            "ClientError": OSError, "ClientResponseError": OSError,
        }
        exec(compile(tree, str(source), "exec"), namespace)
        self.error = namespace["GatewayClientError"]
        self.session = SimpleNamespace(request=Mock())
        self.client = namespace["GatewayClient"](self.session, "http://synthetic-gateway", "synthetic-secret")

    async def test_invalid_gateway_references_are_rejected_before_the_browser(self):
        """Do not propagate camera paths or malformed playback identifiers."""
        self.client._json = AsyncMock(return_value={"records": [{"id": "/private/path", "startTime": "today"}]})
        with self.assertRaises(self.error):
            await self.client.stored_recordings("synthetic", "2026-10-09")
        self.client._json = AsyncMock(return_value={"ready": False})
        with self.assertRaises(self.error):
            await self.client.prepare_recording("synthetic", "a" * 64)
        with self.assertRaises(self.error):
            await self.client.recording_media("synthetic", "a" * 64, "bytes=0-1,4-5")
        self.session.request.assert_not_called()

    async def test_proxy_client_preserves_auth_and_only_media_headers(self):
        """Keep gateway credentials in headers and forward one validated range."""
        async def chunks(size):
            yield b"345"

        response = SimpleNamespace(
            status=206, headers={"Content-Type": "video/mp4", "Content-Length": "3",
                                 "Content-Range": "bytes 3-5/10", "Authorization": "must-not-forward"},
            content=SimpleNamespace(iter_chunked=chunks),
        )
        class Context:
            """Borrow one synthetic HTTP response during the request."""

            async def __aenter__(self):
                """Return the response without opening a connection."""
                return response

            async def __aexit__(self, *args):
                """Release the borrowed synthetic response."""
                return False

        self.session.request.return_value = Context()
        status, body, headers = await self.client.recording_media("synthetic", "a" * 64, "bytes=3-5")
        self.assertEqual((status, body), (206, b"345"))
        self.assertNotIn("Authorization", headers)
        self.assertEqual(headers["Cache-Control"], "no-store")
        supplied = self.session.request.call_args.kwargs["headers"]
        self.assertEqual(supplied["Authorization"], "Bearer synthetic-secret")
        self.assertEqual(supplied["Range"], "bytes=3-5")
