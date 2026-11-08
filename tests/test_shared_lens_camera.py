"""Exercise shipped pane entity/client methods against synthetic HA boundaries.

Trusted integration AST is loaded without a Home Assistant installation. These
fixtures own discovery, stream URLs and cache reads, never a gateway or camera.
"""
from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


class GatewayError(Exception):
    """Represent the client's fixed failure boundary for isolated method tests."""


class BaseCamera:
    """Own only coordinator binding for methods implemented by the real subclass."""

    def __init__(self, coordinator, serial, **kwargs):
        self.coordinator, self.serial = coordinator, serial
        self.options = kwargs

    @property
    def camera(self):
        """Read the same physical inventory row as the real base entity."""
        return self.coordinator.cameras.get(self.serial, {})


def namespace():
    """Compile the real pane class, selectors and URL marking rules."""
    tree = ast.parse((ROOT / "camera.py").read_text())
    names = {"_shared_lens_profile", "_view_for", "_with_view", "EufyGatewaySharedLensCamera"}
    env = {"EufyGatewayCamera": BaseCamera, "CameraEntityFeature": lambda value: value,
           "GatewayClientError": GatewayError, "HomeAssistantError": GatewayError,
           "urlsplit": urlsplit, "urlunsplit": urlunsplit, "parse_qsl": parse_qsl, "urlencode": urlencode,
           "LIVE_VIEW_QUERY": "view", "_new_view": lambda url: url + "&view=new"}
    env["CameraEntityFeature"] = SimpleNamespace(STREAM=2)
    exec(compile(ast.Module(body=[n for n in tree.body if getattr(n, "name", None) in names], type_ignores=[]),
                 str(ROOT / "camera.py"), "exec"), env)
    return env


