"""Check the view mark that lets an ordinary view move an NVR's one call."""

from __future__ import annotations

import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock
from urllib.parse import parse_qsl, parse_qs, urlencode, urlsplit, urlunsplit
import secrets


SOURCE = Path(__file__).parents[1] / "custom_components" / "eufy_event_gateway" / "camera.py"
URL = "http://gateway:3000/api/cameras/demo/live-native.annexb?access_token=a.b%2Bc"


def _load() -> tuple[dict, type]:
    """Load the real helpers and stream hook without a Home Assistant runtime."""
    tree = ast.parse(SOURCE.read_text())
    helpers = [node for node in tree.body if isinstance(node, ast.FunctionDef)
               and node.name in {"_view_of", "_with_view", "_new_view"}]
    camera = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "EufyGatewayCamera")
    hooks = [node for node in camera.body if isinstance(node, ast.AsyncFunctionDef)
             and node.name in {"async_create_stream", "_async_refresh_stream_source"}]
    base = type("CameraBase", (), {"async_create_stream": AsyncMock()})
    cls = ast.ClassDef(name="TestCamera", bases=[ast.Name(id="CameraBase", ctx=ast.Load())], keywords=[], body=hooks, decorator_list=[])
    module = ast.fix_missing_locations(ast.Module(body=[*helpers, cls], type_ignores=[]))
    namespace = {"CameraBase": base, "Stream": object, "StreamOutput": object, "GatewayClientError": RuntimeError, "_LOGGER": Mock(),
                 "asyncio": asyncio, "STREAM_URL_RENEWAL_TIMEOUT": 0.02, "LIVE_VIEW_QUERY": "view", "secrets": secrets,
                 "parse_qsl": parse_qsl, "urlencode": urlencode, "urlsplit": urlsplit, "urlunsplit": urlunsplit}
    exec(compile(module, str(SOURCE), "exec"), namespace)
    return namespace, base


class LiveViewMarkTest(unittest.IsolatedAsyncioTestCase):
    """Marks follow a person's open, never a reconnect, preload or recording."""

    def setUp(self) -> None:
        self.namespace, self.base = _load()
        self.camera = self.namespace["TestCamera"]()
        self.camera._short_hls_idle = False
        self.camera._native_video = False
        self.camera._fast_native_hls = False
        self.camera._hls_idle_stream = None
        self.camera._stream_source_refreshing = False
        self.camera.is_streaming = True
        self.camera.hass = object()
        self.camera._async_stream_url = AsyncMock(return_value=URL)
        self.stream = SimpleNamespace(source=URL, available=True, update_source=Mock(), outputs=Mock(return_value={}),
                                      add_provider=Mock(return_value=SimpleNamespace(idle_timer=Mock())),
                                      dynamic_stream_settings=SimpleNamespace(preload_stream=False))
        self.base.async_create_stream.return_value = self.stream

    def _view(self, url: str) -> str | None:
        return self.namespace["_view_of"](url)

    async def test_a_person_returning_to_a_camera_that_lost_its_call_gets_a_new_view(self) -> None:
        self.camera.stream = self.stream
        self.camera.is_streaming = False
        self.stream.outputs.return_value = {"hls": object()}
        await self.camera.async_create_stream()
        self.stream.update_source.assert_called_once()
        self.assertIsNotNone(self._view(self.stream.update_source.call_args.args[0]))

    def test_mark_keeps_the_signed_token_and_can_be_removed(self) -> None:
        marked = self.namespace["_new_view"](URL)
        self.assertEqual(parse_qs(urlsplit(marked).query)["access_token"], ["a.b+c"])
        self.assertRegex(self._view(marked), r"^[A-Za-z0-9_-]{16,64}$")
        self.assertNotEqual(self._view(marked), self._view(self.namespace["_new_view"](URL)))
        self.assertIsNone(self._view(self.namespace["_with_view"](marked, None)))
        self.assertEqual(self.namespace["_new_view"]("http://gateway:3000/live.h264").count("?"), 1)

    async def test_reopening_an_idle_stream_gets_a_new_mark(self) -> None:
        self.camera.stream = self.stream
        await self.camera.async_create_stream()
        self.assertIsNotNone(self._view(self.stream.source))
        self.stream.update_source.assert_not_called()

    async def test_coming_back_to_a_camera_that_lost_the_call_restarts_it_now(self) -> None:
        self.camera.stream = self.stream
        self.stream.outputs.return_value = {"hls": object()}
        self.stream.available = False
        await self.camera.async_create_stream()
        self.stream.update_source.assert_called_once()
        self.assertIsNotNone(self._view(self.stream.update_source.call_args.args[0]))

    async def test_a_running_view_is_left_alone(self) -> None:
        self.camera.stream = self.stream
        self.stream.outputs.return_value = {"hls": object()}
        await self.camera.async_create_stream()
        self.camera._async_stream_url.assert_not_awaited()
        self.stream.update_source.assert_not_called()

    async def test_renewal_keeps_the_same_mark_so_a_retry_cannot_take_the_call(self) -> None:
        self.camera.stream = self.stream
        self.stream.outputs.return_value = {"hls": object()}
        self.stream.source = self.namespace["_with_view"](URL, "kept-mark-0000000000")
        await self.camera._async_refresh_stream_source(None)
        self.assertEqual(self._view(self.stream.source), "kept-mark-0000000000")

    async def test_preload_streams_are_not_marked(self) -> None:
        self.camera.stream = None
        self.stream.source = self.namespace["_new_view"](URL)
        self.stream.dynamic_stream_settings.preload_stream = True
        await self.camera.async_create_stream()
        self.assertIsNone(self._view(self.stream.source))

    async def test_a_recording_is_not_marked(self) -> None:
        self.camera.stream = None
        self.stream.source = self.namespace["_new_view"](URL)
        await self.camera.async_create_stream()
        self.stream.add_provider("recorder", 30)
        self.assertIsNone(self._view(self.stream.source))


if __name__ == "__main__":
    unittest.main()
