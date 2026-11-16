"""Qualify HA opt-in defaults without loading Home Assistant or issuing commands.

Production entity constructors own defaults and stable IDs. Inert coordinator
and component bases supply only camera metadata for the registration boundary.
"""
from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


class CameraBase:
    """Bind synthetic camera metadata for one constructor's entity lifetime."""

    def __init__(self, coordinator, serial):
        """Retain the fixture coordinator without opening a device route."""
        self.coordinator, self.serial = coordinator, serial

    @property
    def camera(self):
        """Return only the current synthetic camera dictionary."""
        return self.coordinator.cameras[self.serial]


class ComponentBase:
    """Stand in for HA component initialization without registry side effects."""


def constructors():
    """Compile complete production classes against the inert entity boundaries."""
    root = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"
    namespace = {"EufyGatewayEntity": CameraBase, "SwitchEntity": ComponentBase,
                 "ButtonEntity": ComponentBase}
    wanted = {"EufyCameraEnabledSwitch", "EufyAudioRecordingSwitch", "EufyCameraAiTrackingButton"}
    for name in ("switch.py", "button.py"):
        tree = ast.parse((root / name).read_text())
        nodes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name in wanted]
        module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *nodes], type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), str(root / name), "exec"), namespace)
    return namespace


class ExperimentalControlDefaultsTest(unittest.TestCase):
    """Keep the new E30 trials optional while preserving ordinary control IDs."""

    def entities(self, camera):
        """Construct both switches and tracking actions without calling their setters."""
        classes = constructors()
        coordinator = SimpleNamespace(cameras={"fixture": camera})
        return [classes["EufyCameraEnabledSwitch"](coordinator, "fixture"),
                classes["EufyAudioRecordingSwitch"](coordinator, "fixture"),
                classes["EufyCameraAiTrackingButton"](coordinator, "fixture", True),
                classes["EufyCameraAiTrackingButton"](coordinator, "fixture", False)]

    def test_attached_e30_controls_start_disabled_and_labelled(self):
        """Require a separate registry opt-in for each newly admitted trial control."""
        entities = self.entities({"model": "T8171", "deviceType": 88, "stationSerial": "parent"})
        self.assertTrue(all(entity._attr_entity_registry_enabled_default is False for entity in entities))
        self.assertTrue(all(entity._attr_translation_key.endswith("_experimental") for entity in entities))
        self.assertEqual([entity._attr_unique_id for entity in entities],
                         ["fixture_camera_enabled", "fixture_camera_audio_recording",
                          "fixture_camera_ai_tracking_on", "fixture_camera_ai_tracking_off"])

    def test_ordinary_and_standalone_controls_keep_their_defaults(self):
        """Do not widen the presentation change to proven routes or nearby models."""
        for camera in ({"model": "T8171", "deviceType": 88, "stationSerial": "fixture"},
                       {"model": "T817L", "deviceType": 10031, "stationSerial": "fixture"},
                       {"model": "T8171", "deviceType": 89, "stationSerial": "parent"}):
            with self.subTest(camera=camera):
                entities = self.entities(camera)
                self.assertTrue(all(getattr(entity, "_attr_entity_registry_enabled_default", True) for entity in entities))
                self.assertTrue(all(not entity._attr_translation_key.endswith("_experimental") for entity in entities))


if __name__ == "__main__":
    unittest.main()
