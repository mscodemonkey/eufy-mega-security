"""Check the per-camera Live audio switch without importing Home Assistant.

The switch is a Home Assistant choice, not a camera setting: it is restored or
off, it is offered only where the gateway delivers live audio, and a change
makes the camera's next view open on the matching route.
"""
from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


def load_class(filename: str, name: str, namespace: dict) -> type:
    """Execute one class from the shipped source against test-owned bases."""
    tree = ast.parse((ROOT / filename).read_text())
    node = next(item for item in tree.body if isinstance(item, ast.ClassDef) and item.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), filename, "exec"), namespace)
    return namespace[name]


def load_method(filename: str, class_name: str, name: str, namespace: dict):
    tree = ast.parse((ROOT / filename).read_text())
    owner = next(item for item in tree.body if isinstance(item, ast.ClassDef) and item.name == class_name)
    method = next(item for item in owner.body if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == name)
    exec(compile(ast.Module(body=[method], type_ignores=[]), filename, "exec"), namespace)
    return namespace[name]


class Entity:
    """Stand-in for EufyGatewayEntity: a camera record from the coordinator."""

    def __init__(self, coordinator, serial):
        self.coordinator, self.serial = coordinator, serial

    @property
    def camera(self):
        return self.coordinator.cameras.get(self.serial, {})

    async def async_added_to_hass(self):
        return None


class Switch:
    def __init__(self):
        self.written = 0

    def async_write_ha_state(self):
        self.written += 1


class Restore:
    last_state = None

    async def async_get_last_state(self):
        return self.last_state


class Coordinator:
    """The shipped live audio methods on a minimal coordinator."""

    def __init__(self, cameras):
        self.cameras = cameras
        self.live_audio: dict[str, bool] = {}
        self.live_audio_changed: dict = {}


Coordinator.async_set_live_audio = load_method("coordinator.py", "EufyGatewayCoordinator", "async_set_live_audio", {})


class LiveAudioSwitchTest(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        self.switch_class = load_class("switch.py", "EufyLiveAudioSwitch", {
            "EufyGatewayEntity": Entity, "SwitchEntity": Switch, "RestoreEntity": Restore, "EufyGatewayCoordinator": object})

    async def test_off_by_default_restored_when_known_and_written_to_no_camera(self):
        coordinator = Coordinator({"cam": {"liveAudioSupported": True, "streamSupported": True}})
        switch = self.switch_class(coordinator, "cam")
        self.assertEqual(switch._attr_unique_id, "cam_camera_live_audio")
        await switch.async_added_to_hass()
        self.assertIs(switch.is_on, False)
        restored = self.switch_class(coordinator, "cam")
        restored.last_state = SimpleNamespace(state="on")
        await restored.async_added_to_hass()
        self.assertIs(restored.is_on, True)
        await restored.async_turn_off()
        self.assertIs(coordinator.live_audio["cam"], False)
        self.assertEqual(restored.written, 1)
        self.assertTrue(restored.available)

    async def test_a_change_reaches_the_camera_once_and_a_repeat_does_not(self):
        coordinator = Coordinator({"cam": {}})
        changed = AsyncMock()
        coordinator.live_audio_changed["cam"] = changed
        await coordinator.async_set_live_audio("cam", False)
        changed.assert_not_awaited()
        await coordinator.async_set_live_audio("cam", True)
        await coordinator.async_set_live_audio("cam", True)
        self.assertEqual(changed.await_count, 1)
        await coordinator.async_set_live_audio("other", True)
        self.assertEqual(coordinator.live_audio, {"cam": True, "other": True})

    async def test_the_camera_drops_its_cached_stream_so_the_next_view_uses_the_new_route(self):
        changed = load_method("camera.py", "EufyGatewayCamera", "_async_live_audio_changed", {})
        stream = SimpleNamespace(stop=AsyncMock())
        camera = SimpleNamespace(stream=stream, _hls_idle_stream=stream)
        await changed(camera)
        stream.stop.assert_awaited_once()
        self.assertIsNone(camera.stream)
        self.assertIsNone(camera._hls_idle_stream)
        await changed(camera)
        stream.stop.assert_awaited_once()

    async def test_offered_once_only_where_live_audio_is_delivered(self):
        tree = ast.parse((ROOT / "switch.py").read_text())
        setup = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "async_setup_entry")
        added, listeners = [], []
        coordinator = SimpleNamespace(cameras={"audio": {"liveAudioSupported": True, "streamSupported": True},
                                               "silent": {"liveAudioSupported": False, "streamSupported": True},
                                               "unstreamed": {"liveAudioSupported": True, "streamSupported": False}},
                                      locks={}, async_add_listener=listeners.append)
        namespace = {"camera_preference_value": lambda *args: None, "EufyLiveAudioSwitch": lambda *args: ("live_audio", args[1])}
        exec(compile(ast.Module(body=[setup], type_ignores=[]), "switch.py", "exec"), namespace)
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator), async_on_unload=lambda callback: None)
        await namespace["async_setup_entry"](None, entry, added.extend)
        for listener in listeners:
            listener()
        self.assertEqual(added, [("live_audio", "audio")])


if __name__ == "__main__":
    unittest.main()
