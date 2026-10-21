"""Exercise HLS startup cleanup and optional idle timing without a camera.

Tests execute the camera hook against an owned provider factory. Home
Assistant owns viewer timers, checked separately against its actual source.
"""

from __future__ import annotations

import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock


SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/camera.py"


class HlsIdleTest(unittest.IsolatedAsyncioTestCase):
    """Arm startup cleanup while keeping custom timing confined to HLS defaults."""

    def setUp(self) -> None:
        """Load the real hook with a synthetic HA camera base."""
        tree = ast.parse(SOURCE.read_text())
        camera = next(n for n in tree.body if isinstance(n, ast.ClassDef)
                      and n.name == "EufyGatewayCamera")
        method = next(n for n in camera.body if isinstance(n, ast.AsyncFunctionDef)
                      and n.name == "async_create_stream")
        base = type("CameraBase", (), {"async_create_stream": AsyncMock()})
        cls = ast.ClassDef(name="TestCamera", bases=[ast.Name(id="CameraBase", ctx=ast.Load())],
                           keywords=[], body=[method, next(n for n in camera.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "_async_stream_url")], decorator_list=[])
        module = ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[]))
        namespace = {"CameraBase": base, "Stream": object, "StreamOutput": object, "GatewayClientError": RuntimeError, "_LOGGER": Mock(), "asyncio": asyncio, "CAMERA_STREAM_SOURCE_TIMEOUT": 0.02}
        exec(compile(module, str(SOURCE), "exec"), namespace)
        self.base = base
        self.camera = namespace["TestCamera"]()
        self.camera._short_hls_idle = True
        self.camera._native_video = False
        self.camera._hls_idle_stream = None
        self.camera._stream_source_refreshing = False
        self.original = Mock(return_value=SimpleNamespace(idle_timer=Mock()))
        self.stream = SimpleNamespace(add_provider=self.original, outputs=Mock(return_value={"hls": object()}),
                                      source="old", dynamic_stream_settings=SimpleNamespace(preload_stream=False))
        self.camera.stream = self.stream
        self.camera.hass = object()
        self.camera.serial = "demo"
        self.camera.coordinator = SimpleNamespace(client=SimpleNamespace(stream_url=AsyncMock(return_value="fresh")))
        base.async_create_stream.return_value = self.stream

    async def test_reopen_idle_cached_stream_refreshes_before_return(self):
        """A returning viewer gets fresh credentials after idle renewal was skipped."""
        self.stream.outputs.return_value = {}
        self.assertIs(await self.camera.async_create_stream(), self.stream)
        self.assertEqual(self.stream.source, "fresh")
        self.camera.coordinator.client.stream_url.assert_awaited_once_with("demo")

    async def test_reopen_failure_keeps_previous_source(self):
        """A gateway failure does not erase the cached stream or start a worker."""
        self.stream.outputs.return_value = {}
        self.camera.coordinator.client.stream_url.side_effect = RuntimeError("offline")
        self.assertIs(await self.camera.async_create_stream(), self.stream)
        self.assertEqual(self.stream.source, "old")

    async def test_reopen_reply_after_replacement_is_discarded(self):
        """A late explicit reopen cannot mutate a stream removed during its request."""
        self.stream.outputs.return_value = {}
        async def reply(_serial):
            self.camera.stream = None
            return "late"
        self.camera.coordinator.client.stream_url.side_effect = reply
        await self.camera.async_create_stream()
        self.assertEqual(self.stream.source, "old")

    async def test_cached_wrapped_stream_still_refreshes_on_reopen(self):
        """The existing form wrapper must not bypass idle credential refresh."""
        await self.camera.async_create_stream()
        self.stream.outputs.return_value = {}
        await self.camera.async_create_stream()
        self.assertEqual(self.stream.source, "fresh")

    async def test_new_stream_does_not_refresh_twice(self):
        """HA already minted the source for a newly created stream."""
        self.camera.stream = None
        self.stream.outputs.return_value = {}
        await self.camera.async_create_stream()
        self.camera.coordinator.client.stream_url.assert_not_awaited()

    async def test_reopen_timeout_and_overlap_preserve_cached_source(self):
        """Bound explicit renewal and keep concurrent refresh ownership intact."""
        self.stream.outputs.return_value = {}
        self.camera._stream_source_refreshing = True
        await self.camera.async_create_stream()
        self.camera.coordinator.client.stream_url.assert_not_awaited()
        self.camera._stream_source_refreshing = False
        async def stalled(_serial):
            await asyncio.sleep(5)
        self.camera.coordinator.client.stream_url.side_effect = stalled
        await self.camera.async_create_stream()
        self.assertEqual(self.stream.source, "old")
        self.assertFalse(self.camera._stream_source_refreshing)

    async def test_default_off_arms_startup_without_changing_ha_timeouts(self) -> None:
        """Stop no-frame retries with HA's timer even without the optional setting."""
        self.camera._short_hls_idle = False
        self.assertIs(await self.camera.async_create_stream(), self.stream)
        self.original.assert_not_called()
        self.stream.add_provider("hls")
        self.original.assert_called_once_with("hls", timeout=None)
        self.original.return_value.idle_timer.start.assert_called_once_with()

    async def test_missing_stream_preserves_ha(self) -> None:
        """Do not create an output when HA cannot create its stream."""
        self.base.async_create_stream.return_value = None
        self.assertIsNone(await self.camera.async_create_stream())
        self.original.assert_not_called()

    async def test_only_requested_hls_default_changes(self) -> None:
        """Leave recordings and explicit timeouts with their original owner."""
        await self.camera.async_create_stream()
        self.original.assert_not_called()
        self.assertIs(self.stream.add_provider("hls"), self.original.return_value)
        self.original.assert_called_with("hls", timeout=60)
        self.original.return_value.idle_timer.start.assert_called_once_with()
        self.stream.add_provider("recorder", 240)
        self.original.assert_called_with("recorder", timeout=240)
        self.stream.add_provider("recorder")
        self.original.assert_called_with("recorder", timeout=None)
        self.stream.add_provider("hls", 120)
        self.original.assert_called_with("hls", timeout=120)
        self.original.return_value.idle_timer.start.assert_called_once_with()

    async def test_cached_and_replaced_streams_keep_one_wrapper(self) -> None:
        """Install once per stream, including a replacement from HA."""
        await self.camera.async_create_stream()
        wrapper = self.stream.add_provider
        await self.camera.async_create_stream()
        self.assertIs(self.stream.add_provider, wrapper)
        self.stream.add_provider("hls")
        self.original.assert_called_once_with("hls", timeout=60)
        replacement_factory = Mock()
        self.base.async_create_stream.return_value = SimpleNamespace(add_provider=replacement_factory)
        replacement = await self.camera.async_create_stream()
        replacement.add_provider("hls")
        replacement_factory.assert_called_once_with("hls", timeout=60)

    async def test_other_streams_and_failures_stay_with_ha(self) -> None:
        """Never globally replace the provider method or hide failures."""
        other = SimpleNamespace(add_provider=Mock())
        await self.camera.async_create_stream()
        other.add_provider("hls")
        other.add_provider.assert_called_once_with("hls")
        self.original.side_effect = RuntimeError("provider failed")
        with self.assertRaisesRegex(RuntimeError, "provider failed"):
            self.stream.add_provider("hls")

    async def test_no_frame_startup_expires_without_retry_access_extending_it(self) -> None:
        """Expire an unused no-frame output through HA's own cleanup callback."""
        clock = SimpleNamespace(now=0, deadline=None)
        stopped = Mock()

        class Timer:
            """Model HA's idempotent start and consumer-owned awake deadlines.

            The test owns the clock and fires the normal provider removal
            callback. No camera, real timer, or worker thread is started.
            """

            def start(self) -> None:
                """Arm once without extending the deadline on repeated access."""
                if clock.deadline is None:
                    clock.deadline = clock.now + 60

            def awake(self) -> None:
                """Allow actual viewer traffic to extend its output's lifetime."""
                clock.deadline = clock.now + 60

        provider = SimpleNamespace(idle_timer=Timer())
        outputs = {"hls": provider}
        self.original.return_value = provider
        self.camera._short_hls_idle = False
        await self.camera.async_create_stream()
        self.stream.add_provider("hls")
        self.assertEqual(clock.deadline, 60)
        clock.now = 40
        self.stream.add_provider("hls")
        self.assertEqual(clock.deadline, 60)

        # HA removes the expired provider and stops when no other output owns it.
        clock.now = 60
        if clock.deadline <= clock.now:
            outputs.pop("hls")
            if not outputs:
                stopped()
        stopped.assert_called_once_with()
        self.assertFalse(outputs)

    async def test_active_viewer_refreshes_deadline_without_affecting_other_outputs(self) -> None:
        """Keep an active HLS viewer alive while leaving explicit consumers alone."""
        deadline = {"value": None}
        now = {"value": 0}

        def start() -> None:
            """Represent HA's start-once contract for the selected output."""
            if deadline["value"] is None:
                deadline["value"] = now["value"] + 60

        timer = SimpleNamespace(start=Mock(side_effect=start))
        self.original.return_value = SimpleNamespace(idle_timer=timer)
        await self.camera.async_create_stream()
        self.stream.add_provider("recorder", 240)
        self.stream.add_provider("hls", 120)
        timer.start.assert_not_called()
        self.stream.add_provider("hls")
        self.assertEqual(deadline["value"], 60)
        now["value"] = 50

        # HA's consumer awake method replaces the deadline on viewer activity.
        deadline["value"] = now["value"] + 60
        self.stream.add_provider("hls")
        self.assertEqual(deadline["value"], 110)


if __name__ == "__main__":
    unittest.main()
