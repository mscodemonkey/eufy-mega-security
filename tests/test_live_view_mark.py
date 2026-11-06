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
               and node.name in {"_view_of", "_with_view", "_new_view", "_view_for", "_carries_audio"}]
    camera = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "EufyGatewayCamera")
    hooks = [node for node in camera.body if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef))
             and node.name in {"async_create_stream", "_async_refresh_stream_source", "_async_hold_view",
                               "_begin_recording_hold", "stream_source"}]
    base = type("CameraBase", (), {"async_create_stream": AsyncMock()})
    cls = ast.ClassDef(name="TestCamera", bases=[ast.Name(id="CameraBase", ctx=ast.Load())], keywords=[], body=hooks, decorator_list=[])
    module = ast.fix_missing_locations(ast.Module(body=[*helpers, cls], type_ignores=[]))
    namespace = {"CameraBase": base, "Stream": object, "StreamOutput": object, "GatewayClientError": RuntimeError, "_LOGGER": Mock(),
                 "asyncio": asyncio, "STREAM_URL_RENEWAL_TIMEOUT": 0.02, "LIVE_VIEW_QUERY": "view", "secrets": secrets,
                 "RECORDING_HOLD_MARGIN": 0, "CONF_USE_WALLCLOCK_AS_TIMESTAMPS": "wallclock",
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
        self.camera.camera = {"stream": {"state": "streaming"}}
        self.camera.hass = object()
        self.camera._async_stream_url = AsyncMock(return_value=URL)
        self.camera.serial = "demo"
        self.coordinator = SimpleNamespace(client=SimpleNamespace(hold_live_view=AsyncMock(return_value=True)), recording_holds=set())
        self.camera.coordinator = self.coordinator
        self.stream = SimpleNamespace(source=URL, available=True, update_source=Mock(), outputs=Mock(return_value={}),
                                      add_provider=Mock(return_value=SimpleNamespace(idle_timer=Mock())),
                                      dynamic_stream_settings=SimpleNamespace(preload_stream=False))
        self.base.async_create_stream.return_value = self.stream

    def _view(self, url: str) -> str | None:
        return self.namespace["_view_of"](url)

    async def test_a_person_returning_to_a_camera_that_lost_its_call_gets_a_new_stream(self) -> None:
        old = SimpleNamespace(stop=AsyncMock(), outputs=Mock(return_value={"hls": object()}),
                              dynamic_stream_settings=SimpleNamespace(preload_stream=False))
        self.camera.stream = old
        self.camera.camera = {"stream": {"state": "idle"}}
        self.assertIs(await self.camera.async_create_stream(), self.stream)
        old.stop.assert_awaited_once()
        self.assertIsNone(self.camera.stream)

    async def test_a_starting_preloaded_or_recording_stream_is_kept(self) -> None:
        for state, preload, outputs in (("starting", False, {"hls": 1}), ("idle", True, {"hls": 1}), ("idle", False, {"recorder": 1})):
            old = SimpleNamespace(stop=AsyncMock(), outputs=Mock(return_value=outputs),
                                  dynamic_stream_settings=SimpleNamespace(preload_stream=preload))
            self.camera.stream = old
            self.camera.camera = {"stream": {"state": state}}
            await self.camera.async_create_stream()
            old.stop.assert_not_awaited()

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

    def _camera_b(self):
        """A second camera on the same gateway, opened by a person."""
        other = self.namespace["TestCamera"]()
        other.camera = {"streamSupported": True, "liveAudioSupported": False}
        other.stream_options = {}
        other._native_video = True
        other._async_stream_url = AsyncMock(return_value=URL.replace("demo", "other"))
        other.coordinator = self.coordinator
        return other

    def _recording_view(self) -> list[str]:
        """Make camera A a running marked view whose recorder adds are logged."""
        self.camera.stream = self.stream
        self.stream.outputs.return_value = {"hls": object()}
        self.stream.source = self.namespace["_with_view"](URL, "running-mark-000000")
        order: list[str] = []

        async def async_record(video_path: str, duration: int = 30, lookback: int = 5) -> None:
            self.stream.add_provider("recorder", duration)
            order.append("recorder added")

        self.stream.async_record = async_record
        self.camera.hass = SimpleNamespace(async_create_task=Mock())
        return order

    async def test_camera_b_opened_while_a_slow_hold_is_pending_gets_no_mark(self) -> None:
        order = self._recording_view()
        answer = asyncio.get_running_loop().create_future()

        async def hold(serial: str, view: str) -> bool:
            order.append(f"hold {serial} {view}")
            return await answer

        self.coordinator.client.hold_live_view = hold
        await self.camera.async_create_stream()
        recording = asyncio.ensure_future(self.stream.async_record("/media/clip.mp4", duration=30, lookback=5))
        await asyncio.sleep(0)

        # The gateway refuses an unmarked view while A has the call, so B cannot take it.
        self.assertIsNone(self._view(await self._camera_b().stream_source()))
        self.assertEqual(order, ["hold demo running-mark-000000"])
        answer.set_result(True)
        await recording
        self.assertEqual(order, ["hold demo running-mark-000000", "recorder added"])
        self.assertIsNone(self._view(self.stream.source))
        self.assertEqual(self.coordinator.recording_holds, set())
        self.assertIsNotNone(self._view(await self._camera_b().stream_source()))
        self.camera.hass.async_create_task.assert_not_called()

    async def test_a_rejected_or_failed_hold_records_and_keeps_new_views_unmarked(self) -> None:
        for outcome in (False, RuntimeError("gateway"), ValueError("body")):
            order = self._recording_view()
            self.coordinator.client.hold_live_view = AsyncMock(**({"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome}))
            await self.camera.async_create_stream()
            await self.stream.async_record("/media/clip.mp4", duration=0.05, lookback=0)
            self.assertEqual(order, ["recorder added"])
            self.assertIsNone(self._view(await self._camera_b().stream_source()))
            await asyncio.sleep(0.1)
            self.assertEqual(self.coordinator.recording_holds, set())
            self.assertIsNotNone(self._view(await self._camera_b().stream_source()))
            self.camera._hls_idle_stream = None

    async def test_a_recorder_added_directly_keeps_new_views_unmarked_until_the_hold_answers(self) -> None:
        self._recording_view()
        tasks: list = []
        self.camera.hass = SimpleNamespace(async_create_task=lambda coro: tasks.append(asyncio.ensure_future(coro)))
        await self.camera.async_create_stream()
        self.stream.add_provider("recorder", 30)
        self.assertIsNone(self._view(self.stream.source))
        self.assertEqual(len(self.coordinator.recording_holds), 1)
        await tasks[0]
        self.coordinator.client.hold_live_view.assert_awaited_once_with("demo", "running-mark-000000")
        self.assertEqual(self.coordinator.recording_holds, set())

    async def test_a_recording_that_starts_its_stream_sends_no_hold(self) -> None:
        self.camera.stream = None
        self.stream.source = self.namespace["_new_view"](URL)
        recorded = AsyncMock()
        self.stream.async_record = recorded
        await self.camera.async_create_stream()
        await self.stream.async_record("/media/clip.mp4")
        self.coordinator.client.hold_live_view.assert_not_awaited()
        recorded.assert_awaited_once()
        self.assertEqual(self.coordinator.recording_holds, set())

    async def test_a_recording_on_an_unmarked_stream_sends_no_hold(self) -> None:
        self.camera.stream = self.stream
        self.stream.outputs.return_value = {"hls": object()}
        self.camera.hass = SimpleNamespace(async_create_task=Mock())
        await self.camera.async_create_stream()
        self.stream.add_provider("recorder", 30)
        self.camera.hass.async_create_task.assert_not_called()


if __name__ == "__main__":
    unittest.main()
