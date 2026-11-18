"""Exercise the shipped multi-view entity and client method against synthetic HA boundaries.

Trusted integration AST is loaded without a Home Assistant installation. These
fixtures own discovery, stream URLs and renewals, never a gateway or an NVR.
"""
from __future__ import annotations

import ast
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


class GatewayError(Exception):
    """Represent the client's fixed failure boundary for isolated method tests."""


class StationEntity:
    """Own only the coordinator binding the real station base entity provides."""

    def __init__(self, coordinator, serial):
        self.coordinator, self.serial = coordinator, serial

    @property
    def station(self):
        """Read the same station row as the real base entity."""
        return self.coordinator.stations.get(self.serial, {})

    @property
    def available(self):
        """Stand in for the base rule: present in current inventory."""
        return bool(self.station)


class Camera:
    """Own the stream options and stream the real Camera base provides."""

    def __init__(self):
        self.stream_options = {}
        self.stream = None


def namespace():
    """Compile the real multi-view class and the platform's discovery."""
    tree = ast.parse((ROOT / "camera.py").read_text())
    names = {"EufyGatewayMultiViewCamera", "async_setup_entry", "_live_talkback_camera", "_shared_lens_profile"}
    def features(value=0):
        """Stand in for HA's flag type: no features is 0, streaming is 2."""
        return value
    features.STREAM = 2
    env = {"EufyStationEntity": StationEntity, "Camera": Camera, "CameraEntityFeature": features,
           "GatewayClientError": GatewayError, "HomeAssistantError": GatewayError, "CONF_USE_WALLCLOCK_AS_TIMESTAMPS": "wallclock",
           "Path": Path, "_LOGGER": SimpleNamespace(debug=lambda *args: None)}
    exec(compile(ast.Module(body=[n for n in tree.body if getattr(n, "name", None) in names], type_ignores=[]),
                 str(ROOT / "camera.py"), "exec"), env)
    return env


class MultiViewCameraTests(unittest.IsolatedAsyncioTestCase):
    """One optional native multi-view per NVR, unavailable when nothing can convert it."""

    def coordinator(self, supported=True):
        client = SimpleNamespace(multiview_stream_url=AsyncMock(return_value="signed-grid"))
        return SimpleNamespace(stations={"nvr": {"model": "T8N00", "nvrMultiViewSupported": supported}},
                               cameras={}, last_update_success=True, client=client)

    async def test_entity_is_optional_native_and_follows_the_gateway_admission(self):
        """The NVR's device gets a disabled-by-default camera that streams only the signed multi-view."""
        env = namespace()
        coordinator = self.coordinator()
        entity = env["EufyGatewayMultiViewCamera"](coordinator, "nvr")
        self.assertEqual(entity._attr_unique_id, "nvr_multiview_camera")
        self.assertEqual(entity._attr_translation_key, "multiview")
        self.assertFalse(entity._attr_entity_registry_enabled_default)
        self.assertEqual(entity.stream_options, {"wallclock": True}, "raw video is timed on arrival")
        self.assertTrue(entity.available)
        self.assertEqual(entity.supported_features, 2)
        self.assertEqual(await entity.stream_source(), "signed-grid")
        coordinator.client.multiview_stream_url.assert_awaited_once_with("nvr")
        self.assertIsNone(await entity._async_get_supported_webrtc_provider(None), "HLS keeps renewing the expiring URL")
        coordinator.stations["nvr"]["nvrMultiViewSupported"] = False
        self.assertFalse(entity.available)
        self.assertEqual(entity.supported_features, 0)
        self.assertIsNone(await entity.stream_source())
        coordinator.stations["nvr"]["nvrMultiViewSupported"] = True
        coordinator.last_update_success = False
        self.assertFalse(entity.available)
        coordinator.client.multiview_stream_url.assert_awaited_once()

    async def test_compatibility_makes_the_multi_view_unavailable_without_asking_for_a_stream(self):
        """Nothing converts the 3840x2160 picture, so with H.264 compatibility on it never opens."""
        env = namespace()
        coordinator = self.coordinator()
        entity = env["EufyGatewayMultiViewCamera"](coordinator, "nvr", h264_compatibility=True)
        self.assertFalse(entity.available)
        self.assertEqual(entity.supported_features, 0)
        self.assertIsNone(await entity.stream_source())
        coordinator.client.multiview_stream_url.assert_not_awaited()

    async def test_renewal_stores_a_fresh_url_only_while_the_stream_is_watched(self):
        """A running view keeps its worker; the next reconnect uses the new signature."""
        env = namespace()
        coordinator = self.coordinator()
        entity = env["EufyGatewayMultiViewCamera"](coordinator, "nvr")
        entity.hass = object()
        outputs = {}
        entity.stream = SimpleNamespace(source="old", outputs=lambda: outputs,
                                        dynamic_stream_settings=SimpleNamespace(preload_stream=False))
        await entity._async_refresh_stream_source(None)
        self.assertEqual(entity.stream.source, "old")
        coordinator.client.multiview_stream_url.assert_not_awaited()
        outputs["hls"] = object()
        await entity._async_refresh_stream_source(None)
        self.assertEqual(entity.stream.source, "signed-grid")
        coordinator.client.multiview_stream_url.side_effect = GatewayError("offline")
        entity.stream.source = "kept"
        await entity._async_refresh_stream_source(None)
        self.assertEqual(entity.stream.source, "kept")

    async def test_name_is_translated(self):
        """The entity takes its name from the translation key, beside the NVR's device name."""
        for locale, name in (("en", "Multi-view"), ("da", "Multivisning")):
            names = json.loads((ROOT / f"translations/{locale}.json").read_text())["entity"]["camera"]
            self.assertEqual(names["multiview"]["name"], name)

    async def test_discovery_adds_one_multi_view_per_nvr_that_reports_it(self):
        """A station whose gateway reports the field gets one entity; others get none."""
        env = namespace()
        listeners, added = [], []
        coordinator = SimpleNamespace(cameras={}, stations={"hub": {"model": "T8030"}},
                                      async_add_listener=lambda fn: listeners.append(fn))
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator), options={"compat": True},
                                async_on_unload=lambda fn: None)

        class Schema:
            """Ignore registration schemas, outside the discovery boundary being tested."""
            def __getattr__(self, name): return lambda *args, **kwargs: name
        env.update(er=SimpleNamespace(async_get=lambda hass: SimpleNamespace(async_get_entity_id=lambda *args: None)),
                   DOMAIN="fixture", CONF_SHORT_HLS_IDLE="short", CONF_FAST_NATIVE_HLS="fast", CONF_H264_COMPATIBILITY="compat",
                   async_get_current_platform=lambda: SimpleNamespace(async_register_entity_service=lambda *args, **kwargs: None),
                   vol=Schema(), cv=Schema(), CONF_FILENAME="filename", CONF_DURATION="duration",
                   SupportsResponse=SimpleNamespace(ONLY="only"))
        await env["async_setup_entry"](None, entry, added.extend)
        self.assertEqual(added, [], "a HomeBase reports no multi-view")
        coordinator.stations["nvr"] = {"model": "T8N00", "nvrMultiViewSupported": False}
        listeners[0](); listeners[0]()
        self.assertEqual([entity.serial for entity in added], ["nvr"], "added once, while not yet admitted, so it can show unavailable")
        self.assertTrue(added[0]._h264_compatibility)