class SharedLensCameraTests(unittest.IsolatedAsyncioTestCase):
    """Keep one physical identity with distinct pane routes and no wrong-media fallback."""

    async def test_entities_use_separate_ids_caches_and_video_only_urls(self):
        """Renewals always select the same pane regardless of the normal audio choice."""
        env = namespace()
        row = {"model": "T8E00", "nvrLiveControlsSupported": True,
               "nvrViewOptions": ["Fixed", "Movable", "Both"], "nvrSelectedView": 2}
        client = SimpleNamespace(shared_lens_stream_url=AsyncMock(return_value="signed-pane"),
                                 shared_lens_snapshot=AsyncMock(return_value=b"pane"))
        async def image(serial, kind, fetch):
            return await fetch()
        cache = SimpleNamespace(async_image=AsyncMock(side_effect=image))
        coordinator = SimpleNamespace(cameras={"test": row}, last_update_success=True, client=client,
                                      image_cache=cache, live_audio={"test": True})
        cls = env["EufyGatewaySharedLensCamera"]
        for lens in ("fixed", "movable"):
            entity = cls(coordinator, "test", lens)
            self.assertEqual(entity.serial, "test")
            self.assertEqual(entity._attr_unique_id, f"test_shared_{lens}_camera")
            self.assertEqual(entity._attr_translation_key, f"shared_{lens}")
            self.assertFalse(entity._attr_entity_registry_enabled_default)
            self.assertFalse(entity._track_live_audio)
            self.assertTrue(entity.available)
            self.assertEqual(await entity._async_stream_url(), "signed-pane")
            self.assertEqual(await entity.async_camera_image(), b"pane")
            client.shared_lens_stream_url.assert_awaited_with("test", lens)
            self.assertEqual(cache.async_image.call_args.args[:2], ("test", f"snapshot-{lens}"))
            with self.assertRaisesRegex(GatewayError, "camera.record"):
                await entity.async_record_clip("ignored", 15)
            row["nvrSelectedView"] = 1
            self.assertFalse(entity.available)
            before = client.shared_lens_stream_url.await_count
            with self.assertRaises(GatewayError):
                await entity._async_stream_url()
            self.assertEqual(client.shared_lens_stream_url.await_count, before)
            row["nvrSelectedView"] = 2
        coordinator.last_update_success = False
        self.assertFalse(entity.available)
        with self.assertRaises(ValueError):
            cls(coordinator, "test", "other")

    async def test_pane_urls_never_take_or_yield_the_nvr_call(self):
        """A recorder sharing either pane retains the unmarked physical source."""
        env = namespace()
        camera = SimpleNamespace(coordinator=SimpleNamespace(client=SimpleNamespace(live_view_handover_supported=True), recording_holds=set()))
        for lens in ("fixed", "movable"):
            url = f"http://gateway/api/cameras/test/live-{lens}.h264?access_token=token&view=old"
            self.assertEqual(dict(parse_qsl(urlsplit(env["_view_for"](camera, url)).query)), {"access_token": "token"})
        self.assertIn("view=new", env["_view_for"](camera, "http://gateway/live.h264?access_token=token"))

    async def test_panes_do_not_replace_or_remove_the_normal_audio_callback(self):
        """Run the real added lifecycle for both subclasses on one physical serial."""
        tree = ast.parse((ROOT / "camera.py").read_text())
        base = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "EufyGatewayCamera")
        method = next(n for n in base.body if getattr(n, "name", None) == "async_added_to_hass")
        thin = ast.ClassDef(name="Lifecycle", bases=[ast.Name(id="Parent", ctx=ast.Load())], keywords=[],
                            body=[method], decorator_list=[])
        class Parent:
            async def async_added_to_hass(self):
                """Stand in for HA's coordinator lifecycle only."""
        env = {"Parent": Parent, "async_track_time_interval": lambda *args: (lambda: None), "STREAM_SOURCE_REFRESH_INTERVAL": 300}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[thin], type_ignores=[])), str(ROOT / "camera.py"), "exec"), env)
        coordinator = SimpleNamespace(live_audio_changed={})
        callbacks = []
        normal = env["Lifecycle"]()
        for entity, tracks in [(normal, True), (env["Lifecycle"](), False), (env["Lifecycle"](), False)]:
            entity.coordinator, entity.serial, entity.hass = coordinator, "test", None
            entity._track_live_audio = tracks
            entity._async_live_audio_changed = AsyncMock()
            entity._async_refresh_stream_source = AsyncMock()
            entity.async_on_remove = callbacks.append
            await entity.async_added_to_hass()
        self.assertIs(coordinator.live_audio_changed["test"], normal._async_live_audio_changed)
        for callback in callbacks[2:]:
            callback()
        self.assertIs(coordinator.live_audio_changed["test"], normal._async_live_audio_changed)

    async def test_late_discovery_adds_each_pane_once_on_the_existing_device(self):
        """Load the actual platform setup and exercise its coordinator listener."""
        env = namespace()
        tree = ast.parse((ROOT / "camera.py").read_text())
        setup = next(n for n in tree.body if getattr(n, "name", None) == "async_setup_entry")
        listeners, added = [], []
        coordinator = SimpleNamespace(cameras={"test": {"model": "T8E00"}},
                                      async_add_listener=lambda fn: listeners.append(fn))
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator), options={}, async_on_unload=lambda fn: None)
        class Schema:
            """Ignore registration schemas, outside the discovery boundary being tested."""
            def __getattr__(self, name): return lambda *args, **kwargs: name
        env.update(er=SimpleNamespace(async_get=lambda hass: SimpleNamespace(async_get_entity_id=lambda *args: None)),
                   DOMAIN="fixture", CONF_SHORT_HLS_IDLE="short", CONF_FAST_NATIVE_HLS="fast", CONF_H264_COMPATIBILITY="compat",
                   async_get_current_platform=lambda: SimpleNamespace(async_register_entity_service=lambda *args, **kwargs: None),
                   vol=Schema(), cv=Schema(), CONF_FILENAME="filename", CONF_DURATION="duration", SupportsResponse=SimpleNamespace(ONLY="only"))
        exec(compile(ast.Module(body=[setup], type_ignores=[]), str(ROOT / "camera.py"), "exec"), env)
        await env["async_setup_entry"](None, entry, added.extend)
        self.assertEqual(len(added), 1)
        coordinator.cameras["test"].update(nvrLiveControlsSupported=True, nvrViewOptions=["Fixed", "Movable", "Both"])
        listeners[0](); listeners[0]()
        self.assertEqual(len(added), 3)
        self.assertEqual({e.serial for e in added}, {"test"})
        self.assertEqual({e.lens for e in added if hasattr(e, "lens")}, {"fixed", "movable"})

    async def test_client_requires_the_exact_pane_without_retry(self):
        """An older gateway, ignored lens or other-camera response stays unavailable."""
        tree = ast.parse((ROOT / "client.py").read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "GatewayClient")
        method = next(n for n in cls.body if getattr(n, "name", None) == "shared_lens_stream_url")
        env = {"GatewayClientError": GatewayError, "urlsplit": urlsplit, "quote": __import__("urllib.parse", fromlist=["quote"]).quote}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(ROOT / "client.py"), "exec"), env)
        request = AsyncMock(return_value={"lens": "fixed", "path": "/api/cameras/test/live-fixed.h264?access_token=secret"})
        client = SimpleNamespace(_json=request, _url=lambda path: "http://gateway" + path)
        self.assertEqual(await env[method.name](client, "test", "fixed"), "http://gateway/api/cameras/test/live-fixed.h264?access_token=secret")
        self.assertEqual(request.call_args.kwargs["payload"], {"profile": "compatible", "audio": "off", "lens": "fixed"})
        for value in ({"path": "/api/cameras/test/live.h264"}, {"lens": "fixed", "path": "/api/cameras/other/live-fixed.h264"},
                      {"lens": "fixed", "path": "//private.invalid/api/cameras/test/live-fixed.h264"}):
            request.reset_mock(); request.return_value = value
            with self.assertRaises(GatewayError):
                await env[method.name](client, "test", "fixed")
            self.assertEqual(request.await_count, 1)
        request.reset_mock(); request.side_effect = GatewayError("old gateway")
        with self.assertRaises(GatewayError):
            await env[method.name](client, "test", "fixed")
        self.assertEqual(request.await_count, 1)
