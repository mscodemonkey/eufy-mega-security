"""Exercise per-stream native HLS tuning and startup cleanup without a camera.

Tests execute the camera hook against an owned provider factory. Home
Assistant owns viewer timers, checked separately against its actual source.
"""

from __future__ import annotations

import ast
import asyncio
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/camera.py"


class HlsIdleTest(unittest.IsolatedAsyncioTestCase):
    """Protect stream ownership while tuning new native HLS outputs and idle timers."""

    def setUp(self) -> None:
        """Load the real hook with a synthetic HA camera base."""
        tree = ast.parse(SOURCE.read_text())
        camera = next(n for n in tree.body if isinstance(n, ast.ClassDef)
                      and n.name == "EufyGatewayCamera")
        methods = {"async_create_stream", "_async_stream_url", "_async_plan_hls_handover", "_hls_handover_allowed"}
        base = type("CameraBase", (), {"async_create_stream": AsyncMock()})
        cls = ast.ClassDef(name="TestCamera", bases=[ast.Name(id="CameraBase", ctx=ast.Load())],
                           keywords=[], body=[n for n in camera.body if getattr(n, "name", None) in methods],
                           decorator_list=[])
        helpers = [n for n in tree.body if getattr(n, "name", None) in {"_with_view", "_view_of"}]
        module = ast.fix_missing_locations(ast.Module(body=[*helpers, cls], type_ignores=[]))
        namespace = {"HlsViewActivity": SimpleNamespace(install=Mock(return_value=None)), "CameraBase": base,
                     "Stream": object, "StreamOutput": object, "GatewayClientError": RuntimeError,
                     "_LOGGER": Mock(), "asyncio": asyncio, "STREAM_URL_RENEWAL_TIMEOUT": 0.02,
                     "PLANNED_HLS_PREPARATION_TIMEOUT": 0.2, "datetime": datetime, "LIVE_VIEW_QUERY": "view",
                     "parse_qsl": parse_qsl, "urlencode": urlencode, "urlsplit": urlsplit, "urlunsplit": urlunsplit,
                     "_new_view": lambda url: url, "_view_for": lambda _camera, url: url}
        exec(compile(module, str(SOURCE), "exec"), namespace)
        self.base = base
        self.camera = namespace["TestCamera"]()
        self.camera._short_hls_idle = True
        self.camera._native_video = False
        self.camera._fast_native_hls = False
        self.camera._hls_idle_stream = None
        self.camera._stream_source_refreshing = False
        self.camera.camera = {"stream": {"state": "streaming"}}
        self.original = Mock(return_value=SimpleNamespace(idle_timer=Mock()))
        self.stream = SimpleNamespace(add_provider=self.original, outputs=Mock(return_value={"hls": object()}),
                                      source="old", available=True, update_source=Mock(),
                                      dynamic_stream_settings=SimpleNamespace(preload_stream=False))
        self.camera.stream = self.stream
        self.camera.hass = object()
        self.camera.serial = "demo"
        self.camera.coordinator = SimpleNamespace(live_audio={}, client=SimpleNamespace(stream_url=AsyncMock(return_value="fresh")))
        base.async_create_stream.return_value = self.stream

    async def test_planned_handover_rechecks_recording_and_keeps_same_view(self):
        """Use a scoped replacement only while the original HLS viewer still owns the output."""
        source = "http://gateway/live.h264"
        self.stream.source = source + "?access_token=old&view=fixture"
        self.camera.coordinator.recording_holds = set()
        client = self.camera.coordinator.client
        client.planned_hls_handover_supported = True
        client.stream_url.return_value = source + "?access_token=fresh"
        provider = self.stream.outputs.return_value["hls"]
        self.camera._hls_activity = SimpleNamespace(output=provider, recently_watched=Mock(return_value=False))
        client.prepare_planned_hls = AsyncMock(return_value="ticket")
        await self.camera._async_plan_hls_handover(None)
        client.prepare_planned_hls.assert_not_called()

        self.camera._hls_activity.recently_watched.return_value = True
        await self.camera._async_plan_hls_handover(None)
        client.prepare_planned_hls.assert_awaited_once_with("demo", "fixture")
        self.stream.update_source.assert_called_once_with(source + "?access_token=fresh&view=fixture&handover=ticket")
        self.stream.update_source.reset_mock()

        async def request_while_recording(_serial, _view):
            """Start a recording while the replacement ticket is in flight."""
            self.camera.coordinator.recording_holds.add("recording")
            return "ticket"

        client.prepare_planned_hls.side_effect = request_while_recording
        await self.camera._async_plan_hls_handover(None)
        self.stream.update_source.assert_not_called()

    def test_stream_renewal_timeout_is_integration_owned(self) -> None:
        """Avoid importing a Home Assistant camera constant that moved in 2026.11."""
        tree = ast.parse(SOURCE.read_text())
        camera_imports = {
            alias.name
            for node in tree.body
            if isinstance(node, ast.ImportFrom)
            and node.module == "homeassistant.components.camera"
            for alias in node.names
        }
        assignments = {
            target.id
            for node in tree.body
            if isinstance(node, ast.Assign)
            for target in node.targets
            if isinstance(target, ast.Name)
        }
        self.assertNotIn("CAMERA_STREAM_SOURCE_TIMEOUT", camera_imports)
        self.assertIn("STREAM_URL_RENEWAL_TIMEOUT", assignments)

    @staticmethod
    def _settings(minimum=5.9, ll=True):
        """Model the public Core settings value while retaining ownership identity."""
        cls = type("StreamSettings", (), {"__module__": "homeassistant.components.stream.core"})
        settings = cls()
        settings.min_segment_duration = minimum
        settings.ll_hls = ll
        settings.part_target_duration = 1.0
        return settings

    async def test_fast_native_hls_changes_only_the_new_stream_copy(self):
        """An explicit opt-in shortens the first native HLS output without changing global settings."""
        global_settings, own_settings = self._settings(), self._settings()
        self.camera.hass = SimpleNamespace(data={"stream": {"settings": global_settings}})
        self.camera._native_video = self.camera._fast_native_hls = True
        self.camera.stream = None
        self.stream.outputs.return_value = {}
        self.original.return_value.stream_settings = own_settings
        await self.camera.async_create_stream()
        self.stream.add_provider("hls")
        self.assertEqual(own_settings.min_segment_duration, 1.9)
        self.assertEqual(own_settings.part_target_duration, 1.0)
        self.assertEqual(global_settings.min_segment_duration, 5.9)
        self.original.assert_called_once_with("hls", timeout=60)

    async def test_c31_ordinary_hls_starts_without_the_default_six_second_segments(self):
        """The C31's HLS fallback must stay responsive with either video preference."""
        for native in (False, True):
            for parent in (None, "", "demo"):
                with self.subTest(native=native, parent=parent):
                    global_settings, own_settings = self._settings(), self._settings()
                    self.camera.hass = SimpleNamespace(data={"stream": {"settings": global_settings}})
                    self.camera.camera = {"model": "T817L", "deviceType": 10031, "stationSerial": parent}
                    self.camera._native_video = native
                    self.camera._fast_native_hls = False
                    self.camera._hls_idle_stream = None
                    self.camera.stream = None
                    self.stream.add_provider = self.original
                    self.stream.outputs.return_value = {}
                    self.original.return_value.stream_settings = own_settings
                    await self.camera.async_create_stream()
                    self.stream.add_provider("hls")
                    self.assertEqual(own_settings.min_segment_duration, 1.9)
                    self.assertEqual(own_settings.part_target_duration, 1.0)
                    self.assertEqual(global_settings.min_segment_duration, 5.9)

    async def test_c31_hls_tuning_preserves_other_sources_and_existing_consumers(self):
        """Do not retune another route, running worker, recording or preload."""
        for scenario in ("foreign-model", "foreign-type", "attached", "cached", "recording-active", "preload", "recorder", "explicit-timeout", "global-shared", "unknown-class", "non-ll", "invalid-minimum", "missing-global"):
            with self.subTest(scenario=scenario):
                global_settings, own_settings = self._settings(), self._settings()
                self.camera.hass = SimpleNamespace(data={"stream": {"settings": global_settings}} if scenario != "missing-global" else {})
                self.camera.camera = {"model": "T8417" if scenario == "foreign-model" else "T817L",
                                      "deviceType": 10030 if scenario == "foreign-type" else 10031,
                                      "stationSerial": "homebase" if scenario == "attached" else "demo"}
                self.camera._hls_idle_stream = None
                self.camera.stream = self.stream if scenario == "cached" else None
                self.stream.add_provider = self.original
                self.stream.outputs.return_value = {"recorder": object()} if scenario == "recording-active" else {}
                self.stream.dynamic_stream_settings.preload_stream = scenario == "preload"
                if scenario == "global-shared":
                    own_settings = global_settings
                elif scenario == "unknown-class":
                    own_settings = SimpleNamespace(min_segment_duration=5.9, ll_hls=True)
                elif scenario == "non-ll":
                    own_settings.ll_hls = False
                elif scenario == "invalid-minimum":
                    own_settings.min_segment_duration = 20.0
                self.original.return_value.stream_settings = own_settings
                before = own_settings.min_segment_duration
                await self.camera.async_create_stream()
                self.stream.add_provider("recorder" if scenario == "recorder" else "hls", 120 if scenario == "explicit-timeout" else None)
                self.assertEqual(own_settings.min_segment_duration, before)

    async def test_fast_native_hls_preserves_existing_owners_and_unknown_contracts(self):
        """Keep compatible video, cached workers, recordings, preload and shared settings unchanged."""
        for scenario in ("disabled", "compatible", "cached", "recording-active", "preload", "recorder", "explicit-timeout", "global-shared", "unknown-class", "non-ll", "invalid-minimum", "missing-global"):
            with self.subTest(scenario=scenario):
                global_settings, own_settings = self._settings(), self._settings()
                self.camera.hass = SimpleNamespace(data={"stream": {"settings": global_settings}} if scenario != "missing-global" else {})
                self.camera._native_video = scenario != "compatible"
                self.camera._fast_native_hls = scenario != "disabled"
                self.camera._hls_idle_stream = None
                self.camera.stream = self.stream if scenario == "cached" else None
                self.stream.add_provider = self.original
                self.stream.outputs.return_value = {"recorder": object()} if scenario == "recording-active" else {}
                self.stream.dynamic_stream_settings.preload_stream = scenario == "preload"
                if scenario == "global-shared":
                    own_settings = global_settings
                elif scenario == "unknown-class":
                    own_settings = SimpleNamespace(min_segment_duration=5.9, ll_hls=True)
                elif scenario == "non-ll":
                    own_settings.ll_hls = False
                elif scenario == "invalid-minimum":
                    own_settings.min_segment_duration = 20.0
                self.original.return_value.stream_settings = own_settings
                before = own_settings.min_segment_duration
                await self.camera.async_create_stream()
                self.stream.add_provider("recorder" if scenario == "recorder" else "hls", 120 if scenario == "explicit-timeout" else None)
                self.assertEqual(own_settings.min_segment_duration, before)
                self.assertEqual(global_settings.min_segment_duration, 5.9)

    async def test_reopen_idle_cached_stream_refreshes_before_return(self):
        """A returning viewer gets fresh credentials after idle renewal was skipped."""
        self.stream.outputs.return_value = {}
        self.assertIs(await self.camera.async_create_stream(), self.stream)
        self.assertEqual(self.stream.source, "fresh")
        self.camera.coordinator.client.stream_url.assert_awaited_once_with("demo", audio=False)

    async def test_reopen_failure_keeps_previous_source(self):
        """A gateway failure does not erase the cached stream or start a worker."""
        self.stream.outputs.return_value = {}
        self.camera.coordinator.client.stream_url.side_effect = RuntimeError("offline")
        self.assertIs(await self.camera.async_create_stream(), self.stream)
        self.assertEqual(self.stream.source, "old")

    async def test_reopen_reply_after_replacement_is_discarded(self):
        """A late explicit reopen cannot mutate a stream removed during its request."""
        self.stream.outputs.return_value = {}
        async def reply(_serial, **_options):
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
        async def stalled(_serial, **_options):
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
        self.base.async_create_stream.return_value = SimpleNamespace(source="replacement", dynamic_stream_settings=SimpleNamespace(preload_stream=False), add_provider=replacement_factory)
        replacement = await self.camera.async_create_stream()
        replacement.add_provider("hls")
        replacement_factory.assert_called_once_with("hls", timeout=60)

    async def test_other_streams_and_failures_stay_with_ha(self) -> None:
        """Never globally replace the provider method or hide failures."""
        other = SimpleNamespace(dynamic_stream_settings=SimpleNamespace(preload_stream=False), add_provider=Mock())
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

    async def test_homebase_reconnect_keeps_existing_playlist(self) -> None:
        """A transient upstream state must not retire an active HA HLS output."""
        for model in ("T8600", "T8223"):
            for state in ("idle", "stopping", "error"):
                with self.subTest(model=model, state=state):
                    self.camera.camera = {"model": model, "stream": {"state": state}}
                    self.stream.stop = AsyncMock()
                    original_output = self.stream.outputs()["hls"]
                    result = await self.camera.async_create_stream()
                    self.assertIs(result, self.stream)
                    self.assertIs(result.outputs()["hls"], original_output)
                    self.stream.stop.assert_not_awaited()
                    self.stream.update_source.assert_not_called()

    async def test_explicit_nvr_handoff_still_retires_the_old_stream(self) -> None:
        """Only a declared shared NVR route can lose its cached call this way."""
        self.camera.camera = {"hlsIdleHandoverSupported": True, "stream": {"state": "idle"}}
        self.stream.stop = AsyncMock()
        await self.camera.async_create_stream()
        self.stream.stop.assert_awaited_once()

    async def test_nvr_preload_recording_and_native_panes_keep_their_owner(self) -> None:
        """An NVR handoff declaration cannot override another media owner."""
        for owner in ("preload", "recorder", "pane"):
            with self.subTest(owner=owner):
                self.camera.camera = {"hlsIdleHandoverSupported": True, "stream": {"state": "idle"}}
                self.camera.stream = self.stream
                self.stream.stop = AsyncMock()
                self.stream.dynamic_stream_settings.preload_stream = owner == "preload"
                self.stream.outputs.return_value = {"hls": object(), **({"recorder": object()} if owner == "recorder" else {})}
                self.camera._own_nvr_call = owner == "pane"
                await self.camera.async_create_stream()
                self.stream.stop.assert_not_awaited()

    async def test_unavailable_homebase_worker_renews_without_restarting_output(self) -> None:
        """A second viewer during retry keeps the existing worker and view token."""
        self.camera.camera = {"model": "T8600", "stream": {"state": "idle"}}
        self.stream.available = False
        self.stream.stop = AsyncMock()
        output = self.stream.outputs()["hls"]
        self.assertIs(await self.camera.async_create_stream(), self.stream)
        self.assertIs(self.stream.outputs()["hls"], output)
        self.assertEqual(self.stream.source, "fresh")
        self.stream.stop.assert_not_awaited()
        self.stream.update_source.assert_not_called()


if __name__ == "__main__":
    unittest.main()
