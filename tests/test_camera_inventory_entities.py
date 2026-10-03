"""Test inventory-only HA entities against synthetic coordinator dictionaries.

The integration owns entity creation and allowlisted attributes. Actual shipped
callbacks are compiled without HA imports so late discovery and optional
settings can be verified without vendor connections or live control writes.
"""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


def load_function(filename: str, name: str, namespace: dict, class_name: str | None = None):
    """Compile the actual callback, retaining postponed optional annotations."""
    source = ROOT / filename
    tree = ast.parse(source.read_text())
    nodes = tree.body
    if class_name:
        nodes = next(node.body for node in nodes if isinstance(node, ast.ClassDef) and node.name == class_name)
    function = next(node for node in nodes if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name)
    function.decorator_list = []
    exec(compile(ast.Module(body=[tree.body[1], function], type_ignores=[]), str(source), "exec"), namespace)
    return namespace[name]


class CameraInventoryEntitiesTest(unittest.IsolatedAsyncioTestCase):
    """Protect late telemetry and read-only, privacy-safe settings presentation."""

    async def test_signal_entity_can_arrive_after_initial_discovery(self) -> None:
        """Create the diagnostic once when its own reading first appears."""
        listeners, added = [], []
        coordinator = SimpleNamespace(cameras={"camera": {}}, stations={}, sensors={})
        coordinator.async_add_listener = lambda callback: listeners.append(callback)
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator), async_on_unload=lambda value: None)
        namespace = {
            "DOMAIN": "eufy_event_gateway",
            "er": SimpleNamespace(async_get=lambda hass: None),
            "_migrate_storage_display_units": lambda *args: None,
            "EufyRecognizedPersonSensor": lambda *args: ("person", args[1]),
            "EufyCameraSignalStrength": lambda *args: ("rssi", args[1]),
        }
        setup = load_function("sensor.py", "async_setup_entry", namespace)
        await setup(None, entry, added.extend)
        self.assertNotIn(("rssi", "camera"), added)
        coordinator.cameras["camera"]["rssi"] = -61
        listeners[0]()
        listeners[0]()
        self.assertEqual(added.count(("rssi", "camera")), 1)

    async def test_audio_attributes_are_allowlisted_and_keep_false_values(self) -> None:
        """Do not publish raw settings or infer missing values as disabled."""
        getter = load_function("camera.py", "extra_state_attributes", {}, "EufyGatewayCamera")
        state = {"audioSettings": {"microphoneEnabled": False, "speakerEnabled": None, "speakerVolume": 60, "raw": "private"}}
        self.assertEqual(getter(SimpleNamespace(camera=state)), {
            "reported_microphone_enabled": False, "reported_speaker_volume": 60,
        })
        self.assertEqual(getter(SimpleNamespace(camera={})), {})

    async def test_reported_settings_are_read_only_and_strictly_boolean(self) -> None:
        """Retain false settings without leaking raw inventory or unknown values."""
        getter = load_function("camera.py", "extra_state_attributes", {}, "EufyGatewayCamera")
        state = {"reportedSettings": {"imageFlipped": False, "statusLedEnabled": True,
                                      "soundDetectionEnabled": "unknown", "raw": "private"}}
        self.assertEqual(getter(SimpleNamespace(camera=state)), {
            "reported_image_flipped": False, "reported_status_indicator_enabled": True,
        })

    async def test_doorbell_attributes_keep_false_and_reject_unknown_values(self) -> None:
        """Expose only validated settings, never raw notification configuration."""
        getter = load_function("camera.py", "extra_state_attributes", {}, "EufyGatewayCamera")
        state = {"reportedSettings": {
            "homebaseChimeEnabled": False, "mechanicalChimeEnabled": True,
            "wideDynamicRangeEnabled": "1", "highCompressionEncoding": False,
            "chimeVolume": 25, "doorbellVideoQuality": 0, "raw": "private",
        }}
        self.assertEqual(getter(SimpleNamespace(camera=state)), {
            "reported_homebase_chime_enabled": False, "reported_mechanical_chime_enabled": True,
            "reported_high_compression_encoding": False, "reported_chime_volume": 25,
            "reported_doorbell_video_quality": 0,
        })
        for invalid in (True, "3", -1, 101, None, 2.5):
            state = {"reportedSettings": {"chimeVolume": invalid, "doorbellVideoQuality": invalid}}
            self.assertEqual(getter(SimpleNamespace(camera=state)), {})