class MultiViewClientTests(unittest.IsolatedAsyncioTestCase):
    """The client asks for the NVR's native multi-view and accepts nothing else."""

    async def test_client_requires_the_exact_native_multi_view_without_retry(self):
        tree = ast.parse((ROOT / "client.py").read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "GatewayClient")
        method = next(n for n in cls.body if getattr(n, "name", None) == "multiview_stream_url")
        env = {"GatewayClientError": GatewayError, "urlsplit": urlsplit, "quote": quote}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(ROOT / "client.py"), "exec"), env)
        good = {"profile": "native", "view": "multiview", "path": "/api/stations/nvr/live-multiview-native.annexb?access_token=native.1.x"}
        request = AsyncMock(return_value=good)
        client = SimpleNamespace(_json=request, _url=lambda path: "http://gateway" + path)
        self.assertEqual(await env[method.name](client, "nvr"), "http://gateway" + good["path"])
        self.assertEqual(request.call_args.args[0], "/api/stations/nvr/stream-token")
        self.assertEqual(request.call_args.kwargs["payload"], {"profile": "native", "audio": "off"})
        for value in ({**good, "profile": "compatible"}, {**good, "view": None}, {key: good[key] for key in ("profile", "path")},
                      {**good, "path": "/api/stations/other/live-multiview-native.annexb"},
                      {**good, "path": "/api/cameras/nvr/live-native.annexb"},
                      {**good, "path": "//private.invalid/api/stations/nvr/live-multiview-native.annexb"}, None):
            request.reset_mock(); request.return_value = value
            with self.assertRaises(GatewayError):
                await env[method.name](client, "nvr")
            self.assertEqual(request.await_count, 1)
        request.reset_mock(); request.side_effect = GatewayError("The multi-view is unavailable")
        with self.assertRaises(GatewayError):
            await env[method.name](client, "nvr")
        self.assertEqual(request.await_count, 1)


if __name__ == "__main__":
    unittest.main()
